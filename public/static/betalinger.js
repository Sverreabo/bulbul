const LOGIN_BUTTON = document.getElementById("login-button");
const LOGIN_CODE = document.getElementById("login-code");
const LOGIN_DIV = document.getElementById("login");
const ALERT_WAIT = document.getElementById("alert-wait");

const MAIN_CONTENT = document.getElementById("main-content");
const P_DATA_LABEL = document.getElementById("data-label");
const TABLE_OVERVIEW = document.getElementById("overview-data");
const TABLE_DETAILS = document.getElementById("detailed-data");

let access_code = localStorage.getItem("access_code");
let reserved_purchases;
let captured_purchases;
let current_tab = 0;

LOGIN_BUTTON.addEventListener("click", () => {
    access_code = LOGIN_CODE.value.trim();
    login();
});

login();

function get_date_string(time) {
    date = new Date(time);
    return date.toLocaleString("no-NO").split(" GMT")[0];
}

function set_tab(n) {
    current_tab = n;
    TABLE_DETAILS.innerHTML = "";
    if (current_tab === 0) {
        P_DATA_LABEL.innerText = "Reserverte betalinger";
    } else {
        P_DATA_LABEL.innerText = "Fullførte betalinger";
    }
    view_data();
}

async function login() {
    if (access_code === null) {
        return;
    }
    await update_data();
}


function display_data(data, table) {
    table.innerHTML = "";
    for (arr of data.reverse()) {
        var row = table.insertRow(0);
        for (let i = 0; i < arr.length; i++) {
            let cell = row.insertCell(i);
            cell.innerHTML = arr[i];
        }
    }
}

async function update_data() {
    ALERT_WAIT.style.visibility = "visible";
    const DATA = {
        "access_code": access_code,
        "query": "data",
    };
    const OPTIONS = {
        "method": "POST",
        "body": JSON.stringify(DATA),
    };
    let response = await fetch(window.location.origin + "/functions/fetch-data", OPTIONS);
    ALERT_WAIT.style.visibility = "hidden";
    if (response.status === 401) {
        window.alert("Feil kode");
    } else if (response.status === 200) {
        LOGIN_DIV.style.display = "none";
        MAIN_CONTENT.style.display = "unset";

        localStorage.setItem("access_code", access_code);

        let response_json = await response.json();

        reserved_purchases = response_json["reserved"];
        captured_purchases = response_json["captured"];
        set_tab(0);
    } else {
        window.alert("Beklager, noe gikk galt. Feilkode: 30");
    }
}

function get_current_data() {
    if (current_tab === 0) {
        return reserved_purchases;
    } else {
        return captured_purchases;
    }
}

function view_data() {
    let result = [["Navn", "Tidspunkt", "Kjøp", ""]];
    let current_data = get_current_data();
    for (purchase of current_data) {
        result.push([
            purchase["userDetails"]["firstName"] + " " + purchase["userDetails"]["lastName"],
            get_date_string(purchase["transactionInfo"]["timeStamp"]),
            purchase["transactionInfo"]["transactionText"],
            "<button onclick=view_details('" + purchase["orderId"] + "')>Vis detaljer</button>",
        ]);
    }
    display_data(result, TABLE_OVERVIEW);
}

function view_details(order_id) {
    let purchase;
    let current_data = get_current_data();
    for (x of current_data) {
        if (x["orderId"] === order_id) {
            purchase = x;
            break;
        }
    }
    let data = [
        ["Navn", purchase["userDetails"]["firstName"] + " " + purchase["userDetails"]["lastName"]],
        ["Tidspunkt", get_date_string(purchase["transactionInfo"]["timeStamp"])],
        ["Kjøp", purchase["transactionInfo"]["transactionText"]],
        ["Total betaling", (Number(purchase["transactionInfo"]["amount"]) / 100) + ",-"],
        ["Leveringskostnad", purchase["shippingDetails"]["shippingCost"] + ",-"],
        ["Levering", purchase["shippingDetails"]["shippingMethod"]],
        ["Adresse", purchase["shippingDetails"]["address"]["addressLine1"]],
    ];
    if (purchase["shippingDetails"]["address"]["addressLine2"] !== null) {
        data.push(["", purchase["shippingDetails"]["address"]["addressLine2"]]);
    }
    data.push(["", purchase["shippingDetails"]["address"]["zipCode"] + " " + purchase["shippingDetails"]["address"]["city"]]);
    data.push(["Email", purchase["userDetails"]["email"]]);
    data.push(["Telefon", purchase["userDetails"]["mobileNumber"]]);
    if (current_tab === 0) {
        data.push([
            "<button onclick=cancel_payment('" + order_id + "')>Kanseller betaling</button>",
            "<button onclick=capture_payment('" + order_id + "')>Godkjenn betaling</button>",
        ]);
    } else if (current_tab === 1) {
        data.push([
            "<button onclick=refund_payment('" + order_id + "')>Refunder betaling</button>",
        ]);
    }
    display_data(data, TABLE_DETAILS);
}

async function capture_payment(order_id) {
    console.log(order_id);
    ALERT_WAIT.style.visibility = "visible";
    const DATA = {
        "access_code": access_code,
        "query": "capture_payment",
        "orderId": order_id,
    };
    const OPTIONS = {
        "method": "POST",
        "body": JSON.stringify(DATA),
    };
    let response = await fetch(window.location.origin + "/functions/fetch-data", OPTIONS);
    ALERT_WAIT.style.visibility = "hidden";
    if (response.status === 200) {

        window.alert("Betaling godkjent");
        await login();

    } else if (response.status === 400) {
        window.alert("Beklager, noe gikk galt. Feilkode: 41");
    } else {
        window.alert("Beklager, noe gikk galt. Feilkode: 40");
    }

}

async function cancel_payment(order_id) {
    console.log(order_id);
    ALERT_WAIT.style.visibility = "visible";
    const DATA = {
        "access_code": access_code,
        "query": "cancel_payment",
        "orderId": order_id
    };
    const OPTIONS = {
        "method": "POST",
        "body": JSON.stringify(DATA),
    };
    let response = await fetch(window.location.origin + "/functions/fetch-data", OPTIONS);
    ALERT_WAIT.style.visibility = "hidden";
    if (response.status === 200) {

        window.alert("Betalingen er kansellert");
        await login();

    } else if (response.status === 400) {
        window.alert("Beklager, noe gikk galt. Feilkode: 51");
    } else {
        window.alert("Beklager, noe gikk galt. Feilkode: 50");
    }
}

async function refund_payment(order_id) {
    console.log(order_id);
    ALERT_WAIT.style.visibility = "visible";
    const DATA = {
        "access_code": access_code,
        "query": "refund_payment",
        "orderId": order_id
    };
    const OPTIONS = {
        "method": "POST",
        "body": JSON.stringify(DATA),
    };
    let response = await fetch(window.location.origin + "/functions/fetch-data", OPTIONS);
    ALERT_WAIT.style.visibility = "hidden";
    if (response.status === 200) {

        window.alert("Betalingen er refundert");
        await login();

    } else if (response.status === 400) {
        window.alert("Beklager, noe gikk galt. Feilkode: 61");
    } else {
        window.alert("Beklager, noe gikk galt. Feilkode: 60");
    }
}