const ERROR_MESSAGES = {
  en: {
    GENERAL_ERROR: 'An unexpected error occurred. Try again.',
    CONNECTION_ERROR: 'Check your connection and try again.',
    PROFILE_LOAD_FAILED: 'Your profile could not be retrieved. Check your connection and try again.',
    AUTH_FAILED: 'You could not be signed in. Try again.',
    AUTH_LINK_FAILED: 'That sign-in method could not be connected. Try again.',
    AUTH_EMAIL_ALREADY_USED: 'That email already signs in to PaperTok another way. Use the method you already have and connect GitHub from Settings.',
    AUTH_IDENTITY_TAKEN: 'That GitHub account already opens a different PaperTok account.',
    'auth/cancelled-popup-request': 'The sign-in window was cancelled.',
    'auth/unauthorized-domain': 'This domain is not authorized for sign-in.',
    'auth/popup-blocked': 'The browser blocked the sign-in window.',
    'auth/popup-closed-by-user': 'The window was closed before sign-in was completed.',
    'auth/user-mismatch': 'You chose a different account in the sign-in window. Choose the account you use for PaperTok, then try again.',
    FEED_LOAD_FAILED: 'Papers could not be loaded. Check your connection and try again.',
    FOLLOWING_LOAD_FAILED: 'The content you follow could not be retrieved. Check your connection and try again.',
    ENTITY_LOAD_FAILED: 'This entity could not be loaded. Check your connection and try again.',
    PUBLICATIONS_LOAD_FAILED: 'Publications could not be loaded. Check your connection and try again.',
    PARTIAL_PUBLICATIONS_LOAD_FAILED: 'Some publications could not be loaded.',
    AUTHORS_LOAD_FAILED: 'Authors could not be loaded. Check your connection and try again.',
    PARTIAL_AUTHORS_LOAD_FAILED: 'Some authors could not be loaded.',
    LISTS_LOAD_FAILED: 'Your custom lists could not be updated.',
    LISTS_LOAD_STALLED: 'Your lists are taking unusually long. Still trying.',
    LIST_METADATA_LOAD_FAILED: 'Some metadata for this list could not be loaded.',
    PUBLIC_LIST_SYNC_FAILED: 'Your changes are saved, but the public link does not have them yet. It will retry when you open the list.',
    PUBLISH_UNREACHABLE: 'Your changes are saved. The public link will catch up when the connection is back.',
    PUBLISH_QUOTA_EXCEEDED: 'You have reached the daily limit for public link changes. The link will catch up tomorrow.',
    ACCOUNT_DELETION_FAILED: 'The account could not be deleted. Try again.',
    ACCOUNT_DELETION_UNREACHABLE: 'The account could not be deleted because the server could not be reached.',
    ACCOUNT_DELETION_NOT_CONFIGURED: 'Account deletion is not available right now.',
    AUTH_RECENT_LOGIN_REQUIRED: 'For security, deletion needs a recent sign-in. Try again and sign in when the window opens.',
    CONFIRMATION_REQUIRED: 'Confirm deletion from the settings dialog.',
    ACCOUNT_DELETION_UNSUPPORTED_IN_DEMO: 'Demo mode cannot delete a real account.',
    AUTH_PROVIDERS_UNSUPPORTED_IN_DEMO: 'Demo mode does not use real sign-in.',
    AUTH_REQUIRED: 'Sign in again, then retry.',
    INSTITUTION_STORAGE_UNAVAILABLE: 'Allow browser storage for PaperTok, then request a new verification link.',
    INSTITUTION_VERIFICATION_CANCELED: 'This request expired, was canceled, or belongs to another account or browser. Request a new link from your university settings.',
    'auth/expired-action-code': 'This verification link has expired. Request a new link.',
    'auth/invalid-action-code': 'This verification link is invalid or has already been used. Request a new link.',
    'auth/operation-not-allowed': 'Email verification is not available right now. Try again later.',
    'auth/too-many-requests': 'Too many verification attempts. Wait a while before requesting another link.',
    INSTITUTION_ACCOUNT_NOT_VERIFIED: 'Verify your PaperTok account email before requesting a university link.',
    INSTITUTION_VERIFICATION_LIMIT: 'Too many verification requests. Wait a minute before retrying. If the daily limit has been reached, try again tomorrow.',
    INSTITUTION_VERIFICATION_UNAVAILABLE: 'The verification email could not be sent. Try again later.',
    INSTITUTION_VERIFICATION_UNCERTAIN: 'We could not confirm delivery. Check your inbox before canceling this request and trying again.',
    INSTITUTION_EMAIL_INVALID: 'Enter a full email address, like name@university.edu.',
    INSTITUTION_EMAIL_MISMATCH: 'That verified address does not match your university email. Request a new link.',
    INSTITUTION_EMAIL_NOT_VERIFIED: 'Verify your university email before linking your institution.',
    INSTITUTION_NOT_FOUND: 'No institution is registered for that email domain.',
    INSTITUTION_LOOKUP_UNAVAILABLE: 'The institution registry could not be reached. Try again in a moment.',
    INSTITUTION_TOKEN_INVALID: 'This verification link is invalid or has already been used. Request a new link.',
    INSTITUTION_LINK_FAILED: 'Your institution could not be linked. Try again.',
    INSTITUTION_LINK_UNREACHABLE: 'Your institution could not be linked because the server could not be reached.',
    INSTITUTION_LINK_NOT_CONFIGURED: 'Institution linking is not available right now.',
    INSTITUTION_UNSUPPORTED_IN_DEMO: 'Demo mode cannot link an institution.',
  },
};

function errorCode(value: unknown) {
  if (typeof value === 'string') return value;
  return (value as { code?: string } | null | undefined)?.code || '';
}

export function getUiErrorMessage(value: unknown, fallbackCode = 'GENERAL_ERROR') {
  const messages: Record<string, string> = ERROR_MESSAGES['en'];
  const code = errorCode(value);
  return messages[code] || messages[fallbackCode] || messages.GENERAL_ERROR;
}

