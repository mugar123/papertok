import type { OpenReviewNote } from '../src/services/open-review-service.ts';
import { isOpenReviewSubmission } from './open-review-api.ts';

type ConferenceTrack = 'oral' | 'spotlight' | 'poster';

export const conferenceSources = new Map<string, { venueId: string; label: string; decisionsOn?: string }>([
  ['neurips-2026', { venueId: 'NeurIPS.cc/2026/Conference', label: 'NeurIPS 2026' }],
  ['iclr-2026', { venueId: 'ICLR.cc/2026/Conference', label: 'ICLR 2026' }],
  ['icml-2026', { venueId: 'ICML.cc/2026/Conference', label: 'ICML 2026' }],
  ['colm-2026', { venueId: 'colmweb.org/COLM/2026/Conference', label: 'COLM 2026' }],
  ['iclr-2027', { venueId: 'ICLR.cc/2027/Conference', label: 'ICLR 2027', decisionsOn: '2026-12-16' }],
]);

export function openReviewField(value: unknown): string | null {
  const item = value && typeof value === 'object' && 'value' in value ? value.value : value;
  return typeof item === 'string' ? item : null;
}

export function conferenceMembership(editionId: string, note: OpenReviewNote) {
  const source = conferenceSources.get(editionId);
  const venueId = openReviewField(note?.content?.venueid);
  if (!source || venueId !== source.venueId || typeof note.forum !== 'string' || !note.forum || note.id !== note.forum || !isOpenReviewSubmission(note)) return null;
  const venueText = openReviewField(note.content?.venue);
  const prefix = source.label.toLowerCase() + ' ';
  const lower = venueText?.toLowerCase();
  const suffix = lower?.startsWith(prefix) ? lower.slice(prefix.length) : null;
  const track: ConferenceTrack | null = suffix === 'oral' || suffix === 'spotlight' || suffix === 'poster' ? suffix : null;
  return { editionId, forumId: note.forum, venueId, venueText, track };
}

export async function conferenceSortKey(editionId: string, paperId: string, track: ConferenceTrack | null) {
  const rank = track === 'oral' ? '0' : track === 'spotlight' ? '1' : track === 'poster' ? '2' : '3';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(editionId + ':' + paperId));
  return rank + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
