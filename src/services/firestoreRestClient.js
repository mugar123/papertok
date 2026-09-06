/**
 * The app's one REST client for Firestore (src/utils/firestoreRest.js).
 *
 * Same project as the SDK, a different transport: one plain request per
 * read, with a signal that ends it — the property the follow sheet needs and
 * the SDK's listen stream cannot give.
 *
 * Deliberately anonymous. Everything read through it is open to
 * `request.auth == null` under the rules (follow edges, public profiles),
 * and a token would cost a CORS preflight per URL — one extra round trip for
 * every row of a list. The single document anonymity cannot read, the
 * reader's own private profile, is served from the session cache by the
 * caller instead (followListLoad.js).
 */
import app from './firebase.js';
import { createFirestoreRest } from '../utils/firestoreRest.js';

export const firestoreRest = createFirestoreRest({ projectId: app.options.projectId });
