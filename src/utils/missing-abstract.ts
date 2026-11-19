import type { Paper } from '../models/paper.ts';
import { safeDoiUrl } from './external-url.ts';

/** What a card shows, and its status region says, when no abstract arrived. */
export const MISSING_ABSTRACT_TITLE = 'No abstract to show';

/**
 * What a card says in place of an abstract it does not have, once nothing is
 * still loading one, and the publisher's page it can link.
 *
 * The words say what PaperTok did, that it found none in open sources, and
 * never that the paper has none. The publisher may keep the abstract out of
 * those sources, a source may add it later, and a lookup that failed or has
 * not run ends in the same state.
 *
 * The link is the DOI's, which resolves to the publisher's page.
 * `landingPageUrl` is not used: for many records it is an index's page
 * (PubMed, ADS, an OpenAlex work), and calling it the publisher's would be
 * false. Without a DOI the card links nothing.
 *
 * The link is not part of the sentence. The sentence is in the abstract's
 * panel, the first row of the card to give up its height, and under a long
 * title on a phone on its side that panel is 0px tall. `publisher` is a
 * control of the card's action row, which keeps its height: `label` is its
 * label and starts its name, and `short` is the word a phone has room for.
 * `body` names it.
 */
export function missingAbstractNotice(paper: Pick<Paper, 'doi'>) {
  const url = safeDoiUrl(paper.doi);
  return {
    title: MISSING_ABSTRACT_TITLE,
    body: url ? "PaperTok found none in open sources. Try the publisher's page." : 'PaperTok found none in open sources.',
    publisher: url ? { label: "Publisher's page", short: 'Publisher', url } : null,
  };
}
