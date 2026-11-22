// The versions of the welcome's weekly-email text a reader can have said yes
// to. The Worker imports this file, so it holds constants only: nothing here
// may touch storage, `window` or the DOM.

/** The welcome text "Mondays, when there are new papers in the topics you chose. Unsubscribe anytime." */
export const DIGEST_CONSENT_FROM_SIGNUP = 'topics-from-signup-1';
/** A yes given under the earlier text, "Starts with your first follow. Unsubscribe anytime.", which carries no stamp. */
export const DIGEST_CONSENT_FIRST_FOLLOW = 'first-follow-1';
/** What `POST /notifications/opt-in` accepts. Anything else is refused, never read as the new promise. */
export const DIGEST_OPT_IN_CONSENTS: readonly string[] = [DIGEST_CONSENT_FROM_SIGNUP, DIGEST_CONSENT_FIRST_FOLLOW];
