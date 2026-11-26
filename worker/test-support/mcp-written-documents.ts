// The Firestore documents the MCP write tools make, as two suites state them.
// worker/mcp-server.test.ts asserts the Worker writes exactly these, and
// tests/firestore.rules.test.ts that their owner can read, change and delete
// them under `firestore.rules`: the Worker writes with the service account,
// which passes no rule. Test-only, and synthetic.

export const WRITTEN_AT = '2026-10-24T12:00:00.000Z';

/** A list from `create_list`. `createdAt` is the string the app writes; `updatedAt` a timestamp. */
export const writtenList = (id: string) => ({
  id,
  name: 'Strained graphene',
  emoji: 'Folder',
  paperIds: ['openalex:W4400000001', '2603.01234', 'openalex:W77'],
  createdAt: WRITTEN_AT,
  updatedAt: new Date(WRITTEN_AT),
});

/** The saved copy of a paper OpenAlex answered for, under `savedPapers/openalex:W4400000001`. */
export const WRITTEN_OPENALEX_COPY = {
  title: 'Graphene sheets under strain',
  authors: ['Ana Pérez', 'Luis Gómez', 'Rosa Díaz', 'Mei Chen'],
  primaryCategory: '',
  categories: ['Graphene and two-dimensional materials', 'Strain engineering', 'Carbon nanotubes', 'Thin films'],
  primaryTopic: { id: 'https://openalex.org/T10002', display_name: 'Strain engineering' },
  classificationVersion: 1,
  published: '2026-03-02',
  doi: '10.1234/example.2026.1',
  landingPageUrl: 'https://doi.org/10.1234/example.2026.1',
};

/** The saved copy of a paper arXiv answered for, under `savedPapers/2603.01234`. */
export const WRITTEN_ARXIV_COPY = {
  title: 'Strained graphene in the lab',
  authors: ['Luis Gómez'],
  primaryCategory: 'cond-mat.mes-hall',
  categories: ['cond-mat.mes-hall'],
  classificationVersion: 1,
  published: '2026-03-01T10:00:00.000Z',
  arxivId: '2603.01234',
  summary: 'We bend graphene and measure it.',
  landingPageUrl: 'https://arxiv.org/abs/2603.01234',
};

/**
 * The saved copy of the same preprint when OpenAlex answered for arXiv: filed
 * under the arXiv id, with OpenAlex's topic and no arXiv category, which that
 * record does not give.
 */
export const WRITTEN_FALLBACK_COPY = {
  title: 'Strained graphene in the lab',
  authors: ['Ana Pérez'],
  primaryCategory: '',
  categories: [],
  primaryTopic: { id: 'https://openalex.org/T10002', display_name: 'Strain engineering' },
  classificationVersion: 1,
  published: '2026-03-02',
  arxivId: '2603.01234',
  landingPageUrl: 'https://arxiv.org/abs/2603.01234',
};

export const WRITTEN_FEED_INGREDIENTS = [
  { kind: 'topic', id: 'T10002', label: 'Strain engineering' },
  { kind: 'topic', id: 'T10001', label: 'Graphene and two-dimensional materials' },
  { kind: 'topic', id: 'T10003', label: 'Carbon nanotubes' },
];

/** The feeds document after `create_feed` made an account's first feed. */
export const writtenFeeds = (id: string) => ({
  feeds: [{ id, name: 'Strain', order: 'newest', ingredients: WRITTEN_FEED_INGREDIENTS }],
  updatedAt: new Date(WRITTEN_AT),
});
