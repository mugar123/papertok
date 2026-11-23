import type { WorkerEnv } from './env.ts';
import type { WorkflowStep } from 'cloudflare:workers';
import type { OpenReviewNote } from '../src/services/open-review-service.ts';
import { mapOpenReviewNote } from '../src/services/open-review-service.ts';
import { storedPaper } from './paper-store.ts';
import { conferenceMembership, conferenceSortKey, conferenceSources, openReviewField } from './conference-membership.ts';
import { fetchOpenReviewNote, isOpenReviewSubmission, openReviewAccount } from './open-review-api.ts';
import { fetchWithDeadline } from './provider-runtime.ts';
import { releaseRequestQuota, reserveRequestQuota } from './request-quota-ledger.ts';
import { findConferenceEdition } from '../src/data/conferences.ts';

const terms = ['the', 'a'];
const nightLimit = 150;
const minuteLimit = 12;
const pageSize = 100;
const maxOffset = 10_000;
const dayMs = 86_400_000;
const searchUrl = 'https://api2.openreview.net/notes/search';
const pageStep = { retries: { limit: 0, delay: '1 second' }, timeout: '2 minutes' } as const;

type EditionState = { edition_id: string; generation: number; term: number; offset: number; expected_count: number };
type PublishedForum = { edition_id: string; forum_id: string };
type SearchPage = { notes: OpenReviewNote[]; count: number };

class QuotaUnavailable extends Error {}
class MinuteQuotaUnavailable extends QuotaUnavailable {}
class ConferenceRateLimit extends Error {
  readonly retryAt: number;
  constructor(header: string | null, now: number) {
    super('OpenReview rate limited');
    const seconds = Number(header);
    const requested = !header ? nextUtcDay(now) : Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(header);
    this.retryAt = Math.min(now + 7 * dayMs, Math.max(now + 60_000, Number.isFinite(requested) ? requested : nextUtcDay(now)));
  }
}

function nextUtcDay(now: number) {
  return (Math.floor(now / dayMs) + 1) * dayMs;
}

async function recordFailure(db: D1Database, editionId: string, now: number, retryAfter = 0, resetPass = false) {
  await db.batch([
    ...(resetPass ? [db.prepare(`
      DELETE FROM conference_paper_stage WHERE edition_id = ? AND EXISTS (
        SELECT 1 FROM conference_editions WHERE edition_id = ? AND failures >= 2
      )
    `).bind(editionId, editionId)] : []),
    db.prepare(`
    UPDATE conference_editions SET failures = failures + 1,
      stale_since = CASE WHEN failures >= 2 AND checked_at IS NOT NULL THEN COALESCE(stale_since, ?) ELSE stale_since END,
      retry_after = ?, next_check_at = CASE WHEN failures >= 2 THEN ? ELSE MAX(next_check_at, ?) END,
      generation = CASE WHEN ? AND failures >= 2 THEN generation + 1 ELSE generation END,
      term = CASE WHEN ? AND failures >= 2 THEN 0 ELSE term END,
      offset = CASE WHEN ? AND failures >= 2 THEN 0 ELSE offset END,
      expected_count = CASE WHEN ? AND failures >= 2 THEN 0 ELSE expected_count END
    WHERE edition_id = ?
  `).bind(now, retryAfter, nextUtcDay(now), now + 60_000, resetPass, resetPass, resetPass, resetPass, editionId),
  ]);
}

function nextCheck(state: EditionState, now: number, staged: number) {
  const edition = findConferenceEdition(state.edition_id);
  const decisionsOn = conferenceSources.get(state.edition_id)?.decisionsOn;
  if (!staged) return nextUtcDay(now) + (decisionsOn && Date.parse(decisionsOn) - now > 7 * dayMs ? 6 * dayMs : 0);
  const lastDate = edition?.dates.at(-1);
  const ended = lastDate && now - Date.parse(lastDate.end ?? lastDate.start) > 60 * dayMs;
  return nextUtcDay(now) + (ended ? 29 : 6) * dayMs;
}

function quotaFetch(env: WorkerEnv): typeof fetchWithDeadline {
  return async (url, options, timeoutMs) => {
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    const night = new Date(now).toISOString().slice(0, 10);
    const minuteReservation = {
      periodKey: 'openreview-ingest:' + minute, subject: 'conference-ingest',
      subjectLimit: minuteLimit, globalLimit: minuteLimit, expiresAt: (minute + 2) * 60_000,
    };
    const minuteQuota = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, minuteReservation);
    if (!minuteQuota.accepted) {
      if (minuteQuota.code) throw new QuotaUnavailable();
      throw new MinuteQuotaUnavailable();
    }
    try {
      const dailyQuota = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, {
        periodKey: 'openreview-ingest:' + night, subject: 'conference-ingest',
        subjectLimit: nightLimit, globalLimit: nightLimit, expiresAt: nextUtcDay(now) + dayMs,
      });
      if (!dailyQuota.accepted) throw new QuotaUnavailable();
    } catch (error) {
      await releaseRequestQuota(env.REQUEST_QUOTA_LEDGER, minuteReservation);
      throw error;
    }
    const response = await fetchWithDeadline(url, { ...options, redirect: 'error' }, timeoutMs);
    if (response.status === 429) throw new ConferenceRateLimit(response.headers.get('retry-after'), Date.now());
    return response;
  };
}

