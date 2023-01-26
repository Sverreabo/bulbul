const functions = require("firebase-functions");
const fetch = require("node-fetch");
const { randomUUID, timingSafeEqual } = require("crypto");
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldPath } = require('firebase-admin/firestore');

initializeApp();
const firestore = getFirestore();

let access_token;

const TEST_URL = "https://apitest.vipps.no";
const TEST_MERCHANT_ID = "234390";

const TOKEN_EXPIRY_EXTRA = 30; //Seconds
const PENDING_PURCHASES_EXPIRY_TOT_MS = 900000; //15min * 60s * 1000ms == 900000ms

const BASE_URL_SELF = "https://c1d8-193-156-161-155.ngrok.io";

const ITEMS = {
    "mehlum": {
        "price": 4900, //Øre
        "shipping_cost": 50, //Kr
        "text": "Tre krimfortellinger om Svend Foyn",
    },
};

let prod = true;
if (process.env.FUNCTIONS_EMULATOR) {
    prod = false;
}

functions.logger.log("Production:", prod);

const api_url = TEST_URL;
const client_id = process.env.TEST_CLIENT_ID;
const client_secret = process.env.TEST_CLIENT_SECRET;
const ocp_key = process.env.TEST_OCP_KEY;
const merchant_id = TEST_MERCHANT_ID;


function get_time() {
    return Math.floor(Date.now() / 1000);
}

async function get_access_token(api_url, client_id, client_secret, ocp_key, merchant_id) {
    let time = get_time();
    if (access_token !== undefined && access_token["expires_on"] - time > TOKEN_EXPIRY_EXTRA) {
        functions.logger.info("token cached");
        return access_token;
    }

    let access_tokens_db = firestore.collection("access_tokens");
    let new_access_token;
    let to_delete_ids = [];
    await access_tokens_db.get().then(collection => {
        collection.forEach(document => {
            let temp_token = document.data();
            if (temp_token["expires_on"] - time > TOKEN_EXPIRY_EXTRA) {
                new_access_token = temp_token;
            } else {
                to_delete_ids.push(document.id);
            }
        });
    });
    for (id of to_delete_ids) {
        await access_tokens_db.doc(id).delete();
    }
    if (new_access_token !== undefined) {
        functions.logger.info("token from Firestore");
        return new_access_token;
    }

    const headers = {
        "client_id": client_id,
        "client_secret": client_secret,
        "Ocp-Apim-Subscription-Key": ocp_key,
        "Merchant-Serial-Number": merchant_id,
    };
    let response_json = await fetch(api_url + "/accessToken/get", { "method": "POST", "headers": headers })
        .then(res => { return res.json(); });
    await access_tokens_db.add(response_json);
    functions.logger.log(response_json, { structuredData: true });
    return response_json;
}

async function complete_order(item, api_url, ocp_key, access_token, merchant_id) {
    const order_id = "BULBUL-" + Date.now().toString(36);
    const authToken = randomUUID();
    const headers = {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": ocp_key,
        "Authorization": access_token["token_type"] + " " + access_token["access_token"],
        "Merchant-Serial-Number": merchant_id,
    };
    const body = {
        "customerInfo": {
        },
        "merchantInfo": {
            "authToken": authToken,
            "callbackPrefix": BASE_URL_SELF + "/functions/purchase-callback",
            "consentRemovalPrefix": BASE_URL_SELF + "/functions/purchase-callback",
            "fallBack": BASE_URL_SELF + "/fallback",
            "merchantSerialNumber": merchant_id,
            "paymentType": "eComm Express Payment",
            "staticShippingDetails": [
                {
                    "isDefault": "Y",
                    "shippingCost": 0,
                    "shippingMethod": "Levering i Tønsberg",
                    "shippingMethodId": "levering-tonsberg",
                },
                {
                    "isDefault": "N",
                    "shippingCost": item["shipping_cost"],
                    "shippingMethod": "Sending i posten",
                    "shippingMethodId": "sending-posten",
                },
            ],
        },
        "transaction": {
            "amount": item["price"],
            "orderId": order_id,
            "transactionText": item["text"],
            "useExplicitCheckoutFlow": true,
        },
    };
    let response = await fetch(api_url + "/ecomm/v2/payments/",
        { "method": "POST", "headers": headers, "body": JSON.stringify(body) })
        .then(res => { return res.json(); });
    if (!("orderId" in response)) {
        throw TypeError;
    }
    let pending_purchases_db = await firestore.collection("pending_purchases");
    await pending_purchases_db.doc(response["orderId"]).set({
        "authToken": authToken,
        "time": Date.now(),
        "transactionText": item["text"],
    });

    return response;
}

