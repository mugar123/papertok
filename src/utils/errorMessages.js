const ERROR_MESSAGES = {
  es: {
    GENERAL_ERROR: 'Ha ocurrido un error inesperado. Inténtalo de nuevo.',
    CONNECTION_ERROR: 'Comprueba tu conexión e inténtalo de nuevo.',
    PROFILE_LOAD_FAILED: 'No se pudo recuperar tu perfil. Comprueba la conexión e inténtalo de nuevo.',
    AUTH_FAILED: 'No se pudo iniciar sesión. Inténtalo de nuevo.',
    AUTH_LINK_FAILED: 'No se pudo conectar ese método de acceso. Inténtalo de nuevo.',
    AUTH_EMAIL_ALREADY_USED: 'Ese correo ya entra en PaperTok por otro método. Usa el que ya tienes y conecta GitHub desde Ajustes.',
    AUTH_IDENTITY_TAKEN: 'Esa cuenta de GitHub ya abre otra cuenta de PaperTok.',
    'auth/cancelled-popup-request': 'Se canceló la ventana de inicio de sesión.',
    'auth/unauthorized-domain': 'Este dominio no está autorizado para iniciar sesión.',
    'auth/popup-blocked': 'El navegador ha bloqueado la ventana de inicio de sesión.',
    'auth/popup-closed-by-user': 'Se cerró la ventana antes de completar el inicio de sesión.',
    FEED_LOAD_FAILED: 'No se pudieron cargar los papers. Comprueba tu conexión e inténtalo de nuevo.',
    FOLLOWING_LOAD_FAILED: 'No se pudieron consultar tus seguimientos. Comprueba tu conexión e inténtalo de nuevo.',
    ENTITY_LOAD_FAILED: 'No se pudo cargar esta entidad. Comprueba tu conexión e inténtalo de nuevo.',
    PUBLICATIONS_LOAD_FAILED: 'No se pudieron cargar las publicaciones. Comprueba tu conexión e inténtalo de nuevo.',
    PARTIAL_PUBLICATIONS_LOAD_FAILED: 'No se pudieron cargar algunas publicaciones.',
    AUTHORS_LOAD_FAILED: 'No se pudieron cargar los autores. Comprueba tu conexión e inténtalo de nuevo.',
    PARTIAL_AUTHORS_LOAD_FAILED: 'No se pudieron cargar algunos autores.',
    REPORT_LOAD_FAILED: 'No se pudo cargar la edición. Inténtalo de nuevo.',
    LISTS_LOAD_FAILED: 'No se pudieron actualizar tus listas personalizadas.',
    LIST_METADATA_LOAD_FAILED: 'No se pudieron cargar todos los datos de esta lista.',
    // P25: the public copy is rebuilt in the background, so its failures are
    // never "your edit was lost" — the edit is safe in Firestore and the list
    // stays marked dirty until a later open reconciles it.
    PUBLIC_LIST_SYNC_FAILED: 'Tus cambios están guardados, pero el enlace público aún no los tiene. Se reintentará al abrir la lista.',
    PUBLISH_UNREACHABLE: 'Tus cambios están guardados. El enlace público se pondrá al día cuando vuelva la conexión.',
    PUBLISH_QUOTA_EXCEEDED: 'Has llegado al límite diario de cambios en enlaces públicos. El enlace se pondrá al día mañana.',
    PROFILE_PHOTO_SAVE_FAILED: 'No se pudo guardar la foto de perfil.',
  },
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
    LIST_METADATA_LOAD_FAILED: 'Some metadata for this list could not be loaded.',
    PUBLIC_LIST_SYNC_FAILED: 'Your changes are saved, but the public link does not have them yet. It will retry when you open the list.',
    PUBLISH_UNREACHABLE: 'Your changes are saved. The public link will catch up when the connection is back.',
    PUBLISH_QUOTA_EXCEEDED: 'You have reached the daily limit for public link changes. The link will catch up tomorrow.',
    PROFILE_PHOTO_SAVE_FAILED: 'The profile photo could not be saved.',
  },
};

function errorCode(value) {
  if (typeof value === 'string') return value;
  return value?.code || '';
}

export function getUiErrorMessage(value, language = 'es', fallbackCode = 'GENERAL_ERROR') {
  const messages = ERROR_MESSAGES[language === 'en' ? 'en' : 'es'];
  const code = errorCode(value);
  return messages[code] || messages[fallbackCode] || messages.GENERAL_ERROR;
}

