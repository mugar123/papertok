import type { Paper } from '../models/paper.ts';
import { storedAbstractSource, storedClassification } from '../models/paper.ts';

/**
 * The document written to `users/{uid}/savedPapers/{paperId}`.
 *
 * This is a pure function because the shape is a contract with `firestore.rules`
 * and nothing was checking that the two agreed. They did not.
 *
 * The rules accept an optional field that is ABSENT (`!('summary' in data)`) and
 * refuse one that is `null` — except for `doi` and `landingPageUrl`, which carry
 * an explicit `== null` escape. The save modal wrote `null` for every absent
 * field, reasoning that Firestore rejects `undefined`. Both statements are true
 * and together they are a bug: a paper with no abstract, or no authors, had its
 * write REFUSED.
 *
 * That refusal was invisible and permanent. The modal added the paper's id to
 * the list first and wrote this document second, so a refused write left the id
 * sitting in `paperIds` with nothing behind it — a row that renders as a bare
 * arXiv id, forever, because no later read can conjure a document that was never
 * written. Two of them were still on screen weeks later.
 *
 * `markSaved` in FeedContext already writes its interaction record this way —
 * `if (paper?.title) data.paperTitle = ...` — so the pattern was in the
 * codebase; it just was not here.
 */

/** Absent, empty and blank are all "we do not have this". */
const text = (value: unknown, max: number|undefined) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
};

/**
 * Builds the payload, omitting what is not known rather than nulling it.
 *
 * `savedAt` is the caller's, so this stays pure and its tests do not have to
 * freeze the clock.
 */
export function buildSavedPaperPayload<T>(paper: Partial<Paper> | null | undefined, savedAt: T) {
  const payload: Partial<Paper> & { savedAt: T } = { savedAt };

  /**
   * `title` is the one field the rules REQUIRE, with no absent-or-null escape,
   * and refusing the write is the worst possible answer: the id is going into a
   * list either way, and a list entry with no document is exactly what this
   * function exists to prevent.
   *
   * So an untitled paper is stored under its own id. That is not a title and
   * does not pretend to be one — every reader in the app already treats
   * `title === id` as "no title yet" — but it is a document, which means the
   * entry is repairable instead of orphaned.
   */
  const title = text(paper?.title, 1000);
  payload.title = title ?? String(paper?.id ?? '').trim();

  const authors = Array.isArray(paper?.authors)
    ? paper.authors.filter(entry => typeof entry === 'string' && entry.trim()).slice(0, 5)
    : [];
  if (authors.length > 0) payload.authors = authors;

  // The same classification an interaction's copy keeps, so a saved paper
  // reads as the field its card showed (PAP-60). Both writers merge into the
  // stored document, so the category and its list are sent even when empty:
  // left out, a document saved before PAP-60 kept the category the feed had
  // asked for, and it was read as evidence under this classificationVersion.
  // A stored topic stays when the card has none. Only OpenAlex fills it, for
  // this same work, and removing it would take away a field the copy shows.
  const classification = storedClassification(paper || {});
  payload.primaryCategory = text(classification.primaryCategory, 300) ?? '';
  payload.categories = classification.categories;
  if (classification.primaryTopic) payload.primaryTopic = classification.primaryTopic;
  payload.classificationVersion = classification.classificationVersion;

  const published = text(paper?.published, 300);
  if (published) payload.published = published;

  const arxivId = text(paper?.arxivId, 300);
  if (arxivId) payload.arxivId = arxivId;

  // The rules cap it at 1000; the app has always stored 500. The source a card
  // credits for that text comes with it (ENG-109); the rules accept only the
  // two sources a card credits.
  const summary = text(paper?.summary, 500) ?? text(paper?.abstract, 500);
  if (summary) payload.summary = summary;
  const abstractSource = storedAbstractSource(paper || {}, summary);
  if (abstractSource) payload.abstractSource = abstractSource;

  const doi = text(paper?.doi, 300);
  if (doi) payload.doi = doi;

  const landingPageUrl = text(paper?.landingPageUrl, 2000);
  if (landingPageUrl) payload.landingPageUrl = landingPageUrl;

  return payload;
}
