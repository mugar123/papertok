import type { Paper } from '../models/paper.ts';

import type { mapUnpaywallResult } from '../services/unpaywall-service.ts';
type OpenCopy = Partial<NonNullable<ReturnType<typeof mapUnpaywallResult>>> | null;

/**
 * What a card may honestly say about a paper: whether it has been through peer
 * review, and whether the reader can actually open it.
 *
 * Those are the two questions asked before deciding to read anything, and the
 * feed card had stopped answering either. Its status row rendered `Verified`
 * and `DOI` for published work and — because the whole row hung off
 * `{!isPreprint && …}` — *nothing at all* for a preprint, so the papers that
 * most needed the caveat were the only ones carrying no label. The access
 * chips had no JSX left anywhere; `.pc-chip--preprint` and `.pc-chip--open`
 * survived in the stylesheet as rules nothing rendered.
 *
 * The Research hero, since removed, answered both from its own copy of the
 * tests, and the two copies had already drifted: the card asked
 * `publicationStatus`, the hero asked `publicationStatus || publicationType`.
 * Same paper, two answers. One place, so no two screens can disagree.
 */

/**
 * Peer review, as far as the record goes: 'retracted', 'preprint',
 * 'workingPaper', 'verified', or null. A retraction outranks everything
 * else: a retracted preprint or journal article is first of all retracted.
 *
 * The contract in `paper.ts` keeps review and publication metadata optional.
 * If either `publicationStatus` or `publicationType` says preprint, the
 * record is treated as a preprint.
 *
 * Null when the record says nothing. Calling an unknown paper `Verified` is a
 * claim about peer review made from an empty field, and the reassuring
 * direction is the worse one to guess wrong in.
 */
export function reviewStatusForPaper(paper: Partial<Paper> | null | undefined) {
  if (!paper) return null;
  if (paper.publicationStatus === 'retracted') return 'retracted';
  if (paper.publicationStatus === 'preprint' || paper.publicationType === 'preprint') {
    return 'preprint';
  }
  // OpenAlex files an IMF or Fed working paper as a published journal article,
  // so without this the card looks the same as one from Nature.
  if (paper.workingPaper === true) return 'workingPaper';
  // A record that says outright it was not reviewed outranks every inference
  // drawn from the publication fields: a technical report is `published` and
  // typed, and a bulletin has a `journal`, and neither went through review.
  if (paper.peerReviewed === false) return null;
  if (paper.publicationStatus || paper.publicationType || paper.journal || paper.peerReviewed === true) {
    return 'verified';
  }
  return null;
}

// ChemRxiv's DOIs. ChemRxiv lets anyone read the preprints it posts (its FAQ:
// free for authors and readers), but OpenAlex called 89 of its 791 Chemistry
// preprints of the 90 days to 2026-10-27 closed, not only the newest, and none
// of 18 of them sampled, open or closed, has a licence in Crossref.
const CHEMRXIV_DOI = /^10\.26434\/chemrxiv/i;

/** Whether this is a ChemRxiv preprint's DOI, which resolves to a copy anyone can read. */
export const isChemRxivDoi = (doi: unknown) => CHEMRXIV_DOI.test(String(doi || ''));

/**
 * Whether the paper opens without a subscription: 'open', 'subscription', or
 * null when the record does not say.
 *
 * Null matters here too, in the other direction. The hero treated anything not
 * known to be open as paywalled, which turns a gap in the metadata into a claim
 * about a publisher — and not every adapter fills `openAccess`. A missing field
 * is not a locked door, so a paper with nothing to go on gets no chip rather
 * than a wrong one. Only an explicit `false` is a paywall.
 *
 * `openCopy` is what the open-access lookup found (`mapUnpaywallResult`): a free
 * copy of a paper whose own record did not show one.
 */
