/**
 * The one rule this page kept breaking (docs/AUDITORIA-COMENTARIOS-2026-09-05.md,
 * C2): a `getDocs` against a stalled channel does not reject — at the SDK's
 * ten-second mark it resolves empty from the in-memory cache — and the page
 * painted that as "You have not commented on any paper yet". An absence has
 * to come from the server (src/utils/cacheAuthority.js). Here that absence
 * becomes the most retryable error Firestore has, so `patientRead` keeps
 * asking and the eventual server answer heals the screen.
 */
export class UnconfirmedAbsenceError extends Error {
  constructor() {
    super('The empty answer came from the cache, not the server.');
    this.name = 'UnconfirmedAbsenceError';
    this.code = 'unavailable';
  }
}

export function authoritativePage(page) {
  if (page.comments.length === 0 && page.fromCache) throw new UnconfirmedAbsenceError();
  return page;
}
