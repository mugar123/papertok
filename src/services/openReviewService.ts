import type { Paper } from '../models/Paper.ts';
export interface OpenReviewNote { content?: Record<string, unknown>; forum?: string; id?: string; domain?: string; pdate?: number; cdate?: number; tcdate?: number; }

import { PaperBuilder } from './PaperBuilder.ts';

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return value.value;
  }
  return value;
}

function text(value: unknown) {
  return String(unwrap(value) || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function list(value: unknown) {
  const unwrapped = unwrap(value);
  return (Array.isArray(unwrapped) ? unwrapped : [unwrapped])
    .map(item => text(item))
    .filter(Boolean);
}

function normalizeDoi(value: unknown) {
  return text(value).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
}

function extractArxivId(content: Record<string, unknown>, pdfUrl: string) {
  const candidates = [
    unwrap(content?.arxiv),
    unwrap(content?.arxiv_id),
    unwrap(content?.external_id),
    pdfUrl,
  ];
  for (const candidate of candidates) {
    const match = String(candidate || '').match(/(?:arxiv(?:\.org\/(?:abs|pdf)\/|:))?((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)/i);
    if (match) return match[1].replace(/\.pdf$/i, '');
  }
  return '';
}

function absoluteOpenReviewUrl(value: unknown, fallback: string) {
  const candidate = text(value);
  if (!candidate) return fallback;
  try {
    return new URL(candidate, 'https://openreview.net').toString();
  } catch {
    return fallback;
  }
}

function publicationDetails(venue: string, venueId: string): Pick<Paper, 'publicationStatus' | 'publicationType' | 'peerReviewed'> {
  const combined = `${venue} ${venueId}`.toLowerCase();
  const rejected = /rejected|withdrawn|desk[-_ ]rejected|submitted/.test(combined);
  const accepted = !rejected && /accepted|published|oral|poster|spotlight/.test(combined);
  if (!accepted) {
    return { publicationStatus: 'preprint', publicationType: 'preprint', peerReviewed: false };
  }
  const publicationType = /tmlr|journal|transactions/.test(combined) ? 'journal' : 'conference';
  return { publicationStatus: 'published', publicationType, peerReviewed: true };
}

function timestampToIso(...values: unknown[]) {
  for (const value of values) {
    if (!value) continue;
    const date = new Date(typeof value === 'number' ? value : String(value));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return '';
}

export function mapOpenReviewNote(note: OpenReviewNote, requestedCategories: string[] = []): Paper | null {
  const content = note?.content || {};
  const title = text(content.title);
  const abstract = text(content.abstract);
  const openReviewId = text(note?.forum || note?.id);
  if (!title || !openReviewId) return null;

  const venue = text(content.venue) || text(note?.domain);
  const venueId = text(content.venueid) || text(note?.domain);
  const publication = publicationDetails(venue, venueId);
  const fallbackUrl = `https://openreview.net/forum?id=${encodeURIComponent(openReviewId)}`;
  const pdfUrl = absoluteOpenReviewUrl(content.pdf, '');
  const arxivId = extractArxivId(content, pdfUrl);
  const doi = normalizeDoi(content.doi);
  const keywords = [...new Set(list(content.keywords))];
  const published = timestampToIso(note?.pdate, note?.cdate, note?.tcdate);
  const authorNames = list(content.authors);
  const authorIds = list(content.authorids);

  return PaperBuilder.create({
    id: doi || (arxivId ? `arxiv:${arxivId}` : `openreview:${openReviewId}`),
    sources: { primary: 'openreview', enrichedBy: [] },
    title,
    abstract,
    authors: authorNames.map((name, index) => ({
      name,
      ...(authorIds[index] ? { id: authorIds[index] } : {}),
      ...(authorIds[index]?.includes('orcid.org/') ? { orcid: authorIds[index].split('/').pop() } : {}),
    })),
    doi: doi || undefined,
    arxivId: arxivId || undefined,
    openReviewId,
    openReviewUrl: fallbackUrl,
    openReviewVenueId: venueId || undefined,
    conference: venue || undefined,
    year: published ? new Date(published).getUTCFullYear() : new Date().getUTCFullYear(),
    published,
    ...publication,
    openAccess: true,
    pdfUrl: pdfUrl || (arxivId ? `https://arxiv.org/pdf/${arxivId}` : undefined),
    landingPageUrl: fallbackUrl,
    keywords,
    concepts: keywords.map((keyword, index) => ({
      id: `openreview:${openReviewId}:keyword:${index}`,
      display_name: keyword,
      level: 2,
    })),
    // A note has keywords, not a category; the searched one is only why it
    // was fetched.
    _fetchedFor: requestedCategories,
    provider: 'openreview',
  });
}
