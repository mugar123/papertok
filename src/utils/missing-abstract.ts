import type { Paper } from '../models/paper.ts';
import { safeDoiUrl } from './external-url.ts';

/** What a card shows, and its status region says, when no abstract arrived. */
export const MISSING_ABSTRACT_TITLE = 'No abstract to show';

/**
 * What a card says in place of an abstract it does not have, once nothing is
 * still loading one, and the publisher's page it can link.
 *
 * PaperTok knows only that the open sources it read had no abstract for the
 * paper. The publisher may keep the abstract out of those sources, or a
 * source may add it later, so the words describe what was read and never
 * say the paper has no abstract.
 *
 * The link is the DOI's, which resolves to the publisher's page.
 * `landingPageUrl` is not used: for many records it is an index's page
 * (PubMed, ADS, an OpenAlex work), and calling it the publisher's would be
 * false. Without a DOI the card links nothing.
 */
export function missingAbstractNotice(paper: Pick<Paper, 'doi'>) {
  return {
    title: MISSING_ABSTRACT_TITLE,
    body: 'The open sources PaperTok reads had none.',
    publisherUrl: safeDoiUrl(paper.doi) || null,
  };
}