exports.init_purchase = functions
    .region("europe-west2")
    .runWith({ secrets: ["TEST_CLIENT_ID", "TEST_CLIENT_SECRET", "TEST_OCP_KEY"] })
    .https.onCall(async (data, context) => {
        if (data === null) {
            return;
        }

        if (!(data["item"] in ITEMS)) {
            return { error: "No such item for sale" };
        }
        const item = ITEMS[data["item"]];

        access_token = await get_access_token(api_url, client_id, client_secret, ocp_key, merchant_id);
        order = await complete_order(item, api_url, ocp_key, access_token, merchant_id);
        return { text: order["url"] };
    });

function matches_url(url, to_match) {
    return url.substring(0, to_match.length) === to_match;
}

function compare(a, b) {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

exports.purchase_callback = functions
    .region("europe-west2")
    .https.onRequest(async (request, response) => {
        const delete_url = "/functions/purchase-callback/v2/consents";
        if (matches_url(request.url, delete_url)) {
            let reserved_purchases_db = await firestore.collection("reserved_purchases");
            let captured_purchases_db = await firestore.collection("captured_purchases");

            let to_delete = [];
            let path = new FieldPath("userDetails", "userId");
            let order_id_in = request.url.substring(delete_url.length + 1);
            (await reserved_purchases_db.where(path, "==", order_id_in).get()).forEach((document) => {
                to_delete.push(document.ref.delete());
            });
            (await captured_purchases_db.where(path, "==", order_id_in).get()).forEach((document) => {
                to_delete.push(document.ref.delete());
            });

            functions.logger.debug("Deleting " + to_delete.length + " document(s)");
            for (x of to_delete) {
                await x;
            }
            response.send();
        } else if (matches_url(request.url, "/functions/purchase-callback/v2/payments")) {
            const order_id = request.body["orderId"];
            let pending_purchases_db = await firestore.collection("pending_purchases");
            let order_doc_ref = pending_purchases_db.doc(order_id);
            let order_doc_data = await order_doc_ref.get();
            let correct_authToken = order_doc_data.get("authToken");

            if (compare(correct_authToken, request.headers["authorization"])) {
                functions.logger.debug("Authtoken correct");
                let item_text = order_doc_data.get("transactionText");
                let order_time = order_doc_data.get("time");
                await order_doc_ref.delete();

                let new_purchase = request.body;
                if (new_purchase.transactionInfo.status === "RESERVE") {

                    new_purchase.transactionInfo.transactionText = item_text;
                    new_purchase.transactionInfo.orderTime = order_time;

                    let reserved_purchases_db = await firestore.collection("reserved_purchases");
                    await reserved_purchases_db.doc(order_id).set(new_purchase);
                }
                response.send();
            } else {
                response.status(400).send();
            }
            to_delete = [];
            (await pending_purchases_db.where("time", "<", Date.now() + PENDING_PURCHASES_EXPIRY_TOT_MS).get()).forEach((document) => {
                to_delete.push(document.ref.delete());
            });
            functions.logger.log("Deleting " + to_delete.length);
            for (x of to_delete) {
                await x;
            }

        } else {
            response.status(404).send();
        }
    });

async function capture_payment(transaction_text, order_id, api_url, ocp_key, access_token, merchant_id) {
    const headers = {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": ocp_key,
        "Authorization": access_token["token_type"] + " " + access_token["access_token"],
        "Merchant-Serial-Number": merchant_id,
        "X-Request-Id": order_id,
    };
    const body = {
        "merchantInfo": {
            "merchantSerialNumber": merchant_id,
        },
        "transaction": {
            "transactionText": transaction_text,
        }
    };
    functions.logger.log(headers);
    functions.logger.log(body);

    let response = await fetch(api_url + "/ecomm/v2/payments/" + order_id + "/capture/",
        { "method": "POST", "headers": headers, "body": JSON.stringify(body) });
    let response_json = await response.json();
    if (response.status === 200 && response_json["transactionInfo"]["status"] === "Captured") {
        return response_json;
    }
    functions.logger.warn(response_json);
    return false;
}

async function cancel_payment(transaction_text, order_id, api_url, ocp_key, access_token, merchant_id) {
    const headers = {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": ocp_key,
        "Authorization": access_token["token_type"] + " " + access_token["access_token"],
        "Merchant-Serial-Number": merchant_id,
    };
    const body = {
        "merchantInfo": {
            "merchantSerialNumber": merchant_id,
        },
        "transaction": {
            "transactionText": transaction_text,
        }
    };
    let response = await fetch(api_url + "/ecomm/v2/payments/" + order_id + "/cancel/",
        { "method": "PUT", "headers": headers, "body": JSON.stringify(body) });
    if (response.status === 200) {
        return true;
    }
    functions.logger.warn(await response.json());
    return false;
}

async function refund_payment(transaction_text, order_id, api_url, ocp_key, access_token, merchant_id) {
    const headers = {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": ocp_key,
        "Authorization": access_token["token_type"] + " " + access_token["access_token"],
        "Merchant-Serial-Number": merchant_id,
        "X-Request-Id": order_id,
    };
    const body = {
        "merchantInfo": {
            "merchantSerialNumber": merchant_id,
        },
        "transaction": {
            "transactionText": transaction_text,
        }
    };

    let response = await fetch(api_url + "/ecomm/v2/payments/" + order_id + "/refund/",
        { "method": "POST", "headers": headers, "body": JSON.stringify(body) });
    let response_json = await response.json();
    functions.logger.log(response_json);
    if (response.status === 200) {
        return true;
    }
    return false;
}

async function collection_data(navn) {
    let result = [];
    let collection_snap = await firestore.collection(navn).get();
    collection_snap.forEach((document) => {
        result.push(document.data());
    });
    return result;
}

exports.fetch_data = functions
    .region("europe-west2")
    .runWith({ secrets: ["CLIENT_ACCESS_CODE", "TEST_CLIENT_ID", "TEST_CLIENT_SECRET", "TEST_OCP_KEY"] })
    .https.onRequest(async (request, response) => {
        const CLIENT_ACCESS_CODE = process.env.CLIENT_ACCESS_CODE;
        functions.logger.debug(CLIENT_ACCESS_CODE);
        const BODY = JSON.parse(request.body);
        const same_length = BODY["access_code"].length === CLIENT_ACCESS_CODE.length;

        if (same_length && compare(BODY["access_code"], CLIENT_ACCESS_CODE)) {
            const QUERY = BODY["query"];

            if (QUERY === "data") {
                let reserved = await collection_data("reserved_purchases");
                let captured = await collection_data("captured_purchases");
                response.json({ "reserved": reserved, "captured": captured }).send();

            } else if (QUERY === "capture_payment") {
                const order_id = BODY["orderId"];

                let reserved_purchases_db = firestore.collection("reserved_purchases");
                let order = (await reserved_purchases_db.doc(order_id).get()).data();
                const transaction_text = order["transactionInfo"]["transactionText"];

                access_token = await get_access_token(api_url, client_id, client_secret, ocp_key, merchant_id);

                let result = await capture_payment(transaction_text, order_id, api_url, ocp_key, access_token, merchant_id);
                if (result !== false) {
                    let captured_purchases_db = firestore.collection("captured_purchases");
                    order["transactionInfo"] = result["transactionInfo"];
                    order["transactionSummary"] = result["transactionSummary"];
                    await captured_purchases_db.doc(order_id).set(order);
                    await reserved_purchases_db.doc(order_id).delete();
                    response.json({ "status": "success" }).status(200).send();
                } else {
                    response.json({ "status": "error" }).status(400).send();
                }
            } else if (QUERY === "cancel_payment") {

                const order_id = BODY["orderId"];

                let reserved_purchases_db = firestore.collection("reserved_purchases");
                let order = (await reserved_purchases_db.doc(order_id).get()).data();
                const transaction_text = order["transactionInfo"]["transactionText"];

                access_token = await get_access_token(api_url, client_id, client_secret, ocp_key, merchant_id);
                let success = await cancel_payment(transaction_text, order_id, api_url, ocp_key, access_token, merchant_id);
                if (success) {
                    await reserved_purchases_db.doc(order_id).delete();
                    response.json({ "status": "success" }).status(200).send();
                } else {
                    response.json({ "status": "error" }).status(400).send();
                }
            } else if (QUERY === "refund_payment") {
                const order_id = BODY["orderId"];

                let captured_purchases_db = firestore.collection("captured_purchases");
                let order = (await captured_purchases_db.doc(order_id).get()).data();
                const transaction_text = order["transactionInfo"]["transactionText"];

                access_token = await get_access_token(api_url, client_id, client_secret, ocp_key, merchant_id);
                let success = await refund_payment(transaction_text, order_id, api_url, ocp_key, access_token, merchant_id);
                if (success) {
                    await captured_purchases_db.doc(order_id).delete();
                    response.json({ "status": "success" }).status(200).send();
                } else {
                    response.json({ "status": "error" }).status(400).send();
                }

            } else {
                response.status(404).send();
            }
        } else {
            response.status(401).send();
        }
    });