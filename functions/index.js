const functions = require("firebase-functions");
const fetch = require("node-fetch");

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//

exports.helloWorld = functions.https.onCall(async (data, context) => {

    return await fetch('https://httpbin.org/post', {
        method: 'POST',
        body: 'a=1'
    })
        .then(res => {
            return res.json()
        })
        .then(json => {
            return { text: json };
        })
        .catch(err => console.log(err));

});
