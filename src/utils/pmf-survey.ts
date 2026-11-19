import { getPmfSurveyStorageKey, readSeenPaperIds } from './user-scoped-storage.ts';

type SurveyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The product-market fit survey (components/nudges/pmf-survey.tsx): who may be
 * asked and what an answer sends. NudgeHost decides when, as it does for
 * everything else the app asks.
 *
 * Only a signed-in reader who has really used PaperTok is asked: on three
 * different days, or after twenty papers viewed on their cards. The papers are
 * the account's viewed list in this browser (user-scoped-storage.ts); the days
 * and the version already asked are this module's own record. Both are kept
 * per account and swept at sign-out, so an account that signs in again counts
 * from nothing. A reader is asked once per PaperTok version (package.json's,
 * built in by vite.config.ts). Opening the survey settles that version,
 * however it is then closed.
 */

const ACTIVE_DAYS = 3;
const VIEWED_PAPERS = 20;

interface SurveyRecord { days: string[]; asked: string | null }

export type PmfDisappointment = 'very' | 'somewhat' | 'not';
/** `nps` is null when the reader left the second question unanswered. */
export type PmfSurveyAnswer = { disappointment: PmfDisappointment; nps: number | null } | 'dismissed';

function resolveStorage(storage: SurveyStorage | null | undefined) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readRecord(key: string, storage: SurveyStorage): SurveyRecord {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return { days: [], asked: null };
    const { days, asked } = parsed as Record<string, unknown>;
    return {
      days: Array.isArray(days) ? days.filter((day): day is string => typeof day === 'string') : [],
      asked: typeof asked === 'string' ? asked : null,
    };
  } catch {
    return { days: [], asked: null };
  }
}

function writeRecord(uid: string, storage: SurveyStorage | null | undefined, change: (record: SurveyRecord) => SurveyRecord | null) {
  const key = getPmfSurveyStorageKey(uid);
  const target = resolveStorage(storage);
  if (!key || !target) return;
  try {
    const next = change(readRecord(key, target));
    if (next) target.setItem(key, JSON.stringify(next));
  } catch {
    // Without storage the survey is not offered (pmfSurveyDue), so nothing is lost.
  }
}

/** The calendar day on this device, such as '2026-11-18'. */
function localDay(now: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Counts the day of `now` as one the account opened PaperTok on. The latest three are all the rule needs. */
export function recordPmfSurveyDay(uid: string, now: Date, storage?: SurveyStorage | null) {
  const day = localDay(now);
  writeRecord(uid, storage, record => (record.days.includes(day)
    ? null
    : { ...record, days: [...record.days, day].slice(-ACTIVE_DAYS) }));
}

/** Records that the account was shown the survey for `version`. */
export function rememberPmfSurveyAsked(uid: string, version: string, storage?: SurveyStorage | null) {
  writeRecord(uid, storage, record => ({ ...record, asked: version }));
}

/**
 * Whether having been asked for `asked` settles `version`. A later version
 * settles an earlier one, so a tab still running the previous release does
 * not ask again a reader who already answered for the new one.
 */
function versionSettled(asked: string | null, version: string) {
  const parse = (value: string | null) => (value && /^\d+(\.\d+)*$/.test(value) ? value.split('.').map(Number) : null);
  const had = parse(asked);
  const owed = parse(version);
  if (!had || !owed) return asked === version;
  for (let index = 0; index < Math.max(had.length, owed.length); index += 1) {
    const difference = (had[index] ?? 0) - (owed[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/**
 * Whether the account may be asked for `version`: not asked for it yet, and
 * PaperTok opened on three days or twenty papers viewed. Unreadable storage
 * asks nobody, since the use that qualifies a reader cannot be counted.
 */
export function pmfSurveyDue(uid: string | null | undefined, version: string, storage?: SurveyStorage | null) {
  const key = getPmfSurveyStorageKey(uid);
  const target = resolveStorage(storage);
  if (!key || !target) return false;
  const record = readRecord(key, target);
  if (versionSettled(record.asked, version)) return false;
  return record.days.length >= ACTIVE_DAYS || readSeenPaperIds(uid, target).size >= VIEWED_PAPERS;
}

/** What `pmf_survey` sends for an answer or a dismissal. */
export function pmfSurveyParams(answer: PmfSurveyAnswer, version: string) {
  if (answer === 'dismissed') return { disappointment: 'dismissed', app_version: version };
  return {
    disappointment: answer.disappointment,
    ...(answer.nps !== null && { nps: answer.nps }),
    app_version: version,
  };
}
