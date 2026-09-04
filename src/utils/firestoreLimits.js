/**
 * Firestore's limits, measured rather than remembered.
 *
 * This file exists because the codebase had come to assert two different
 * numbers for the same limit. `interactionProfileStore.js` batched by ten and
 * said "the batch size is fixed by the `in` operator"; the lists screen batched
 * by thirty and said the same thing. Both comments described a platform fact,
 * neither owned it, and the older one had simply been overtaken — the cap was
 * ten when that code was written and Firestore has since raised it.
 *
 * A platform limit that lives in a comment beside a magic number is a limit
 * that drifts. It lives here now, once.
 */

/**
 * The most values a single `in` / `not-in` / `array-contains-any` filter takes.
 *
 * MEASURED against the Firestore emulator, not read off a changelog:
 *
 *     30 values -> returns 30 documents
 *     31 values -> invalid-argument: 'IN' supports up to 30 comparison values.
 *
 * The measurement matters because nothing in the process catches this. The
 * client SDK (firebase 12.14.0) validates only that the array is non-empty —
 * `__PRIVATE_validateDisjunctiveFilterElements` — so a batch one value too long
 * is built happily, sent, and refused by the backend. It arrives as a rejected
 * read, which every caller here surfaces as the same generic "could not load"
 * as a flaky network. Re-measure before raising this; do not infer it.
 */
export const FIRESTORE_IN_FILTER_MAX = 30;