function venueEvidence(forumId: string, note: OpenReviewNote | null) {
  if (!note || note.id !== forumId || note.forum !== forumId || !isOpenReviewSubmission(note)) return null;
  return openReviewField(note.content?.venueid)?.trim() || null;
}

function blockForums(db: D1Database, editionId: string, evidence: readonly { forum: string; venue: string }[], now: number) {
  if (!evidence.length) return [];
  return [
    db.prepare(`
      INSERT OR IGNORE INTO conference_forum_block (edition_id, forum_id, venue_id, blocked_at)
      SELECT ?, json_extract(j.value, '$.forum'), json_extract(j.value, '$.venue'), ?
      FROM json_each(?) j
      WHERE EXISTS (
        SELECT 1 FROM conference_papers p
        WHERE p.edition_id = ? AND p.forum_id = json_extract(j.value, '$.forum') AND p.visible = 1
      ) OR EXISTS (
        SELECT 1 FROM conference_paper_stage s
        WHERE s.edition_id = ? AND s.forum_id = json_extract(j.value, '$.forum')
      )
    `).bind(editionId, now, JSON.stringify(evidence), editionId, editionId),
    db.prepare(`
      UPDATE conference_papers SET visible = 0
      WHERE edition_id = ? AND visible = 1 AND EXISTS (
        SELECT 1 FROM conference_forum_block b
        WHERE b.edition_id = conference_papers.edition_id AND b.forum_id = conference_papers.forum_id
      )
    `).bind(editionId),
    db.prepare(`
      UPDATE conference_editions SET
        listed_count = (SELECT COUNT(*) FROM conference_papers WHERE edition_id = ? AND visible = 1),
        revision = revision + 1
      WHERE edition_id = ? AND listed_count <> (SELECT COUNT(*) FROM conference_papers WHERE edition_id = ? AND visible = 1)
    `).bind(editionId, editionId, editionId),
  ];
}

