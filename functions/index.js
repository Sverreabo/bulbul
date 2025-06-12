const { onCall, onRequest} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions/v2");

const fetch = require("node-fetch");
const nodemailer = require('nodemailer');
const { randomUUID, timingSafeEqual } = require("crypto");
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldPath } = require('firebase-admin/firestore');

initializeApp();
const firestore = getFirestore();

let access_token;

const TEST_API_URL = "https://apitest.vipps.no";
const TEST_MERCHANT_ID = "234390";

const PROD_API_URL = "https://api.vipps.no";
const PROD_MERCHANT_ID = "753617";

const GMAIL_PASSWORD = process.env.GMAIL_PASSWORD;
const MAIL_ADDRESS = "info@bulbul.no";

const TOKEN_EXPIRY_EXTRA = 45; //Seconds

const BASE_URL_SELF = "https://bulbul.no";

const ITEMS = {
    "mehlum": {
        "price": 4900, //Øre
        "shipping_cost": 50, //Kr
        "text": "Tre krimfortellinger om Svend Foyn",
    },
    "kvinnelinjer": {
        "price": 14900,
        "shipping_cost": 50,
        "text": "Kvinnelinjer",
    },
    "mangfoldige": {
        "price": 19900,
        "shipping_cost": 50,
        "text": "Mangfoldige historier"
    },
    "kunsten-skrive": {
        "price": 29900,
        "shipping_cost": 50,
        "text": "Kunsten å skrive"
    }
};

let prod = true;
if (process.env.FUNCTIONS_EMULATOR) {
    prod = false;
}

logger.log("Production:", prod);

const MAIL_MOTTAKERE = prod ? "thorleif.bugge@usn.no, norunn.askeland@usn.no, sverreabo@gmail.com" : "sverreabo@gmail.com";

const api_url = prod ? PROD_API_URL : TEST_API_URL;
const client_id = prod ? process.env.PROD_CLIENT_ID : process.env.TEST_CLIENT_ID;
const client_secret = prod ? process.env.PROD_CLIENT_SECRET : process.env.TEST_CLIENT_SECRET;
const ocp_key = prod ? process.env.PROD_OCP_KEY : process.env.TEST_OCP_KEY;
const merchant_id = prod ? PROD_MERCHANT_ID : TEST_MERCHANT_ID;


function get_time() {
    return Math.floor(Date.now() / 1000);
}

