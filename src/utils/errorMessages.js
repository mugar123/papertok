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
    FEED_LOAD_FAILED: 'Papers could not be loaded. Check your connection and try again.',
    FOLLOWING_LOAD_FAILED: 'The content you follow could not be retrieved. Check your connection and try again.',
    ENTITY_LOAD_FAILED: 'This entity could not be loaded. Check your connection and try again.',
    PUBLICATIONS_LOAD_FAILED: 'Publications could not be loaded. Check your connection and try again.',
    PARTIAL_PUBLICATIONS_LOAD_FAILED: 'Some publications could not be loaded.',
    AUTHORS_LOAD_FAILED: 'Authors could not be loaded. Check your connection and try again.',
    PARTIAL_AUTHORS_LOAD_FAILED: 'Some authors could not be loaded.',
    REPORT_LOAD_FAILED: 'The edition could not be loaded. Try again.',
    LISTS_LOAD_FAILED: 'Your custom lists could not be updated.',
    LISTS_LOAD_STALLED: 'Your lists are taking unusually long. Still trying.',
    LIST_METADATA_LOAD_FAILED: 'Some metadata for this list could not be loaded.',
    PUBLIC_LIST_SYNC_FAILED: 'Your changes are saved, but the public link does not have them yet. It will retry when you open the list.',
    PUBLISH_UNREACHABLE: 'Your changes are saved. The public link will catch up when the connection is back.',
    PUBLISH_QUOTA_EXCEEDED: 'You have reached the daily limit for public link changes. The link will catch up tomorrow.',
    PROFILE_PHOTO_SAVE_FAILED: 'The profile photo could not be saved.',
    PROFILE_PHOTO_WRITE_TIMEOUT: 'The photo was not saved in time. Check your connection and try again.',
    ACCOUNT_DELETION_FAILED: 'The account could not be deleted. Try again.',
    ACCOUNT_DELETION_UNREACHABLE: 'The account could not be deleted because the server could not be reached.',
    ACCOUNT_DELETION_NOT_CONFIGURED: 'Account deletion is not available right now.',
    AUTH_RECENT_LOGIN_REQUIRED: 'For security, sign in again and then request deletion.',
    CONFIRMATION_REQUIRED: 'Confirm deletion from the settings dialog.',
    ACCOUNT_DELETION_UNSUPPORTED_IN_DEMO: 'Demo mode cannot delete a real account.',
  },
};

function errorCode(value) {
  if (typeof value === 'string') return value;
  return value?.code || '';
}

export function getUiErrorMessage(value, fallbackCode = 'GENERAL_ERROR') {
  const messages = ERROR_MESSAGES['en'];
  const code = errorCode(value);
  return messages[code] || messages[fallbackCode] || messages.GENERAL_ERROR;
}

