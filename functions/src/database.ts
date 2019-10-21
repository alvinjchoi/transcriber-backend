/**
 * @file Sets up Firebase
 * @author Andreas Schjønhaug
 */

import {DocumentReference, WriteResult} from "@google-cloud/firestore"
import admin from "firebase-admin"
import * as functions from "firebase-functions"
import serializeError from "serialize-error"
import {ProgressType} from "./enums"
import {IParagraph, ITranscript} from "./interfaces"
// Only initialise the app once
if (!admin.apps.length) {
  console.debug("initialize app")
  admin.initializeApp(functions.config().firebase)
} else {
  console.debug("return initialized app")
  admin.app()
}

const db = admin.firestore()

const database = (() => {
  const updateTranscript = async (id: string, transcript: ITranscript): Promise<FirebaseFirestore.WriteResult> => {
    console.debug("updateTranscript: ", id, " transcript: ", JSON.stringify(transcript))
    return db.doc(`transcripts/${id}`).set({ ...transcript }, { merge: true })
  }

  const setProgress = async (transcriptId: string, progress: ProgressType): Promise<FirebaseFirestore.WriteResult> => {
    console.debug("setProgress: ", transcriptId)
    const lastUpdated = admin.firestore.Timestamp.fromDate(new Date())
    const transcript: ITranscript = { status: { progress, lastUpdated} }

    if (progress === ProgressType.Analysing || progress === ProgressType.Saving) {
      transcript.status!.percent = 0
    } else if (progress === ProgressType.Done) {
      transcript.status!.percent = admin.firestore.FieldValue.delete()
    }

    return updateTranscript(transcriptId, transcript)
  }

  const buildNewId = () => {
    return db.collection(`transcripts`).doc().id
  }

  const setPercent = async (transcriptId: string, percent: number): Promise<FirebaseFirestore.WriteResult> => {
    // console.debug("setPercent: ", transcriptId)
    const lastUpdated = admin.firestore.Timestamp.fromDate(new Date())
    const transcript: ITranscript = { status: { percent, lastUpdated } }

    return updateTranscript(transcriptId, transcript)
  }

  const addParagraph = async (transcriptId: string, paragraph: IParagraph, percent: number) => {
    // console.debug("addParagraph: ", transcriptId)
    // Batch
    const batch = db.batch()

    // Add paragraph
    const paragraphsRef = `transcripts/${transcriptId}/paragraphs`
    const paragraphId = db.collection(paragraphsRef).doc().id

    const paragraphReference = db.doc(`${paragraphsRef}/${paragraphId}`)

    batch.create(paragraphReference, paragraph)

    // Set percent
    const transcriptReference = db.doc(`transcripts/${transcriptId}`)
    batch.update(transcriptReference, { "status.percent": percent })

    // Commit
    return batch.commit()
  }

  const setDuration = async (transcriptId: string, seconds: number): Promise<FirebaseFirestore.WriteResult> => {
    console.debug("setDuration: ", transcriptId)
    const transcript: ITranscript = { metadata: { audioDuration: seconds } }

    return updateTranscript(transcriptId, transcript)
  }

  const updateFlacFileLocation = async (transcriptId: string, flacFileLocationUri: string): Promise<FirebaseFirestore.WriteResult> => {
    // console.debug("updateFlacFileLocation: ", transcriptId)
    const transcript: ITranscript = { speechData: {flacFileLocationUri} }
    return updateTranscript(transcriptId, transcript)
  }
  const updateGoogleSpeechTranscribeReference = async (transcriptId: string, reference: string): Promise<FirebaseFirestore.WriteResult> => {
    console.debug("updateGoogleSpeechTranscribeReference: ", transcriptId)
    const transcript: ITranscript = { speechData: { reference } }
    return updateTranscript(transcriptId, transcript)
  }

  const errorOccured = async (transcriptId: string, error: Error): Promise<FirebaseFirestore.WriteResult> => {
    const serializedError = serializeError(error)

    // Firestore does not support undefined values, remove them if present.
    Object.keys(serializedError).forEach(key => serializedError[key] === undefined && delete serializedError[key])

    const transcript: ITranscript = {
      status: {
        error: serializedError,
      },
    }
    return updateTranscript(transcriptId, transcript)
  }

  const getParagraphs = async (transcriptId: string): Promise<IParagraph[]> => {
    const querySnapshot = await db
      .collection(`transcripts/${transcriptId}/paragraphs`)
      .orderBy("startTime")
      .get()

    const paragraphs = Array<IParagraph>()

    querySnapshot.forEach(doc => {
      const paragraph = doc.data() as IParagraph

      paragraphs.push(paragraph)
    })

    return paragraphs
  }

  const getProgress = async (id: string): Promise<ProgressType> => {
    console.debug("database: getProgress: id: ", id)
    const doc = await db.doc(`transcripts/${id}`).get()

    const transcript = doc.data() as ITranscript

    console.debug("database: getProgress: id: ", id, ", transcriptDoc: ", transcript)
    if (transcript && transcript.status) {
      // @ts-ignore
      return transcript.status.progress
    } else {
      return ProgressType.NotFound
    }
  }

  const setPlaybackGsUrl = async (id: string, url: string) => {
    const transcript: ITranscript = { playbackGsUrl: url }

    return updateTranscript(id, transcript)
  }

  const getTranscript = async (transcriptId: string): Promise<ITranscript> => {
    const doc = await db.doc(`transcripts/${transcriptId}`).get()

    return doc.data() as ITranscript
  }

  const deleteTranscript = async (transcriptId: string): Promise<WriteResult> => {
    console.info("Delete transcript by id: ", transcriptId)
    // Delete the paragraphs collection
    const paragraphsPath = `/transcripts/${transcriptId}/paragraphs`

    await deleteCollection(paragraphsPath, 10)

    // Delete the document
    return db.doc(`transcripts/${transcriptId}`).delete()
  }

  const deleteCollection = async (collectionPath: string, batchSize: number): Promise<{}> => {
    console.info("Delete collection by path: ", collectionPath)
    const collectionRef = db.collection(collectionPath)
    const query = collectionRef.orderBy("__name__").limit(batchSize)

    return new Promise((resolve, reject) => {
      deleteQueryBatch(query, batchSize, resolve, reject)
    })
  }

  // @ts-ignore
  const deleteQueryBatch = (query: FirebaseFirestore.Query, batchSize: number, resolve, reject) => {
    query
      .get()
      .then(snapshot => {
        // When there are no documents left, we are done
        if (snapshot.size === 0) {
          return 0
        }

        // Delete documents in a batch
        const batch = db.batch()
        snapshot.docs.forEach(doc => {
          batch.delete(doc.ref)
        })

        return batch.commit().then(() => {
          return snapshot.size
        })
      })
      .then((numDeleted: number) => {
        if (numDeleted === 0) {
          resolve()
          return
        }

        // Recurse on the next process tick, to avoid
        // exploding the stack.
        process.nextTick(() => {
          deleteQueryBatch(query, batchSize, resolve, reject)
        })
      })
      .catch(reject)
  }

  // @ts-ignore
  const getTranscripts = async (): Promise => {
    const querySnapshot = await db.collection(`transcripts/`).get()

    const transcripts: { [k: string]: ITranscript } = {}
    querySnapshot.forEach(doc => {
      const id = doc.id
      const transcript = doc.data() as ITranscript

      transcripts[doc.id] = transcript
    })

    return transcripts
  }

  const findTransciptUpdatedTodayNotDone = async (): Promise<{ [k: string]: ITranscript }> => {
    const yesterday = new Date();
    yesterday.setDate( yesterday.getDate() - 2 );
    const startfulldate = admin.firestore.Timestamp.fromDate(yesterday);
    const transcripts  = await db.collection("transcripts")
      .where("createdAt", ">", startfulldate)
      .where("status.progress", "==", ProgressType.Saving)
      .get().then((snapshot) => {
        const transcriptsSaving: { [k: string]: ITranscript } = {}
        snapshot.docs.forEach(doc => {
          const transcript = doc.data() as ITranscript
          if (transcript && !transcript.id) {
            console.debug("adding transcript.id to: ", doc.id)
            transcript.id = doc.id
          }
          transcriptsSaving[doc.id] = transcript;
        })
        return transcriptsSaving
      });
    await db.collection("transcripts")
      .where("createdAt", ">", startfulldate)
      .where("status.progress", "==", ProgressType.Transcribing)
      .get().then((snapshot) => {
        const transcriptsTranscribingTmp: { [k: string]: ITranscript } = {}
        snapshot.docs.forEach(doc => {
          const transcript = doc.data() as ITranscript
          if (transcript && !transcript.id){
            transcript.id = doc.id
          }
          transcripts[doc.id] = transcript;
        })
      });
    return transcripts;
  }

  return {
    addParagraph,
    buildNewId,
    deleteCollection,
    deleteTranscript,
    errorOccured,
    findTransciptUpdatedTodayNotDone,
    getParagraphs,
    getProgress,
    getTranscript,
    getTranscripts,
    setDuration,
    setPercent,
    setPlaybackGsUrl,
    setProgress,
    updateFlacFileLocation,
    updateGoogleSpeechTranscribeReference,
    updateTranscript
  }
})()

export default database
