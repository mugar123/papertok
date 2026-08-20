/**
 * The words the visibility choice uses, in one place because two screens show
 * them: the choice itself (create form and one-time prompt) and the privacy
 * section of the editor, which has to repeat the same caveats next to the
 * switches. Kept out of the component file so the component module exports
 * only a component.
 */

export function visibilityCopy(isEnglish) {
  return isEnglish ? {
    legend: 'Who can see your profile?',
    publicTitle: 'Public profile',
    publicBody: 'Anyone with the link sees your name, bio and pinned lists. Your profile can be followed, and it appears when signed-in people search for users by handle or name.',
    privateTitle: 'Private profile',
    privateBody: 'Only you see your profile. Its page does not open for anyone else, signed in or not, and you do not appear in the user search.',
    notProtectedTitle: 'What going private does not cover',
    notProtected: [
      'Lists you already published stay public and reachable by their link — going private removes your name from them, not the lists. You unpublish them in My lists.',
      'Your handle stays reserved, so nobody else can take it — which also means it stays possible to tell that the handle exists.',
      'The number of people following you stays countable.',
    ],
    changeLater: 'You can change this whenever you want, in Settings.',
  } : {
    legend: '¿Quién puede ver tu perfil?',
    publicTitle: 'Perfil público',
    publicBody: 'Cualquiera con el enlace ve tu nombre, tu biografía y tus listas fijadas. Tu perfil se puede seguir y aparece cuando alguien con sesión busca usuarios por handle o por nombre.',
    privateTitle: 'Perfil privado',
    privateBody: 'Solo tú ves tu perfil. Su página no se abre para nadie más, con sesión o sin ella, y no apareces en la búsqueda de usuarios.',
    notProtectedTitle: 'Lo que ser privado no cubre',
    notProtected: [
      'Las listas que ya publicaste siguen siendo públicas y accesibles por su enlace — ser privado les quita tu nombre, no las retira. Se despublican en Mis listas.',
      'Tu handle sigue reservado, así que nadie más puede cogerlo — lo que también significa que se puede saber que ese handle existe.',
      'El número de personas que te siguen se puede seguir contando.',
    ],
    changeLater: 'Puedes cambiarlo cuando quieras, en Ajustes.',
  };
}
