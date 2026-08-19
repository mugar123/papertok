/**
 * Public handle rules for user profiles.
 *
 * A handle is the only user-chosen string that becomes a URL segment, so the
 * grammar is deliberately narrow and the reserved list keeps handles from
 * colliding with application routes or from impersonating the product itself.
 *
 * This module is pure: the atomic reservation lives in `userProfileService`
 * (batch write) and in `firestore.rules` (create-only `handles/{handle}` doc).
 */

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 40;

const HANDLE_PATTERN = /^[a-z0-9_]+$/;

/**
 * Handles nobody may claim. Two families:
 *  - application route segments, so `/public/user/settings` can never be
 *    ambiguous with a real profile;
 *  - names that would let an account pose as staff or as the product.
 *
 * `firestore.rules` carries the same list; `userHandle.test.js` fails if the
 * two ever drift apart, because the client copy is only a courtesy — the rules
 * copy is the one that is actually enforced.
 */
export const RESERVED_HANDLES = Object.freeze([
  'about',
  'admin',
  'administrator',
  'api',
  'assets',
  'auth',
  'contact',
  'docs',
  'entity',
  'explorer',
  'feed',
  'following',
  'help',
  'legal',
  'list',
  'lists',
  'login',
  'logout',
  'me',
  'moderator',
  'onboarding',
  'paper',
  'papers',
  'papertok',
  'privacy',
  'profile',
  'public',
  'register',
  'report',
  'research',
  'root',
  'search',
  'security',
  'settings',
  'signin',
  'signup',
  'staff',
  'support',
  'system',
  'team',
  'terms',
  'user',
  'users',
  'www',
]);

const RESERVED_HANDLE_SET = new Set(RESERVED_HANDLES);

export const HANDLE_ERRORS = Object.freeze({
  empty: 'HANDLE_EMPTY',
  tooShort: 'HANDLE_TOO_SHORT',
  tooLong: 'HANDLE_TOO_LONG',
  charset: 'HANDLE_INVALID_CHARACTERS',
  numericOnly: 'HANDLE_NEEDS_A_LETTER',
  reserved: 'HANDLE_RESERVED',
});

export class InvalidHandleError extends Error {
  constructor(code) {
    super(`Invalid handle: ${code}`);
    this.name = 'InvalidHandleError';
    this.code = code;
  }
}

/**
 * Case folding happens here and only here. `@Ada` and `@ada` must resolve to
 * the same reservation document, otherwise the uniqueness guarantee is a lie.
 */
export function normalizeHandle(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^@+/, '').toLowerCase();
}

export function isReservedHandle(value) {
  return RESERVED_HANDLE_SET.has(normalizeHandle(value));
}

/** @returns {{ valid: boolean, handle: string, code: string|null }} */
export function inspectHandle(value) {
  const handle = normalizeHandle(value);
  if (!handle) return { valid: false, handle, code: HANDLE_ERRORS.empty };
  if (!HANDLE_PATTERN.test(handle)) {
    return { valid: false, handle, code: HANDLE_ERRORS.charset };
  }
  if (handle.length < HANDLE_MIN_LENGTH) {
    return { valid: false, handle, code: HANDLE_ERRORS.tooShort };
  }
  if (handle.length > HANDLE_MAX_LENGTH) {
    return { valid: false, handle, code: HANDLE_ERRORS.tooLong };
  }
  // An all-digit or all-underscore handle reads as an internal identifier and
  // invites confusion with document ids.
  if (!/[a-z]/.test(handle)) {
    return { valid: false, handle, code: HANDLE_ERRORS.numericOnly };
  }
  if (RESERVED_HANDLE_SET.has(handle)) {
    return { valid: false, handle, code: HANDLE_ERRORS.reserved };
  }
  return { valid: true, handle, code: null };
}

export function isValidHandle(value) {
  return inspectHandle(value).valid;
}

/** Normalizes and validates, or throws `InvalidHandleError`. */
export function requireHandle(value) {
  const result = inspectHandle(value);
  if (!result.valid) throw new InvalidHandleError(result.code);
  return result.handle;
}
