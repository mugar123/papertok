/**
 * How a comment names its author after the account is gone.
 *
 * The privacy policy keeps threads intact by default: the text stays, the
 * profile does not. `dissociated: true` is the durable signal — an empty
 * handle on its own could be a half-written row, and a sentinel handle would
 * be claimable the day reserved-name lists drift.
 */

export const DISSOCIATED_COMMENT_FIELDS = Object.freeze({
  authorUid: '',
  authorHandle: '',
  dissociated: true,
});

export function commentIsDissociated(comment) {
  return comment?.dissociated === true;
}
