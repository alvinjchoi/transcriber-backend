/**
 * @file Authenticate user from Authorization header
 * @author Bard Lind (bard.lind@gmail.com)
 */
import {GetSignedUrlConfig} from "@google-cloud/storage"
import cookieParser from "cookie-parser"
import cors from "cors";
import express from "express";
import admin from "firebase-admin"
import * as functions from "firebase-functions"
import {google} from "googleapis";
import jwt from "jsonwebtoken";
import serializeError from "serialize-error";
import ua from "universal-analytics"
import database from "../database";
import {ProgressType} from "../enums";
import docx from "../exportTranscript/docx";
import json from "../exportTranscript/json";
import xmp from "../exportTranscript/xmp";
import {ISpeechRecognitionResult, ITranscript} from "../interfaces";
import {updateFromGoogleSpeech} from "../transcription";
import {bucket} from "../transcription/storage";


const app = express();
// ----------------
// Google analytics
// ----------------

const accountId = functions.config().analytics.account_id

if (!accountId) {
    console.warn("Google Analytics account ID missing")
}

const visitor = ua(accountId)

// Only initialise the app once
if (!admin.apps.length) {
    admin.initializeApp(functions.config().firebase)
} else {
    admin.app()
}
// let googleAuth: any = null;
// (async () => {
//       googleAuth = await google.auth.getClient({
//         scopes: ['https://www.googleapis.com/auth/cloud-platform']
//     });
//      console.log("googleAuth: ", googleAuth)
// })();

const gaxOpts = {
    clientConfig: {}
}

// Express middleware that validates Firebase ID Tokens passed in the Authorization HTTP header.
// The Firebase ID token needs to be passed as a Bearer token in the Authorization HTTP header like this:
// `Authorization: Bearer <Firebase ID Token>`.
// when decoded successfully, the ID Token content will be added as `req.user`.
const validateFirebaseIdToken = (req, res, next) => {
    console.log('Check if request is authorized with Firebase ID token');

    if ((!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) &&
        !(req.cookies && req.cookies.__session)) {
        console.error('No Firebase ID token was passed as a Bearer token in the Authorization header.',
            'Make sure you authorize your request by providing the following HTTP header:',
            'Authorization: Bearer <Firebase ID Token>',
            'or by passing a "__session" cookie.');
        res.status(403).send('Unauthorized');
        return;
    }

    let idToken;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        console.log('Found "Authorization" header');
        // Read the ID Token from the Authorization header.
        idToken = req.headers.authorization.split('Bearer ')[1];
    } else if (req.cookies) {
        console.log('Found "__session" cookie');
        // Read the ID Token from cookie.
        idToken = req.cookies.__session;
    } else {
        // No cookie
        res.status(403).send('Unauthorized');
        return;
    }
    admin.auth().verifyIdToken(idToken).then((decodedIdToken) => {
        console.log('ID Token correctly decoded', decodedIdToken);
        req.user = decodedIdToken;
        visitor.event("api", "authorization", "idtoken", decodedIdToken).send()
        return next();
    }).catch((error) => {
        console.log('Error while verifying Firebase ID token:', error);
        if (error.code === "auth/argument-error") { // TODO validate the signature
            console.log("Will try to iterpet this token as an custom token ");
            const decoded = jwt.decode(idToken);
            console.log("Decoded token: ", decoded);
            const user = {
                user_id: decoded.uid
            }
            req.user = user;
            visitor.event("api", "authorization", "customtoken", decoded).send()
            return next();
        } else {
            visitor.event("api", "authorization", "failed", idToken).send()
            res.status(403).send('Unauthorized');
        }
    });
};

app.use(cors());
app.use(cookieParser());
app.use(validateFirebaseIdToken);
app.get('/hello', (req, res) => {
    res.status(200).send(`Hello ${req.user.user_id}`);
});

function doAcceptJson(request: Request) {
    let acceptJson = false;
    if (request && request.header('Accept')) {
        if (request.header('Accept').includes("application/json")) {
            acceptJson = true;
        }
    }
    return acceptJson;
}

