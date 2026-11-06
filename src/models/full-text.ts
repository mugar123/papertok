export type FullTextSource = 'arxiv' | 'ar5iv' | 'europepmc';

/** What the Worker's `/resources/full-text` answers: a paper's source document, unparsed. */
export type FullTextAnswer = {
  source: FullTextSource | null;
  format: 'latexml' | 'jats' | null;
  url: string | null;
  fullTextId?: string;
  license?: string;
  document: string | null;
  /** A provider failed, so the absence of text is not established. */
  unavailable?: true;
};