async function get_access_token(api_url, client_id, client_secret, ocp_key, merchant_id) {
    let time = get_time();
    if (access_token !== undefined && access_token["expires_on"] - time > TOKEN_EXPIRY_EXTRA) {
        logger.info("token cached");
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
        logger.info("token from Firestore");
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
    logger.info("token from Vipps");
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
                    "shippingMethod": "Hent boka selv i Tønsberg",
                    "shippingMethodId": "henting-tonsberg",
                },
                // {
                //     "isDefault": "N",
                //     "shippingCost": item["shipping_cost"],
                //     "shippingMethod": "Sending i posten",
                //     "shippingMethodId": "sending-posten",
                // },
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

exports.init_purchase = onCall(
    {
        region: "europe-west2",
        cors: true,
        secrets: ["TEST_CLIENT_ID", "TEST_CLIENT_SECRET", "TEST_OCP_KEY", "PROD_CLIENT_ID", "PROD_CLIENT_SECRET", "PROD_OCP_KEY"]
    },
    async (data, context) => {
        data = data["data"];
        if (data === null) {
            return;
        }
        if (!(data["item"] in ITEMS)) {
            logger.log(data);
            return { error: "No such item for sale" };
        }
        const item = ITEMS[data["item"]];

        access_token = await get_access_token(api_url, client_id, client_secret, ocp_key, merchant_id);
        order = await complete_order(item, api_url, ocp_key, access_token, merchant_id);
        return { text: order["url"] };
    }
);


function matches_url(url, to_match) {
    return url.substring(0, to_match.length) === to_match;
}

function compare(a, b) {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function send_mail(data) {
    const transporter = nodemailer.createTransport({
        host: 'send.one.com',
        port: 465,
        auth: {
            user: MAIL_ADDRESS,
            pass: GMAIL_PASSWORD,
        },
    });
    data.from = '"BULBUL forlag" <' + MAIL_ADDRESS + ">";

    await transporter.sendMail(data);
}

exports.purchase_callback = onRequest(
    {
        region: "europe-west2",
        cors: true,
        secrets: ["GMAIL_PASSWORD"]
    },
    async (request, response) => {
        const delete_url = "/functions/purchase-callback/v2/consents";
        if (matches_url(request.url, delete_url)) {
            let reserved_purchases_db = await firestore.collection("reserved_purchases");
            let captured_purchases_db = await firestore.collection("captured_purchases");

            let to_delete = [];
            let path = new FieldPath("userDetails", "userId");
            let user_id_in = request.url.substring(delete_url.length + 1);

            (await reserved_purchases_db.where(path, "==", user_id_in).get()).forEach((document) => {
                to_delete.push(document.ref.delete());
            });
            (await captured_purchases_db.where(path, "==", user_id_in).get()).forEach((document) => {
                to_delete.push(document.ref.delete());
            });

            logger.debug("Deleting " + to_delete.length + " document(s)");
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
                logger.debug("Authtoken correct");
                let item_text = order_doc_data.get("transactionText");
                let order_time = order_doc_data.get("time");
                await order_doc_ref.delete();

                let new_purchase = request.body;
                if (new_purchase.transactionInfo.status === "RESERVE") {

                    new_purchase.transactionInfo.transactionText = item_text;
                    new_purchase.transactionInfo.orderTime = order_time;

                    let reserved_purchases_db = await firestore.collection("reserved_purchases");
                    await reserved_purchases_db.doc(order_id).set(new_purchase);

                    await send_mail({
                        to: MAIL_MOTTAKERE,
                        subject: "Ny bestilling (" + order_id + ")",
                        html:
                            new_purchase.userDetails.firstName + " " + new_purchase.userDetails.lastName + " har bestilt " + item_text +
                            ".<br><br>Gå inn på <a href='https://bulbul.no/betalinger'>bulbul.no/betalinger</a> for flere detaljer."
                        ,
                    });

                    await send_mail({
                        to: new_purchase.userDetails.email,
                        subject: "Ordrebekreftelse (" + order_id + ")",
                        html:
                            "Dette er en bekreftelse på din bestilling av " + item_text + ".<br><br>" +
                            "Leveringsmetode: " + new_purchase.shippingDetails.shippingMethod + "<br>" +
                            "Adresse: <br>" +
                            new_purchase.shippingDetails.address.addressLine1 + "<br>" +
                            (new_purchase.shippingDetails.address.addressLine2 === null ? "" : new_purchase.shippingDetails.address.addressLine2 + "<br>") +
                            new_purchase.shippingDetails.address.zipCode + " " + new_purchase.shippingDetails.address.city + "<br>" +
                            "<br>For spørsmål eller reklamasjon, ta kontakt:<br>" +
                            "Thorleif Bugge, tlf 95859223, <a href='mailto: thorleif.bugge@usn.no'>thorleif.bugge@usn.no</a><br>" +
                            "Norunn Askeland, tlf 97198351, <a href='mailto:norunn.askeland@usn.no'>norunn.askeland@usn.no</a><br><br>" +
                            "Mvh BULBUL forlag"
                        ,
                    });
                }
                response.status(200).send();
            } else {
                response.status(400).send();
            }

        } else {
            response.status(404).send();
        }
    }
);

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

    let response = await fetch(api_url + "/ecomm/v2/payments/" + order_id + "/capture/",
        { "method": "POST", "headers": headers, "body": JSON.stringify(body) });
    let response_json = await response.json();
    if (response.status === 200 && response_json["transactionInfo"]["status"] === "Captured") {
        return response_json;
    }
    logger.warn(response_json);
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
    logger.warn(await response.json());
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
    if (response.status === 200) {
        return true;
    }
    logger.warn(response_json);
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

exports.fetch_data = onRequest(
    {
        region: "europe-west2",
        cors: true,
        secrets: ["CLIENT_ACCESS_CODE", "GMAIL_PASSWORD", "TEST_CLIENT_ID", "TEST_CLIENT_SECRET", "TEST_OCP_KEY", "PROD_CLIENT_ID", "PROD_CLIENT_SECRET", "PROD_OCP_KEY"]
    },
    async (request, response) => {
        const CLIENT_ACCESS_CODE = process.env.CLIENT_ACCESS_CODE;
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
                    await send_mail({
                        to: order.userDetails.email,
                        subject: "Kansellering av bestilling (" + order_id + ")",
                        html:
                            "Bestillingen din av " + transaction_text + " er kansellert. Du får altså tilbake pengene.<br>" +
                            "<br>Har du spørsmål, ta kontakt:<br>" +
                            "Thorleif Bugge, tlf 95859223, <a href='mailto: thorleif.bugge@usn.no'>thorleif.bugge@usn.no</a><br>" +
                            "Norunn Askeland, tlf 97198351, <a href='mailto:norunn.askeland@usn.no'>norunn.askeland@usn.no</a><br><br>" +
                            "Mvh BULBUL forlag"
                        ,
                    });
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
                    await send_mail({
                        to: order.userDetails.email,
                        subject: "Refusjon av bestilling (" + order_id + ")",
                        html:
                            "Ditt kjøp av " + transaction_text + " er refundert. Du får altså tilbake pengene.<br>" +
                            "<br>Har du spørsmål, ta kontakt:<br>" +
                            "Thorleif Bugge, tlf 95859223, <a href='mailto: thorleif.bugge@usn.no'>thorleif.bugge@usn.no</a><br>" +
                            "Norunn Askeland, tlf 97198351, <a href='mailto:norunn.askeland@usn.no'>norunn.askeland@usn.no</a><br><br>" +
                            "Mvh BULBUL forlag"
                        ,
                    });
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
    }
);