export function accessStatusForPaper(paper: Partial<Paper> | null | undefined, { openCopy = null }: { openCopy?: OpenCopy } = {}) {
  if (!paper) return null;
  // An arXiv id is evidence in its own right, and it outranks an explicit
  // `false`: OpenAlex reports `is_oa` for the *published* version, so a paper
  // that ran in a subscription journal reads as closed even while its arXiv
  // copy sits there free. The card links that copy; the chip should not
  // contradict the button underneath it. A ChemRxiv DOI outranks an explicit
  // `false` too, and the card links it as well (paper-open-targets.ts). It is
  // the paper's own DOI, so a journal article with a DOI of its own keeps its
  // own answer when it merges with its preprint (PaperBuilder.merge); one
  // without takes the preprint's DOI.
  if (openCopy || paper.openAccess === true || paper.openAccessPdfUrl || paper.arxivId || isChemRxivDoi(paper.doi)) {
    return 'open';
  }
  if (paper.openAccess === false) return 'subscription';
  // A PDF link is also evidence of an accessible copy.
  if (paper.pdfUrl) return 'open';
  return null;
}

const REVIEW_TAGS = {
  // The paper's own retraction, as its record states it (OpenAlex's
  // `is_retracted`, PubMed's `Retracted Publication`); it says nothing about
  // why, or about the authors. Amber, as the other caveats: the word and the
  // icon carry the meaning, not the colour.
  retracted: {
    key: 'retracted',
    tone: 'amber',
    label: { en: 'Retracted' },
    hint: {
      en: 'Retracted: the journal or publisher has withdrawn this paper.',
    },
  },
  preprint: {
    key: 'preprint',
    tone: 'amber',
    label: { en: 'Preprint' },
    hint: {
      en: 'Preprint: shared before peer review.',
    },
  },
  workingPaper: {
    key: 'workingPaper',
    tone: 'amber',
    label: { en: 'Working paper' },
    hint: {
      en: 'Working paper or report: issued without journal peer review.',
    },
  },
  /* No entry for 'verified', on purpose. The blue badge was retired on
     2026-09-12: it marked the norm, not the exception. Most of what is read
     here has been through review, so the badge said nothing and competed with
     the title for attention. `reviewStatusForPaper` still returns 'verified'
     (it is a fact of the record), but only the caveats get a tag: retracted,
     preprint and working paper. */
};

const ACCESS_TAGS = {
  open: {
    key: 'open',
    tone: 'green',
    label: { en: 'Open access' },
    hint: {
      en: 'Free to read in full.',
    },
  },
  // A weaker claim than open access, and worth saying differently: the
  // published version is paywalled, and what we found is a legal free copy of
  // it somewhere else.
  openCopy: {
    key: 'openCopy',
    tone: 'green',
    label: { en: 'Open version' },
    hint: {
      en: 'A free copy exists, though the published version is paywalled.',
    },
  },
  subscription: {
    key: 'subscription',
    tone: 'neutral',
    label: { en: 'Closed access' },
    hint: {
      en: 'The full text may require a subscription or payment.',
    },
  },
};

function localize(tag: { key: string; tone: string; label: { en: string }; hint: { en: string } }) {
  return {
    key: tag.key,
    tone: tag.tone,
    label: tag.label.en,
    hint: tag.hint.en,
  };
}

/** The peer-review chip for a paper, or null when there is nothing to flag. */
export function reviewTagForPaper(paper: Partial<Paper> | null | undefined) {
  const status = reviewStatusForPaper(paper);
  const tag = status ? REVIEW_TAGS[status as keyof typeof REVIEW_TAGS] : null;
  return tag ? localize(tag) : null;
}

/**
 * Whether a found copy is the published article itself, free at the publisher
 * (gold, hybrid or bronze), rather than some other version of it. Unpaywall
 * leaves `version` out for bronze copies, and the publisher's page is still
 * the article.
 */
export function isPublishedVersionCopy(copy: OpenCopy) {
  return copy?.hostType === 'publisher' && (!copy.version || copy.version === 'publishedVersion');
}

/**
 * The availability chip for a paper, or null when the record cannot say.
 *
 * The reader's library is not in here on purpose: what anyone can read is
 * what the chip says, and the way in through a library is the button's to
 * name (`PaperCard`), since the button is what goes through it.
 */
export function accessTagForPaper(paper: Partial<Paper> | null | undefined, { openCopy = null }: { openCopy?: OpenCopy } = {}) {
  const status = accessStatusForPaper(paper, { openCopy });
  if (!status) return null;
  // "Open version" says the published one is paid, which is false for a copy
  // that IS the published one.
  const weakerCopy = status === 'open' && openCopy && !isPublishedVersionCopy(openCopy);
  const tag = weakerCopy ? ACCESS_TAGS.openCopy : ACCESS_TAGS[status];
  return localize(tag);
}
