import type { FollowEntity } from '../../utils/following.ts';
import { hasDigestFollows } from '../../services/email-notification-service.ts';

/**
 * What the email settings say when nothing the reader follows feeds the
 * weekly digest, or null when something does. Journals are followed but not
 * in the digest (ENG-123, D6), so a reader who follows only journals is told
 * that, not that they follow nothing. A reader with chosen categories is
 * told the email is filled from them instead.
 */
export function emailFollowsNotice(follows: readonly Partial<FollowEntity>[], digestPending: boolean, hasInterests = false) {
  if (hasDigestFollows(follows)) return null;
  // ENG-163: the reader's chosen categories fill the email until then.
  if (hasInterests) {
    return {
      heading: 'Your email covers your interests',
      body: 'Until you follow a topic, author, institution or project, the weekly email brings notable new papers in the subjects you chose.',
    };
  }
  if (follows.length) {
    return {
      heading: 'Journals are not in the email yet',
      body: 'The weekly email lists new papers from the topics, authors, institutions and projects you follow. Follow one of them to get it.',
    };
  }
  return {
    heading: 'Nothing followed yet',
    body: digestPending
      ? 'You asked for the digest when you joined. It starts on its own with your first follow: a topic, author, institution, or project.'
      : 'Follow a topic, author or institution to get updates.',
  };
}
