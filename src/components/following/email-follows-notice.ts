import type { FollowEntity } from '../../utils/following.ts';
import { hasDigestFollows } from '../../services/email-notification-service.ts';

/**
 * What the email settings say when the reader follows nothing the weekly
 * digest is built from, or null when they do. A reader with chosen
 * categories is told the email is filled from them instead.
 */
export function emailFollowsNotice(follows: readonly Partial<FollowEntity>[], digestPending: boolean, hasInterests = false, hasCitationSource = false) {
  if (hasDigestFollows(follows)) return null;
  if (hasCitationSource) {
    return {
      heading: 'Cited your work',
      body: 'Turn on email updates to receive new papers that cite your work, based on your connected ORCID iD.',
    };
  }
  // ENG-163: the reader's chosen categories fill the email until then. A yes
  // from the welcome still waits for the first follow, as the welcome said.
  if (hasInterests && !digestPending) {
    return {
      heading: 'Your email covers your interests',
      body: 'Until you follow a topic, author, institution or project, the weekly email brings notable new papers in the subjects you chose.',
    };
  }
  return {
    heading: 'Nothing followed yet',
    body: digestPending
      ? 'You asked for the digest when you joined. It starts on its own with your first follow: a topic, author, institution, or project.'
      : 'Follow a topic, author or institution to get updates.',
  };
}
