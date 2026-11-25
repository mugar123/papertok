import { getCategoryArea } from '../data/category-taxonomy.ts';
import { getPmfSurveyStorageKey } from './user-scoped-storage.ts';
import type { ReadingLevel } from './user-settings.ts';

type SurveyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The product-market fit survey (components/nudges/pmf-survey.tsx): who may be
 * asked and what an answer sends. NudgeHost decides when, as it does for
 * everything else the app asks.
 *
 * Only a signed-in reader who has really used PaperTok is asked. The first
 * time, that means PaperTok opened on three different days, or twenty papers
 * kept on screen for at least a second each (the dwell the cards report to
 * the feed's trackViewTime; a fast swipe and a paper a load passes over do not
 * count). After a new version, a reader already asked for an earlier one is
 * asked again once PaperTok was opened on two different days on that version.
 * A version is package.json's, built in by vite.config.ts.
 *
 * Two records per account in this browser. The days, each with the version it
 * was opened on, and the papers (kept only until the first ask) are swept at sign-out
 * (user-scoped-storage.ts), so an account that signs in again counts them from
 * nothing. The version the account was last asked for is kept across
 * sign-outs, as the privacy notice's is (utils/nudges.ts), so signing in again
 * does not ask again for the same version; deleting the account removes it
 * (forgetPmfSurveyAsked). Opening the survey settles its version, however it
 * is then closed.
 *
 * That version is also kept in the account (services/pmf-survey-service.ts),
 * so one ask settles the version on every device and browser. This browser's
 * copy is the first check; once it finds the survey due, the account's record
 * is read (adoptAccountPmfSurvey) and the survey opens only if that record does
 * not cover the version either. A failed read asks nobody in that visit.
 */

const ACTIVE_DAYS = 3;
const DWELT_PAPERS = 20;
const DAYS_ON_NEW_VERSION = 2;

const ASKED_KEY_PREFIX = 'papertok_pmfSurveyAsked:';

interface UsageDay { day: string; version: string }
interface UsageRecord { days: UsageDay[]; papers: string[] }

export type PmfDisappointment = 'very' | 'somewhat' | 'not';
export type PmfRole = 'undergraduate' | 'graduate' | 'researcher' | 'industry' | 'other';
/** `nps` and `role` are null when the reader left that question unanswered. */
export type PmfSurveyAnswer = { disappointment: PmfDisappointment; nps: number | null; role: PmfRole | null } | 'dismissed';

/**
 * Who answered, so answers and the response rate can be split by kind of
 * reader: the reading level setting and the broad areas of their interests
 * (pmfSurveyAreas). Either is left out when it is not known.
 */
export interface PmfSurveyReader { readingLevel?: ReadingLevel | null; areas?: readonly string[] | null }

function resolveStorage(storage: SurveyStorage | null | undefined) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function askedKey(uid: string) {
  return `${ASKED_KEY_PREFIX}${encodeURIComponent(uid)}`;
}

/** A version as numbers ('0.10.0' is [0, 10, 0]), or null for anything else. */
function versionParts(value: string) {
  return /^\d+(\.\d+)*$/.test(value) ? value.split('.').map(Number) : null;
}

