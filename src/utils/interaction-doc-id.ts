// The interaction documents were the first collection to encode its names;
// the encoder now lives in firestore-doc-id.ts and serves `savedPapers` too.
// These names stay for the store and its tests.
export {
  encodeFirestoreDocId as encodeInteractionDocId,
  decodeFirestoreDocId as decodeInteractionDocId,
} from './firestore-doc-id.ts';