app.post('/transcriptId', (req, res) => {
    const transcriptId = database.buildNewId();
    console.log("transcriptId: ", transcriptId);

    if (doAcceptJson(req)) {
        const transcriptIdJson = {
            transcriptId
        }
        res.contentType("application/json").status(200).send(JSON.stringify(transcriptIdJson))
    } else {
        res.status(200).send(transcriptId);
    }

});
app.post('/uploadUrl', (req, res) => {
    const transcriptId = req.query.transcriptId;
    if (!transcriptId) {
        res.status(422).send("Missing the transcriptId query parameter");
    }
    const userId = req.user.user_id;
    visitor.set("uid", userId)
    if (!userId) {
        res.status(422).send("Missing the user_id from your authorization token.");
    }
    const file = bucket.file("media/" + userId + "/" + transcriptId + "-original");
    let contentType = req.header("X-Content-Type");
    if (!contentType) {
        contentType = req.header("Content-Type")
        if (!contentType) {
            res.status(422).send("Missing the X-Content-Type header parameter. Use eg audio/mpeg for any audio format.");
        }
    }
    const config: GetSignedUrlConfig = {
        action: 'write',
        contentType,
        expires: '03-17-2025'
    }
    const data = file.getSignedUrl(config).then((signedUrlData) => {
        const url = signedUrlData[0];
        if (doAcceptJson(req)) {
            const uploadUrlJson = {
                uploadUrl: url
            }
            res.contentType("application/json").status(200).send(JSON.stringify(uploadUrlJson))
        } else {
            res.status(201).send(url);
        }
    }).catch((err) => {
        console.error("Failed to create uploadUrl. Reason: ", err);
        res.status(412).send("Failed to create uploadUrl for transcriptId: " + transcriptId);
    })

});
app.post('/transcripts/:transcriptId', (req, res) => {
    const transcriptId = req.params.transcriptId;
    if (!transcriptId) {
        res.status(422).send("Missing the transcriptId query parameter");
    }
    console.log("Create Transcript from body: ", req.body, " transcriptId: ", transcriptId);
    let mimeType = req.query.originalMimeType;
    if (!mimeType) {
       mimeType = req.body.originalMimeType
    }
    if (!mimeType) {
        res.status(422).send("Missing the originalMimeType body parameter.");
    }
    const userId = req.user.user_id;
    if (!userId) {
        res.status(422).send("Missing the user_id from your authorization token.");
    }
    let languageCode = req.query.languageCode;
    if (!languageCode) {
        languageCode = req.body.languageCode
    }
    if (!languageCode) {
        languageCode = "nb-NO"
    }
    visitor.set("uid", userId)
    const transcript: ITranscript = {
        metadata: {
            languageCodes: [languageCode],
            originalMimeType: mimeType
        },
        status: {
            progress: ProgressType.Uploading
        },
        userId
    };

    database.updateTranscript(transcriptId, transcript).then((transcriptDoc) => {
        const locationUri = "/api/transcripts/" + transcriptId;
        visitor.event("api", "transcripts", "update", transcriptId)
        const message = "Follow location header to find transcription status.";
        if (doAcceptJson(req)) {
            const messageJson = {
                message
            }
            res.location(locationUri).contentType("application/json").status(202).send(JSON.stringify(messageJson))
        } else {
            res.location(locationUri).status(202).send(message);
        }
    }).catch((error) => {
        console.error("Failed to update Transcript. Reason: ", error);
        visitor.exception(error.message, true).send();
        const message = "Failed to create transcription Doc for transcriptId: " + transcriptId;
        if (doAcceptJson(req)) {
            const messageJson = {
                message
            }
            res.contentType("application/json").status(412).send(messageJson);
        } else {
            res.status(412).send(message);
        }
    });
});
app.get('/transcripts/:transcriptId', async (req, res) => {
    const transcriptId = req.params.transcriptId;

    if (!transcriptId) {
        res.status(422).send("Missing the transcriptId query parameter")
    }

    try {
        const transcript = await database.getTranscript(transcriptId);
        transcript.id = transcriptId;
        const paragraphs = await database.getParagraphs(transcriptId);
        transcript.paragraphs = paragraphs;
        console.log("Found transcript: ", transcript);
        if (transcript && transcript.userId) {
            if (transcript.userId === req.user.user_id) {
                res.contentType("application/json").status(200).send(transcript);
            } else {
                console.log("Transcript ", transcriptId, " was found. The userId's do not match. from IdToken: ", req.user.user_id,
                    " from transcript: ", transcript.userId);
                res.send(404)
            }
        } else {
            console.log("Transcript ", transcriptId,  " does not exist.");
            res.send(404)
        }

    } catch (error) {
        // Log error to console
        console.error("Failed to fetch transcript. transcriptId: ", transcriptId, ". Error: ", error);

        // Log error to Google Analytics
        // visitor.exception(error.message, true).send()

        res.status(500).send(serializeError(error))
    }
})
app.get('/transcripts/:transcriptId/export', async (req, res) => {
    const transcriptId = req.params.transcriptId;
    const exportTo = req.header('Accept');

    if (!transcriptId) {
        res.status(422).send("Missing the transcriptId query parameter")
    }

    try {
        const transcript = await database.getTranscript(transcriptId);
        const paragraphs = await database.getParagraphs(transcriptId);
        console.log("Found transcript: ", transcript);
        if (transcript && transcript.userId) {
            if (transcript.userId === req.user.user_id) {
                if (exportTo === "application/json") {
                    json(transcript, paragraphs, res);
                } else if (exportTo ==="application/docx") {
                    await docx(transcript, paragraphs, res);
                } else if (exportTo ==="application/xmp") {
                    xmp(transcript, paragraphs, res);
                } else {
                    console.log("Unknown export format: ", exportTo);
                    res.status(422).send("Please state your expected export format in the 'Accept:' header. " +
                        "Supported values are: 'application/json', 'application/docx'");
                }
            } else {
                console.log("Transcript ", transcriptId, " was found. The userId's do not match. from IdToken: ", req.user.user_id,
                    " from transcript: ", transcript.userId);
                res.send(404)
            }
        } else {
            console.log("Transcript ", transcriptId,  " does not exist.");
            res.send(404)
        }

    } catch (error) {
        // Log error to console
        console.error("Failed to fetch transcript. transcriptId: ", transcriptId, ". Error: ", error);

        // Log error to Google Analytics
        // visitor.exception(error.message, true).send()

        res.status(500).send(serializeError(error))
    }
})
app.get('/operations/:googleSpeechRef', async (req, res) => {
    const googleSpeechRef = req.params.googleSpeechRef;
    if (!googleSpeechRef) {
        res.status(422).send("Missing the googleSpeechRef path parameter")
    }

    try {
        const googleAuth = await google.auth.getClient({
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        const { data } = await google.speech('v1').operations.get({ auth: googleAuth, name: googleSpeechRef });

        console.log("Result from operations.get: ", data);
        /*
        data:
         { name: '6080322534027970989',
  metadata:
   { '@type': 'type.googleapis.com/google.cloud.speech.v1p1beta1.LongRunningRecognizeMetadata',
     progressPercent: 100,
     startTime: '2019-05-24T17:18:26.958133Z',
     lastUpdateTime: '2019-05-24T17:18:33.168022Z' },
  done: true,
  response:
   { '@type': 'type.googleapis.com/google.cloud.speech.v1p1beta1.LongRunningRecognizeResponse',
     results: [ [Object] ] } }
         */
        const responses = null
        if (data.done === true) {
            const longRunningRecognizeResponse = data.response
            console.log("getOperation. responses: ", longRunningRecognizeResponse)
            if (longRunningRecognizeResponse) {
                const speechRecognitionResults = longRunningRecognizeResponse.results as ISpeechRecognitionResult[]
                console.log("complete: ", speechRecognitionResults)
                res.contentType("application/json").status(200).send(JSON.stringify(speechRecognitionResults))
            } else {
                res.status(412).send("No response found")
            }
        } else if (data.metadata) {
            res.contentType("application/json").status(200).send(JSON.stringify(data.metadata))
        } else {
            res.send(404)
        }


    } catch (error) {
        console.error("Failed to fetch operation by googleSpeechRef: ", googleSpeechRef, ". Error: ", error);
        res.status(500).send(serializeError(error))
    }
})

app.post('/transcriptions/:transcriptionId/refreshFromGoogleSpeech', async (req, res) => {
    const transcriptId = req.params.transcriptionId;
    if (!transcriptId) {
        res.status(422).send("Missing the transcriptId query parameter");
    }
    console.log("refreshFromGoogleSpeech. transcriptionId: ", transcriptId)
    try {
        const status: string = await updateFromGoogleSpeech(transcriptId)
        res.send(status)
    } catch (error) {
        console.error("Failed to fetch operation by transcriptionId: ", transcriptId, ". Error: ", error);
        res.status(500).send(serializeError(error))
    }

})

export default app
