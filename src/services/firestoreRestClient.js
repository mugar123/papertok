/**
 * The app's one REST client for Firestore (src/utils/firestoreRest.js).
 *
 * Same project as the SDK, a different transport: one plain request per
 * read, with a signal that ends it — what the SDK's listen stream cannot give.
 *
 * Deliberately anonymous. Everything read through it is open to
 * `request.auth == null` under the rules (public lists, public profiles), and
 * a token would cost a CORS preflight per URL — one extra round trip per read.
 */
import app from './firebase.js';
import { createFirestoreRest } from '../utils/firestoreRest.js';

export const firestoreRest = createFirestoreRest({ projectId: app.options.projectId });
