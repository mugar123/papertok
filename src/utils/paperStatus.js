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
 * `openCopyFound` is the Unpaywall lookup landing: a free copy of a paper whose
 * published version is behind a subscription.
 */
export function accessStatusForPaper(paper, { openCopyFound = false } = {}) {
  if (!paper) return null;
  // An arXiv id is evidence in its own right, and it outranks an explicit
  // `false`: OpenAlex reports `is_oa` for the *published* version, so a paper
  // that ran in a subscription journal reads as closed even while its arXiv
  // copy sits there free. The card links that copy; the chip should not
  // contradict the button underneath it.
  if (openCopyFound || paper.openAccess === true || paper.openAccessPdfUrl || paper.arxivId) {
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
    label: { es: 'Preprint', en: 'Preprint' },
    hint: {
      es: 'Preprint: difundido antes de pasar por revisión por pares.',
      en: 'Preprint: shared before peer review.',
    },
  },
  verified: {
    key: 'verified',
    tone: 'blue',
    label: { es: 'Verificado', en: 'Verified' },
    hint: {
      es: 'Publicado en una revista o congreso con revisión por pares.',
      en: 'Published in a peer-reviewed journal or conference.',
    },
  },
};

const ACCESS_TAGS = {
  open: {
    key: 'open',
    tone: 'green',
    label: { es: 'Acceso abierto', en: 'Open access' },
    hint: {
      es: 'Se puede leer entero sin suscripción.',
      en: 'Free to read in full.',
    },
  },
  // A weaker claim than open access, and worth saying differently: the
  // published version is paywalled, and what we found is a legal free copy of
  // it somewhere else.
  openCopy: {
    key: 'openCopy',
    tone: 'green',
    label: { es: 'Versión abierta', en: 'Open version' },
    hint: {
      es: 'Existe una copia libre, aunque la versión publicada sea de pago.',
      en: 'A free copy exists, though the published version is paywalled.',
    },
  },
  subscription: {
    key: 'subscription',
    tone: 'neutral',
    label: { es: 'Suscripción', en: 'Subscription' },
    hint: {
      es: 'El texto completo puede requerir suscripción o pago.',
      en: 'The full text may require a subscription or payment.',
    },
  },
};

function localize(tag, english) {
  return {
    key: tag.key,
    tone: tag.tone,
    label: english ? tag.label.en : tag.label.es,
    hint: english ? tag.hint.en : tag.hint.es,
  };
}

/** The peer-review chip for a paper, or null when the record cannot say. */
export function reviewTagForPaper(paper, { english = false } = {}) {
  const status = reviewStatusForPaper(paper);
  return status ? localize(REVIEW_TAGS[status], english) : null;
}

/** The availability chip for a paper, or null when the record cannot say. */
export function accessTagForPaper(paper, { english = false, openCopyFound = false } = {}) {
  const status = accessStatusForPaper(paper, { openCopyFound });
  if (!status) return null;
  const tag = status === 'open' && openCopyFound ? ACCESS_TAGS.openCopy : ACCESS_TAGS[status];
  return localize(tag, english);
}
