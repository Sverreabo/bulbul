// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
    apiKey: "AIzaSyDdgC_r45CULEPtiL2rz1BunV6d_k-EDSM",
    authDomain: "bulbul-200b6.firebaseapp.com",
    projectId: "bulbul-200b6",
    storageBucket: "bulbul-200b6.appspot.com",
    messagingSenderId: "987611185564",
    appId: "1:987611185564:web:84b22867525d3d02c68859",
    measurementId: "G-KRW7Q8GLH7",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const functions = getFunctions(app, "europe-west2");

if (document.location.hostname === "127.0.0.1") {
    connectFunctionsEmulator(functions, "localhost", 5001);
}

const init_purchase = httpsCallable(functions, "init_purchase");
init_purchase();

window.addEventListener("load", () => {
    let knapper_betal = document.getElementsByClassName("betal-vipps");
    for (let knapp of knapper_betal) {
        knapp.addEventListener("click", () => { start_betaling(knapp.dataset["item"]); });
    }
});

function start_betaling(item) {

    const ALERT_WAIT = document.getElementById("alert-wait");
    ALERT_WAIT.style.visibility = "visible";

    let t0 = Date.now();

    init_purchase({ item: item })
        .then((result) => {
            console.log("Completed in ", (Date.now() - t0) / 1000);
            const data = result.data;

            ALERT_WAIT.style.visibility = "hidden";

            if ("text" in data) {
                window.location.replace(data.text);
            } else {
                console.error(data);
                window.alert("Beklager, noe gikk galt");
            }
        })
        .catch((error) => {
            ALERT_WAIT.style.visibility = "hidden";
            window.alert("Beklager, noe gikk galt");
        });
}