/** Whether `version` is the same release as `than` or a later one. */
function versionAtLeast(version: string, than: string) {
  const had = versionParts(version);
  const owed = versionParts(than);
  if (!had || !owed) return version === than;
  for (let index = 0; index < Math.max(had.length, owed.length); index += 1) {
    const difference = (had[index] ?? 0) - (owed[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/**
 * Whether a survey asked for version `asked` settles `version`: the same
 * release or a later one. Nothing asked settles nothing.
 */
export function pmfSurveyVersionCovers(asked: string | null | undefined, version: string) {
  return Boolean(asked) && versionAtLeast(asked as string, version);
}

function isUsageDay(entry: unknown): entry is UsageDay {
  if (!entry || typeof entry !== 'object') return false;
  const { day, version } = entry as Record<string, unknown>;
  return typeof day === 'string' && typeof version === 'string';
}

function readUsage(key: string, storage: SurveyStorage): UsageRecord {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return { days: [], papers: [] };
    const { days, papers } = parsed as Record<string, unknown>;
    return {
      days: Array.isArray(days) ? days.filter(isUsageDay) : [],
      papers: Array.isArray(papers) ? papers.filter((paperId): paperId is string => typeof paperId === 'string') : [],
    };
  } catch {
    return { days: [], papers: [] };
  }
}

function writeUsage(uid: string, storage: SurveyStorage | null | undefined, change: (record: UsageRecord) => UsageRecord | null) {
  const key = getPmfSurveyStorageKey(uid);
  const target = resolveStorage(storage);
  if (!key || !target) return;
  try {
    const next = change(readUsage(key, target));
    if (next) target.setItem(key, JSON.stringify(next));
  } catch {
    // Without storage the survey is not offered (pmfSurveyDue), so nothing is lost.
  }
}

function readAsked(uid: string, storage: SurveyStorage) {
  try {
    return storage.getItem(askedKey(uid)) || null;
  } catch {
    return null;
  }
}

/** The calendar day on this device, such as '2026-11-18'. */
function localDay(now: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Counts the day of `now` as one the account opened PaperTok on, running
 * `version`. A day already counted for an earlier version is moved to the
 * later one, which was opened on it too; a tab still running an earlier
 * version does not move it back. The latest three days are all the rules need.
 */
export function recordPmfSurveyDay(uid: string, now: Date, version: string, storage?: SurveyStorage | null) {
  const day = localDay(now);
  writeUsage(uid, storage, record => {
    const counted = record.days.find(entry => entry.day === day);
    if (counted && versionAtLeast(counted.version, version)) return null;
    const days = [...record.days.filter(entry => entry.day !== day), { day, version }];
    return { ...record, days: days.slice(-ACTIVE_DAYS) };
  });
}

/**
 * Counts a paper that stayed on screen for at least a second, once, up to the
 * twenty the first ask needs. `viewerId` is the account the card was shown
 * to, `signedInUid` the one Firebase names now: a card that reports after its
 * account signed out, whose records sign-out has just swept, writes nothing
 * back (as in context/feed-viewed-papers.ts). Once the account has been asked,
 * only days count, so no paper is kept.
 */
export function recordPmfSurveyPaper({ paperId, viewerId, signedInUid }: { paperId: string; viewerId: string | null | undefined; signedInUid: string | null | undefined }, storage?: SurveyStorage | null) {
  if (!viewerId || viewerId !== signedInUid) return;
  const target = resolveStorage(storage);
  if (!target || readAsked(viewerId, target)) return;
  writeUsage(viewerId, target, record => (record.papers.length >= DWELT_PAPERS || record.papers.includes(paperId)
    ? null
    : { ...record, papers: [...record.papers, paperId] }));
}

/**
 * Whether the account may be asked for `version`: not asked for it or a later
 * one yet, and with the use the rules above ask for. Unreadable storage asks
 * nobody, since that use cannot be counted.
 */
export function pmfSurveyDue(uid: string | null | undefined, version: string, storage?: SurveyStorage | null) {
  const key = getPmfSurveyStorageKey(uid);
  const target = resolveStorage(storage);
  if (!uid || !key || !target) return false;
  const asked = readAsked(uid, target);
  if (asked && versionAtLeast(asked, version)) return false;
  const { days, papers } = readUsage(key, target);
  if (asked) return days.filter(entry => entry.version === version).length >= DAYS_ON_NEW_VERSION;
  return days.length >= ACTIVE_DAYS || papers.length >= DWELT_PAPERS;
}

/** The newest version this browser recorded the account as asked for, if any. */
export function readPmfSurveyAsked(uid: string, storage?: SurveyStorage | null) {
  const target = resolveStorage(storage);
  return target ? readAsked(uid, target) : null;
}

/** Keeps `version` as asked in this browser unless a later one is already kept. */
function rememberAsked(uid: string, version: string, storage: SurveyStorage | null) {
  try {
    if (!pmfSurveyVersionCovers(storage && readAsked(uid, storage), version)) storage?.setItem(askedKey(uid), version);
  } catch {
    // The account's record still settles it; this browser asks the account again next visit.
  }
}

/**
 * Takes the account's record for `uid` (null when it has none): what it holds
 * is kept as this browser's copy, the newer of the two winning, so the next
 * visit here is settled without asking the account, and a survey this browser
 * found due is no longer due when another device already asked.
 */
export function adoptAccountPmfSurvey(uid: string, version: string | null, storage?: SurveyStorage | null) {
  if (version) rememberAsked(uid, version, resolveStorage(storage));
}

/**
 * Copies the version this browser recorded as asked to the account, for an
 * ask from before the account kept it, so the other devices learn of it.
 * Undefined when this browser has none.
 */
export function syncLocalPmfSurvey({ uid, storage, saveToAccount }: { uid: string; storage?: SurveyStorage | null; saveToAccount: (uid: string, version: string) => Promise<void> }) {
  const asked = readPmfSurveyAsked(uid, storage);
  return asked ? saveToAccount(uid, asked) : undefined;
}

/** For a deleted account: its uid has no business staying in this browser. */
export function forgetPmfSurveyAsked(uid: string, storage?: SurveyStorage | null) {
  try {
    resolveStorage(storage)?.removeItem(askedKey(uid));
  } catch {
    // Clearing site data removes it too.
  }
}

/**
 * The broad areas of the reader's interests: the area keys of the subareas
 * they chose, each once, sorted. An id no area holds counts for nothing,
 * so no subarea id or free text leaves this way.
 */
export function pmfSurveyAreas(interests: readonly string[] | null | undefined) {
  const areas = new Set((interests ?? []).map(categoryId => getCategoryArea(categoryId)).filter(area => area !== null));
  return [...areas].sort();
}

/** What both survey events say about the reader; an unknown value is left out. */
function readerParams({ readingLevel, areas }: PmfSurveyReader = {}) {
  return {
    ...(readingLevel && { reading_level: readingLevel }),
    ...(areas && { areas: [...areas] }),
  };
}

/** What `pmf_survey` sends for an answer or a dismissal. */
export function pmfSurveyParams(answer: PmfSurveyAnswer, version: string, reader?: PmfSurveyReader) {
  if (answer === 'dismissed') return { disappointment: 'dismissed', app_version: version, ...readerParams(reader) };
  return {
    disappointment: answer.disappointment,
    ...(answer.nps !== null && { nps: answer.nps }),
    ...(answer.role !== null && { role: answer.role }),
    app_version: version,
    ...readerParams(reader),
  };
}

type SurveyTrack = (eventName: 'pmf_survey_shown' | 'pmf_survey', params: Record<string, unknown>, stillValid?: () => boolean) => Promise<unknown>;

/** The survey while it is open: one answer, or the dismissal, is sent for it. */
export interface PmfSurveyShown {
  answer: (answer: PmfSurveyAnswer) => void;
  /** It closed: a close nobody answered, such as leaving the feed, is a dismissal. */
  close: () => void;
}

/**
 * Called by NudgeHost after each commit, as recordPrivacyNoticeShown is: once
 * the survey is open on screen for a signed-in account, `version` counts as
 * asked for that account and `pmf_survey_shown` is sent. What it returns sends
 * the one `pmf_survey` event of that opening: the answer the dialog hands
 * over, or a dismissal when it closes without one. Both events describe
 * `reader` as it was when the survey opened. Nothing is recorded before it
 * opens or if Firebase has already switched away from the rendered `uid`.
 * Both events carry `stillValid` so analytics can check the opening account
 * and consent again before capture. The version is also handed to
 * `saveToAccount` for the account's own record; a failed save is reported and
 * left, as this browser's copy still settles it here.
 */
export function recordPmfSurveyShown({ uid, signedInUid, surveyOpen, version, reader, storage, track, stillValid, saveToAccount }: {
  uid: string | null | undefined;
  signedInUid: string | null | undefined;
  surveyOpen: boolean;
  version: string;
  reader?: PmfSurveyReader;
  storage?: SurveyStorage | null;
  track: SurveyTrack;
  stillValid?: () => boolean;
  saveToAccount?: (uid: string, version: string) => Promise<void>;
}): PmfSurveyShown | null {
  if (!surveyOpen || !uid || uid !== signedInUid) return null;
  // The newest version asked is kept: a tab still running an earlier one does
  // not write its version over it, here or in the account.
  const target = resolveStorage(storage);
  rememberAsked(uid, version, target);
  saveToAccount?.(uid, version).catch((error: unknown) => {
    console.warn('Could not record in the account that the fit survey was shown', error);
  });
  // Only the first ask reads the papers; the ones kept for it go now.
  writeUsage(uid, target, record => (record.papers.length ? { ...record, papers: [] } : null));
  void track('pmf_survey_shown', { app_version: version, ...readerParams(reader) }, stillValid);
  let sent = false;
  const send = (answer: PmfSurveyAnswer) => {
    if (sent) return;
    sent = true;
    void track('pmf_survey', pmfSurveyParams(answer, version, reader), stillValid);
  };
  return { answer: send, close: () => send('dismissed') };
}
