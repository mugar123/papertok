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
 * `publicationType` is the authoritative field — `Paper.js` documents
 * `peerReviewed` as `publicationType !== 'preprint'` — but OpenAlex fills
 * `publicationStatus` from whether any location claims to be published, and a
 * work can be typed `article` while every copy of it is still a preprint. If
 * either says preprint, it is one.
 *
 * Null when the record says nothing. Calling an unknown paper `Verified` is a
 * claim about peer review made from an empty field, and the reassuring
 * direction is the worse one to guess wrong in.
 */
export function reviewStatusForPaper(paper) {
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
export function accessStatusForPaper(paper, { openCopy = null } = {}) {
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
  // `pdfUrl` is only ever set for a copy that can be fetched — `Paper.js`:
  // "Enlace directo al PDF si existe y es Open Access".
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

function localize(tag) {
  return {
    key: tag.key,
    tone: tag.tone,
    label: tag.label.en,
    hint: tag.hint.en,
  };
}

/** The peer-review chip for a paper, or null when there is nothing to flag. */
export function reviewTagForPaper(paper) {
  const status = reviewStatusForPaper(paper);
  const tag = status ? REVIEW_TAGS[status] : null;
  return tag ? localize(tag) : null;
}

/**
 * Whether a found copy is the published article itself, free at the publisher
 * (gold, hybrid or bronze), rather than some other version of it. Unpaywall
 * leaves `version` out for bronze copies, and the publisher's page is still
 * the article.
 */
export function isPublishedVersionCopy(copy) {
  return copy?.hostType === 'publisher' && (!copy.version || copy.version === 'publishedVersion');
}

/** The availability chip for a paper, or null when the record cannot say. */
export function accessTagForPaper(paper, { openCopy = null } = {}) {
  const status = accessStatusForPaper(paper, { openCopy });
  if (!status) return null;
  // "Open version" says the published one is paid, which is false for a copy
  // that IS the published one.
  const weakerCopy = status === 'open' && openCopy && !isPublishedVersionCopy(openCopy);
  const tag = weakerCopy ? ACCESS_TAGS.openCopy : ACCESS_TAGS[status];
  return localize(tag);
}
