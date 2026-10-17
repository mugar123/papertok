import type { Paper } from '../models/Paper.ts';

import type { mapUnpaywallResult } from '../services/unpaywallService.ts';
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
 * The Research hero still answered both, from its own copy of the tests, and
 * the two copies had already drifted: the card asked `publicationStatus`, the
 * hero asked `publicationStatus || publicationType`. Same paper, two answers.
 * One place, so the word on a card and the word on the report cannot disagree.
 */

/**
 * Peer review, as far as the record goes: 'preprint', 'verified', or null.
 *
 * The contract in `Paper.ts` keeps review and publication metadata optional.
 * If either `publicationStatus` or `publicationType` says preprint, the
 * record is treated as a preprint.
 *
 * Null when the record says nothing. Calling an unknown paper `Verified` is a
 * claim about peer review made from an empty field, and the reassuring
 * direction is the worse one to guess wrong in.
 */
export function reviewStatusForPaper(paper: Partial<Paper> | null | undefined) {
  if (!paper) return null;
  if (paper.publicationStatus === 'preprint' || paper.publicationType === 'preprint') {
    return 'preprint';
  }
  // A record that says outright it was not reviewed outranks every inference
  // drawn from the publication fields: a technical report is `published` and
  // typed, and a bulletin has a `journal`, and neither went through review.
  if (paper.peerReviewed === false) return null;
  if (paper.publicationStatus || paper.publicationType || paper.journal || paper.peerReviewed === true) {
    return 'verified';
  }
  return null;
}

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
  // contradict the button underneath it.
  if (openCopy || paper.openAccess === true || paper.openAccessPdfUrl || paper.arxivId) {
    return 'open';
  }
  if (paper.openAccess === false) return 'subscription';
  // A PDF link is also evidence of an accessible copy.
  if (paper.pdfUrl) return 'open';
  return null;
}

const REVIEW_TAGS = {
  preprint: {
    key: 'preprint',
    tone: 'amber',
    label: { en: 'Preprint' },
    hint: {
      en: 'Preprint: shared before peer review.',
    },
  },
  /* Sin entrada para 'verified', a propósito. El distintivo azul se retiró el
     12-09-2026: marcaba la norma, no la excepción. La mayoría de lo que se
     lee aquí ha pasado por revisión, así que el sello no informaba de nada y
     competía por la mirada con el título. `reviewStatusForPaper` sigue
     devolviendo 'verified' —es un hecho del registro y los filtros lo usan—,
     pero no hay distintivo que pintar: sólo la salvedad, el preprint. */
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
    label: { en: 'Subscription' },
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
 * `institutionAccess` is the reader's library's answer
 * (`findInstitutionAccess`), and `institutionLabel` the short name it is shown
 * under. Only `entitled` changes the chip, and never over a paper whose own
 * record is open: what anyone can read is still said first. A free copy found
 * elsewhere does not outrank it, because the button opens the library's
 * version of record first on such a paper (`paperOpenTargets.js`), and the
 * chip has to say what the button does. `unknown` and `not-entitled` leave
 * whatever the record said, because a library that could not answer has not
 * said the paper is paywalled.
 */
export function accessTagForPaper(paper: Partial<Paper> | null | undefined, { openCopy = null, institutionAccess = null, institutionLabel = '' }: { openCopy?: OpenCopy; institutionAccess?: { status?: string } | null; institutionLabel?: string } = {}) {
  const status = accessStatusForPaper(paper, { openCopy });
  if (accessStatusForPaper(paper) !== 'open' && institutionAccess?.status === 'entitled' && institutionLabel) {
    return {
      key: 'institution',
      tone: 'blue',
      label: `Via ${institutionLabel}`,
      hint: 'Your library gives you access to the published version.',
    };
  }
  if (!status) return null;
  // "Open version" says the published one is paid, which is false for a copy
  // that IS the published one.
  const weakerCopy = status === 'open' && openCopy && !isPublishedVersionCopy(openCopy);
  const tag = weakerCopy ? ACCESS_TAGS.openCopy : ACCESS_TAGS[status];
  return localize(tag);
}
