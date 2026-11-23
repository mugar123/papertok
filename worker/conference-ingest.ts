import type { WorkerEnv } from './env.ts';
import type { WorkflowStep } from 'cloudflare:workers';
import type { OpenReviewNote } from '../src/services/open-review-service.ts';
import { mapOpenReviewNote } from '../src/services/open-review-service.ts';
import { storedPaper } from './paper-store.ts';
import { conferenceMembership, conferenceSortKey, conferenceSources, openReviewField } from './conference-membership.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';
import { findConferenceEdition } from '../src/data/conferences.ts';

const terms = ['the', 'a'];
const nightLimit = 150;
const minuteLimit = 12;
const pageSize = 100;
const dayMs = 86_400_000;
const pageStep = { retries: { limit: 0, delay: '1 second' }, timeout: '2 minutes' } as const;

type EditionState = {
  edition_id: string;
  generation: number;
  term: number;
  offset: number;
};

function retryAt(header: string | null, now: number) {
  if (!header) return now + dayMs;
  const delaySeconds = Number(header);
  const date = Number.isFinite(delaySeconds) ? now + delaySeconds * 1000 : Date.parse(header);
  return Number.isFinite(date) ? Math.max(now + 60_000, date) : now + dayMs;
}

async function recordFailure(db: D1Database, state: EditionState, now: number, retryAfter = 0) {
  await db.prepare(`
    UPDATE conference_editions SET
      failures = failures + 1,
      stale_since = CASE WHEN failures >= 2 AND checked_at IS NOT NULL THEN COALESCE(stale_since, ?) ELSE stale_since END,
      retry_after = ?
    WHERE edition_id = ?
  `).bind(now, retryAfter, state.edition_id).run();
}

function nextCheck(state: EditionState, now: number, staged: number) {
  const edition = findConferenceEdition(state.edition_id);
  const decisionsOn = conferenceSources.get(state.edition_id)?.decisionsOn;
  if (!staged) return now + (decisionsOn && Date.parse(decisionsOn) - now > 7 * dayMs ? 7 : 1) * dayMs;
  const lastDate = edition?.dates.at(-1);
  const ended = lastDate && now - Date.parse(lastDate.end ?? lastDate.start) > 60 * dayMs;
  return now + (ended ? 30 : 7) * dayMs;
}

