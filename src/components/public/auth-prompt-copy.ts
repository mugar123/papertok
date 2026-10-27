/**
 * What the sign-in dialog says, by the reason it was opened for.
 *
 * It used to have one text for every door: a guest who pressed «Leer en
 * simple» — the thing the welcome sheet promises — was told to «Da me gusta,
 * guarda y sigue investigación», with no word about why the button had asked
 * for an account (audit 2026-09-23, issues 2, 9 and 10). A reason is one of
 * the keys below; anything else — a click event handed over by an
 * `onClick={requestAuthentication}`, a paper handed over by `onSaveToList` —
 * opens the general door. «Read in plain words» opens it too:
 * its reason, `paper_rewrite`, is no longer a key.
 */
const COPY = Object.freeze({
  default: {
    en: {
      title: 'Join PaperTok',
      lede: 'Like and save papers, follow authors, and get a feed that learns what you read.',
    },
  },
  related: {
    en: {
      title: 'Connections need an account',
      lede: 'Like and save papers, follow authors, and get a feed that learns what you read.',
    },
  },
  explorer_search: {
    en: {
      title: 'Search and filters need an account',
      lede: 'Like and save papers, follow authors, and get a feed that learns what you read.',
    },
  },
});

export function normalizeAuthReason(value: unknown) {
  return typeof value === 'string' && Object.hasOwn(COPY, value) ? value as keyof typeof COPY : 'default';
}

// The prompt-view event for a dialog mount, or null when the mount is the
// sign-in a redirect return restored: that reader opened sign-in once already.
export function authPromptViewParams(reason: unknown, restored: boolean) {
  return restored ? null : { surface: 'auth_prompt', reason: normalizeAuthReason(reason) };
}

export function authPromptCopy(reason: unknown) {
  return COPY[normalizeAuthReason(reason)]['en'];
}