const orcidId = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i;
function publicAuthorId(id: string | null | undefined) {
  if (!id || id.includes('@')) return undefined;
  if (/^~[\p{L}\p{N}_.-]+$/u.test(id)) return id;
  const orcid = id.replace(/^https:\/\/orcid\.org\//i, '');
  return orcidId.test(orcid) ? orcid : undefined;
}

function httpsPdf(url: string | null | undefined) {
  if (!url) return undefined;
  const parsed = URL.parse(url);
  return parsed?.protocol === 'https:' && !parsed.username && !parsed.password ? url : undefined;
}

async function ingestPage(db: D1Database, state: EditionState, request: typeof fetchWithDeadline, now: number) {
  const source = conferenceSources.get(state.edition_id);
  if (!source) throw new Error('Unknown conference edition');
  if (state.offset >= maxOffset) throw new Error('Conference search offset limit');
  const url = new URL(searchUrl);
  url.search = new URLSearchParams({
    term: terms[state.term], source: 'forum', venueid: source.venueId, limit: String(pageSize), offset: String(state.offset), count: 'true',
  }).toString();
  const response = await request(url, { headers: { accept: 'application/json', 'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)' } }, 15_000);
  if (!response.ok) throw new Error('OpenReview search failed');
  const payload = await response.json<Partial<SearchPage>>();
  if (!Array.isArray(payload.notes) || payload.notes.length > pageSize
    || typeof payload.count !== 'number' || !Number.isSafeInteger(payload.count) || payload.count < 0) {
    throw new Error('OpenReview returned an invalid page');
  }
  const { notes, count } = payload;
  const nextOffset = state.offset + notes.length;
  if (nextOffset > count) throw new Error('OpenReview search count disagrees with the page');
  const ended = nextOffset >= count;
  if (!ended && (notes.length < pageSize || nextOffset >= maxOffset)) throw new Error('OpenReview search was incomplete');

  const evidence: { forum: string; venue: string }[] = [];
  const statements = await Promise.all(notes.map(async note => {
    const membership = conferenceMembership(state.edition_id, note);
    if (!membership) {
      const forum = note?.forum;
      const venue = typeof forum === 'string' ? venueEvidence(forum, note) : null;
      if (forum && venue && venue !== source.venueId) evidence.push({ forum, venue });
      return null;
    }
    if (!openReviewField(note.content?.title)?.trim()) return null;
    const paper = mapOpenReviewNote({ ...note, content: { ...note.content, abstract: undefined } });
    if (!paper) return null;
    const license = openReviewField('license' in note ? note.license : null);
    const id = 'openreview:' + membership.forumId;
    return db.prepare(`
      INSERT INTO conference_paper_stage (edition_id, forum_id, venue_id, venue_text, track, sort_key, paper, seen_generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (edition_id, forum_id) DO UPDATE SET venue_id = excluded.venue_id, venue_text = excluded.venue_text,
        track = excluded.track, sort_key = excluded.sort_key, paper = excluded.paper, seen_generation = excluded.seen_generation
    `).bind(state.edition_id, membership.forumId, membership.venueId, membership.venueText, membership.track,
      await conferenceSortKey(state.edition_id, id, membership.track), JSON.stringify(storedPaper({
        ...paper, id, license: license ?? undefined, pdfUrl: httpsPdf(paper.pdfUrl),
        authors: paper.authors
          .filter(author => !(typeof author === 'string' ? author : author.name).includes('@'))
          .map(author => typeof author === 'string' ? author : {
            ...author, id: publicAuthorId(author.id), orcid: author.orcid && orcidId.test(author.orcid) ? author.orcid : undefined,
          }),
        publicationStatus: 'published', publicationType: 'conference', peerReviewed: true,
      })), state.generation);
  }));

  const expected = Math.max(state.expected_count, count);
  const finished = ended && state.term === terms.length - 1;
  await db.batch([
    ...(state.term === 0 && state.offset === 0
      ? [db.prepare('DELETE FROM conference_paper_stage WHERE edition_id = ?').bind(state.edition_id)] : []),
    ...statements.filter(row => row !== null),
    ...blockForums(db, state.edition_id, evidence, now),
    ...(finished ? [] : [db.prepare(`UPDATE conference_editions SET term = ?, offset = ?, expected_count = ?,
      failures = 0, retry_after = 0 WHERE edition_id = ?`)
      .bind(ended ? state.term + 1 : state.term, ended ? 0 : nextOffset, expected, state.edition_id)]),
  ]);
  if (!finished) return;

  const counts = await db.prepare(`
    SELECT e.listed_count AS listed,
      (SELECT COUNT(*) FROM conference_paper_stage s WHERE s.edition_id = e.edition_id AND s.seen_generation = e.generation
        AND NOT EXISTS (SELECT 1 FROM conference_forum_block b WHERE b.edition_id = s.edition_id AND b.forum_id = s.forum_id)) AS staged,
      (SELECT COUNT(*) FROM conference_forum_block b JOIN conference_paper_stage s USING (edition_id, forum_id)
        WHERE b.edition_id = e.edition_id AND s.seen_generation = e.generation) AS blocked
    FROM conference_editions e WHERE e.edition_id = ?
  `).bind(state.edition_id).first<{ listed: number; staged: number; blocked: number }>();
  if (!counts) throw new Error('Conference counts unavailable');

  const incomplete = counts.staged < Math.max(counts.listed, expected - counts.blocked) * 0.98;
  await db.batch([
    ...(!incomplete ? [db.prepare(`
      INSERT INTO conference_papers (edition_id, forum_id, venue_id, venue_text, track, sort_key, paper, seen_generation, visible, rechecked_at)
      SELECT s.edition_id, s.forum_id, s.venue_id, s.venue_text, s.track, s.sort_key, s.paper, s.seen_generation, 1, ?
      FROM conference_paper_stage s
      WHERE s.edition_id = ? AND s.seen_generation = ? AND NOT EXISTS (
        SELECT 1 FROM conference_forum_block b WHERE b.edition_id = s.edition_id AND b.forum_id = s.forum_id
      )
      ON CONFLICT (edition_id, forum_id) DO UPDATE SET venue_id = excluded.venue_id, venue_text = excluded.venue_text,
        track = excluded.track, sort_key = excluded.sort_key, paper = excluded.paper,
        seen_generation = excluded.seen_generation, visible = excluded.visible
    `).bind(now, state.edition_id, state.generation)] : []),
    db.prepare('DELETE FROM conference_paper_stage WHERE edition_id = ?').bind(state.edition_id),
    db.prepare(`
      UPDATE conference_editions SET generation = generation + 1, revision = revision + 1, term = 0, offset = 0,
        expected_count = 0, failures = CASE WHEN ? THEN failures + 1 ELSE 0 END, retry_after = 0,
        checked_at = CASE WHEN ? THEN checked_at ELSE ? END,
        stale_since = CASE WHEN ? THEN COALESCE(stale_since, ?) ELSE NULL END, next_check_at = ?,
        source_count = ?, listed_count = (SELECT COUNT(*) FROM conference_papers WHERE edition_id = ? AND visible = 1)
      WHERE edition_id = ?
    `).bind(Number(incomplete), Number(incomplete), now, Number(incomplete), now,
      incomplete ? nextUtcDay(now) : nextCheck(state, now, counts.staged), expected, state.edition_id, state.edition_id),
  ]);
  console.info(JSON.stringify({ conferenceEdition: state.edition_id, ...counts, expected, incomplete }));
}

async function recheckPublished(db: D1Database, env: WorkerEnv, request: typeof fetchWithDeadline, now: number): Promise<boolean | null> {
  if (!openReviewAccount(env)) return null;
  const row = await db.prepare(`
    SELECT p.edition_id, p.forum_id FROM conference_papers p JOIN conference_editions e USING (edition_id)
    WHERE p.visible = 1 AND p.rechecked_at < ? AND e.next_recheck_at <= ?
    ORDER BY (p.seen_generation < e.generation - 1) DESC, p.rechecked_at, p.edition_id, p.forum_id LIMIT 1
  `).bind(nextUtcDay(now) - dayMs, now).first<PublishedForum>();
  if (!row) return null;
  try {
    const note = await fetchOpenReviewNote(env, row.forum_id, 15_000, { request, retryUnauthorized: false, requireComplete: true });
    const venue = venueEvidence(row.forum_id, note);
    const source = conferenceSources.get(row.edition_id);
    await db.batch([
      ...blockForums(db, row.edition_id, venue && source && venue !== source.venueId ? [{ forum: row.forum_id, venue }] : [], now),
      db.prepare('UPDATE conference_papers SET rechecked_at = ? WHERE edition_id = ? AND forum_id = ?').bind(now, row.edition_id, row.forum_id),
    ]);
    return true;
  } catch (error) {
    if (error instanceof QuotaUnavailable) throw error;
    if (error instanceof ConferenceRateLimit) {
      await recordFailure(db, row.edition_id, now, error.retryAt);
      return false;
    }
    await db.prepare('UPDATE conference_editions SET next_recheck_at = ? WHERE edition_id = ?').bind(nextUtcDay(now), row.edition_id).run();
    return true;
  }
}

async function runOne(db: D1Database, env: WorkerEnv, call: number) {
  const now = Date.now();
  const owner = crypto.randomUUID();
  const lease = await db.prepare(`
    INSERT INTO conference_ingest_lease (id, owner, expires_at) VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
    WHERE conference_ingest_lease.expires_at <= ? RETURNING owner
  `).bind(owner, now + 5 * 60_000, now).first<{ owner: string }>();
  if (!lease) return false;
  try {
    const paused = await db.prepare('SELECT 1 FROM conference_editions WHERE retry_after > ? LIMIT 1').bind(now).first();
    if (paused) return false;
    const request = quotaFetch(env);
    if (call % 2 === 0) {
      const rechecked = await recheckPublished(db, env, request, now);
      if (rechecked !== null) return rechecked;
    }
    const state = await db.prepare(`
      SELECT edition_id, generation, term, offset, expected_count FROM conference_editions
      WHERE next_check_at <= ?
      ORDER BY CASE WHEN offset > 0 OR term > 0 THEN 0 ELSE 1 END, next_check_at, edition_id LIMIT 1
    `).bind(now).first<EditionState>();
    if (!state) return call % 2 === 1 && (await recheckPublished(db, env, request, now) ?? false);
    try {
      await ingestPage(db, state, request, now);
      return true;
    } catch (error) {
      if (error instanceof QuotaUnavailable) throw error;
      const rateLimited = error instanceof ConferenceRateLimit;
      await recordFailure(db, state.edition_id, now, rateLimited ? error.retryAt : 0, !rateLimited);
      console.warn('Conference search failed', state.edition_id, error instanceof Error ? error.name : 'unknown');
      return !rateLimited;
    }
  } catch (error) {
    if (error instanceof MinuteQuotaUnavailable) return 'minute';
    if (error instanceof QuotaUnavailable) return false;
    throw error;
  } finally {
    await db.prepare('DELETE FROM conference_ingest_lease WHERE id = 1 AND owner = ?').bind(owner).run();
  }
}

export async function runConferenceIngest(env: WorkerEnv, step: WorkflowStep) {
  const db = env.PAPER_STORE;
  if (!db || env.CONFERENCE_PAPERS_ENABLED !== '1') return;
  await step.do('register editions', async () => {
    await db.batch([...conferenceSources.keys()].map(id =>
      db.prepare('INSERT OR IGNORE INTO conference_editions (edition_id) VALUES (?)').bind(id)));
  });
  for (let call = 0; call < nightLimit; call++) {
    const shouldContinue = await step.do('conference page ' + call, pageStep, () => runOne(db, env, call));
    if (!shouldContinue) break;
    await step.sleep('conference pacing ' + call, shouldContinue === 'minute' ? '1 minute' : '5 seconds');
  }
}