async function ingestPage(db: D1Database, state: EditionState, env: WorkerEnv) {
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const night = new Date(now).toISOString().slice(0, 10);
  for (const [period, limit, expiresAt] of [
    [night, nightLimit, (Math.floor(now / dayMs) + 2) * dayMs],
    [String(minute), minuteLimit, (minute + 2) * 60_000],
  ] as const) {
    const quota = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, {
      periodKey: 'openreview-ingest:' + period, subject: 'conference-ingest', subjectLimit: limit, globalLimit: limit, expiresAt,
    });
    if (!quota.accepted) return false;
  }

  const source = conferenceSources.get(state.edition_id);
  if (!source) return false;
  const url = new URL('https://api2.openreview.net/notes/search');
  url.search = new URLSearchParams({
    term: terms[state.term], source: 'forum', venueid: source.venueId, limit: String(pageSize), offset: String(state.offset),
  }).toString();
  let notes: OpenReviewNote[];
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', 'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)' },
    });
    if (response.status === 429 || (!response.ok && response.headers.has('retry-after'))) {
      await recordFailure(db, state, now, retryAt(response.headers.get('retry-after'), now));
      return false;
    }
    if (!response.ok) throw new Error('OpenReview HTTP ' + response.status);
    const payload = await response.json<{ notes?: OpenReviewNote[]; count?: number }>();
    if (!Array.isArray(payload.notes) || payload.notes.length > pageSize || (payload.notes.length === 0 && Number(payload.count) > state.offset)) {
      throw new Error('OpenReview returned an invalid page');
    }
    notes = payload.notes;
  } catch (error) {
    console.warn('Conference search failed', state.edition_id, error instanceof Error ? error.name : 'unknown');
    await recordFailure(db, state, now);
    return false;
  }

  const rows = await Promise.all(notes.map(async note => {
    const membership = conferenceMembership(state.edition_id, note);
    if (!membership || !openReviewField(note.content?.title)?.trim()) return null;
    const paper = mapOpenReviewNote({ ...note, content: { ...note.content, abstract: undefined } });
    if (!paper) return null;
    const license = openReviewField('license' in note ? note.license : null);
    return db.prepare(`
      INSERT INTO conference_paper_stage (edition_id, paper_id, forum_id, venue_id, venue_text, track, sort_key, paper, seen_generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (edition_id, paper_id) DO UPDATE SET
        forum_id = excluded.forum_id, venue_id = excluded.venue_id, venue_text = excluded.venue_text,
        track = excluded.track, sort_key = excluded.sort_key, paper = excluded.paper, seen_generation = excluded.seen_generation
    `).bind(state.edition_id, paper.id, membership.forumId, membership.venueId, membership.venueText, membership.track,
      await conferenceSortKey(state.edition_id, paper.id, membership.track), JSON.stringify(storedPaper({
        ...paper, license: license ?? undefined, publicationStatus: 'published', publicationType: 'conference', peerReviewed: true,
      })), state.generation);
  }));
  const ended = notes.length < pageSize;
  const finished = ended && state.term === terms.length - 1;
  await db.batch([
    ...rows.filter(row => row !== null),
    ...(finished ? [] : [db.prepare('UPDATE conference_editions SET term = ?, offset = ?, failures = 0, retry_after = 0 WHERE edition_id = ?')
      .bind(ended ? state.term + 1 : state.term, ended ? 0 : state.offset + notes.length, state.edition_id)]),
  ]);
  if (!finished) return true;

  const counts = await db.prepare(`
    SELECT (SELECT COUNT(*) FROM conference_paper_stage WHERE edition_id = ?) AS staged,
      COUNT(*) AS listed,
      COUNT(CASE WHEN s.paper_id IS NULL THEN 1 END) AS missing
    FROM conference_papers p LEFT JOIN conference_paper_stage s USING (edition_id, paper_id)
    WHERE p.edition_id = ? AND p.visible = 1
  `).bind(state.edition_id, state.edition_id).first<{ staged: number; listed: number; missing: number }>();
  if (!counts) throw new Error('Conference counts unavailable');
  // The search index is incomplete, so absence cannot establish withdrawal.
  const stale = counts.missing > counts.listed * 0.02;
  await db.batch([
    db.prepare(`
      INSERT INTO conference_papers (edition_id, paper_id, forum_id, venue_id, venue_text, track, sort_key, paper, seen_generation, visible)
      SELECT edition_id, paper_id, forum_id, venue_id, venue_text, track, sort_key, paper, seen_generation, 1
      FROM conference_paper_stage WHERE edition_id = ?
      ON CONFLICT (edition_id, paper_id) DO UPDATE SET
        forum_id = excluded.forum_id, venue_id = excluded.venue_id, venue_text = excluded.venue_text,
        track = excluded.track, sort_key = excluded.sort_key, paper = excluded.paper, seen_generation = excluded.seen_generation,
        visible = 1
    `).bind(state.edition_id),
    db.prepare('DELETE FROM conference_paper_stage WHERE edition_id = ?').bind(state.edition_id),
    db.prepare(`UPDATE conference_editions SET generation = generation + 1, term = 0, offset = 0, failures = 0, retry_after = 0,
      checked_at = ?, stale_since = ?, next_check_at = ? WHERE edition_id = ?`)
      .bind(now, stale ? now : null, nextCheck(state, now, counts.staged), state.edition_id),
  ]);
  console.info(JSON.stringify({ conferenceEdition: state.edition_id, ...counts, stale }));
  return true;
}

export async function runConferenceIngest(env: WorkerEnv, step: WorkflowStep) {
  const db = env.PAPER_STORE;
  if (!db || env.CONFERENCE_PAPERS_ENABLED !== '1') return;
  await step.do('register editions', async () => {
    await db.batch([...conferenceSources.keys()].map(id =>
      db.prepare('INSERT OR IGNORE INTO conference_editions (edition_id) VALUES (?)').bind(id)));
  });
  for (let call = 0; call < nightLimit; call++) {
    const shouldContinue = await step.do('conference page ' + call, pageStep, async () => {
      const now = Date.now();
      const state = await db.prepare(`
        SELECT edition_id, generation, term, offset FROM conference_editions
        WHERE next_check_at <= ? AND NOT EXISTS (SELECT 1 FROM conference_editions WHERE retry_after > ?)
        ORDER BY CASE WHEN offset > 0 OR term > 0 THEN 0 ELSE 1 END, next_check_at, edition_id LIMIT 1
      `).bind(now, now).first<EditionState>();
      return state ? ingestPage(db, state, env) : false;
    });
    if (!shouldContinue) break;
    await step.sleep('conference pacing ' + call, '5 seconds');
  }
}
