import type { LedgerStorage } from './ledger-storage.ts';
import type { WorkerEnv } from './env.ts';

export interface QuotaRequest {
  periodKey: string;
  subject: string;
  subjectLimit: number;
  globalLimit: number;
  amount?: number;
  // The share of the global ceiling this request may fill, in percent; absent
  // is all of it. One day of OpenAlex budget serves requests that do not
  // matter equally, and the less important ones stop first (PAP-88).
  percent?: number;
  // The name these units are counted under (`tier.kind`), so the day can be
  // read back by what spent it.
  tally?: string;
  // `observe` only: what the provider reports is left, in the same units.
  remaining?: number;
  // A part of the subject's allowance that this request spends: a second
  // subject with its own limit, checked and counted in the same transaction
  // as the subject and the day, and given back with them.
  part?: QuotaPart;
}

export interface QuotaPart {
  subject: string;
  limit: number;
}

export interface QuotaTally {
  used: Record<string, number>;
  refused: Record<string, number>;
}

export interface QuotaObservation {
  ceiling: number;
  at: number;
}

export interface QuotaReading {
  accepted?: boolean;
  released?: boolean;
  code?: string;
  scope?: string;
  subjectUsage?: number;
  globalUsage?: number;
  remaining?: number;
  observed?: QuotaObservation;
  tally?: QuotaTally;
}

const LEDGER_ACTIONS = new Set<unknown>(['reserve', 'release', 'peek', 'observe']);
const MAX_SUBJECT_KEY_LENGTH = 96;
const MAX_LIMIT = 1_000_000;
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
// A tally name comes from the Worker, never from a reader, but the object keeps
// every name in one value, so the number of names is bounded here too.
const TALLY_NAME = /^[a-z]{1,16}\.[a-z]{1,16}$/;
const MAX_TALLY_NAMES = 16;

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_LIMIT ? parsed : 0;
}

function safeSubjectKey(value: unknown) {
  const key = String(value || '').trim();
  return /^[a-f0-9]{64}$/.test(key) && key.length <= MAX_SUBJECT_KEY_LENGTH ? key : '';
}

// The optional fields: absent takes the default, and a value that is present
// but invalid makes the request malformed rather than falling back.
function optionalPercent(value: unknown) {
  if (value === undefined) return 100;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100 ? value as number : 0;
}

function optionalTally(value: unknown) {
  if (value === undefined) return '';
  return typeof value === 'string' && TALLY_NAME.test(value) ? value : null;
}

function optionalRemaining(value: unknown) {
  if (value === undefined) return undefined;
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_LIMIT ? value as number : null;
}

function storedTally(value: unknown): QuotaTally {
  const tally = value as Partial<QuotaTally> | undefined;
  return { used: { ...tally?.used }, refused: { ...tally?.refused } };
}

// A new name past the bound is left uncounted rather than refused: the tally
// reports the day, it does not decide it.
function addToTally(counts: Record<string, number>, name: string, amount: number) {
  if (!(name in counts) && Object.keys(counts).length >= MAX_TALLY_NAMES) return;
  counts[name] = Math.max(0, (counts[name] || 0) + amount);
}

function storedObservation(value: unknown): QuotaObservation | null {
  const observed = value as Partial<QuotaObservation> | undefined;
  return Number.isInteger(observed?.ceiling) && Number.isFinite(observed?.at)
    ? { ceiling: observed!.ceiling!, at: observed!.at! }
    : null;
}

export class RequestQuotaLedger {
  declare state: { storage: LedgerStorage & Pick<DurableObjectStorage, 'getAlarm' | 'setAlarm' | 'deleteAll'> };

  constructor(state: { storage: LedgerStorage & Pick<DurableObjectStorage, 'getAlarm' | 'setAlarm' | 'deleteAll'> }) {
    this.state = state;
  }

  async fetch(request: Request) {
    if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    const payload = await request.json<Record<string, unknown>>().catch(() => null);
    const subjectKey = safeSubjectKey(payload?.subjectKey);
    const subjectLimit = positiveInteger(payload?.subjectLimit);
    const globalLimit = positiveInteger(payload?.globalLimit);
    const action = payload?.action;
    // A caller that is about to spend several units of a billed allowance has to
    // be able to say so in one round trip: reserving one at a time either costs
    // N trips to this object or, worse, lets the ledger accept the first unit of
    // a request whose remaining units it would have refused. Absent means one,
    // which is what every caller written before this asked for.
    const amount = payload?.amount === undefined ? 1 : positiveInteger(payload.amount);
    const percent = optionalPercent(payload?.percent);
    const tallyName = optionalTally(payload?.tally);
    const reportedRemaining = optionalRemaining(payload?.remaining);
    const hasPart = payload?.partKey !== undefined || payload?.partLimit !== undefined;
    const partKey = hasPart ? safeSubjectKey(payload?.partKey) : '';
    const partLimit = hasPart ? positiveInteger(payload?.partLimit) : 0;
    if (!LEDGER_ACTIONS.has(action) || !subjectKey || !subjectLimit || !globalLimit || !amount
      || !percent || tallyName === null || reportedRemaining === null
      || (action === 'observe' && reportedRemaining === undefined)
      || (hasPart && (!partKey || !partLimit))) {
      return json({ code: 'INVALID_REQUEST' }, 400);
    }

    const result = await this.state.storage.transaction(async transaction => {
      const subjectStorageKey = `subject:${subjectKey}`;
      const partStorageKey = `subject:${partKey}`;
      const [subjectValue, globalValue, observedValue, tallyValue, partValue] = await Promise.all([
        transaction.get(subjectStorageKey),
        transaction.get('global'),
        transaction.get('observed'),
        transaction.get('tally'),
        partKey ? transaction.get(partStorageKey) : undefined,
      ]);
      const subjectUsage = Math.max(0, Number(subjectValue) || 0);
      const globalUsage = Math.max(0, Number(globalValue) || 0);
      const partUsage = Math.max(0, Number(partValue) || 0);
      const observed = storedObservation(observedValue);
      const tally = storedTally(tallyValue);

      // Reading the allowance must not spend it. The reader shows how many uses
      // are left before you commit one, and a peek that reserved would make the
      // number wrong by the act of looking at it. The observation and the tally
      // are reported only by the objects that have them.
      if (action === 'peek') {
        return {
          accepted: true,
          subjectUsage,
          globalUsage,
          remaining: Math.max(0, subjectLimit - subjectUsage),
          ...(observed ? { observed } : {}),
          ...(tallyValue === undefined ? {} : { tally }),
        };
      }

      // What the provider says is left, added to what is already counted, is
      // the most the day can still spend. The latest reading replaces the one
      // before: a low reading closes the day early, and credit added upstream
      // reopens it at the next reading.
      if (action === 'observe') {
        const reading = { ceiling: globalUsage + reportedRemaining!, at: Date.now() };
        await transaction.put('observed', reading);
        return { observed: reading, globalUsage };
      }

      if (action === 'release') {
        // Nothing was delivered, so the use goes back -- as much of it as was
        // taken, which is why this reads `amount` too: giving one unit back to a
        // caller that reserved nine would leak eight of them every time. The floor
        // is what keeps a repeated release from minting quota that was never
        // reserved.
        const releasedSubjectUsage = Math.max(0, subjectUsage - amount);
        const releasedGlobalUsage = Math.max(0, globalUsage - amount);
        if (tallyName) addToTally(tally.used, tallyName, -amount);
        await Promise.all([
          transaction.put(subjectStorageKey, releasedSubjectUsage),
          transaction.put('global', releasedGlobalUsage),
          tallyName ? transaction.put('tally', tally) : undefined,
          partKey ? transaction.put(partStorageKey, Math.max(0, partUsage - amount)) : undefined,
        ]);
        return {
          released: true,
          subjectUsage: releasedSubjectUsage,
          globalUsage: releasedGlobalUsage,
          remaining: Math.max(0, subjectLimit - releasedSubjectUsage),
        };
      }

      // `usage + amount > limit` rather than `usage >= limit`: with an amount of
      // one the two are the same condition, and with more than one it is the only
      // one that refuses a reservation the allowance cannot actually cover.
      // The global check is against this request's share of the ceiling, and
      // the whole day's usage counts against it, whoever spent it.
      const ceiling = observed ? Math.min(globalLimit, observed.ceiling) : globalLimit;
      const limit = Math.floor(ceiling * percent / 100);
      const scope = subjectUsage + amount > subjectLimit
        ? 'user'
        : partKey && partUsage + amount > partLimit
          ? 'part'
          : globalUsage + amount > limit ? 'global' : '';
      // Only the day's share refusing is tallied: a subject's refusal (for
      // OpenAlex, the minute's ceiling) is a burst rather than a closed tier,
      // and counting it would add a write here exactly when the object is
      // busiest.
      if (scope) {
        if (tallyName && scope === 'global') {
          addToTally(tally.refused, tallyName, amount);
          await transaction.put('tally', tally);
        }
        return { accepted: false, scope, subjectUsage, globalUsage };
      }

      const nextSubjectUsage = subjectUsage + amount;
      const nextGlobalUsage = globalUsage + amount;
      if (tallyName) addToTally(tally.used, tallyName, amount);
      await Promise.all([
        transaction.put(subjectStorageKey, nextSubjectUsage),
        transaction.put('global', nextGlobalUsage),
        tallyName ? transaction.put('tally', tally) : undefined,
        partKey ? transaction.put(partStorageKey, partUsage + amount) : undefined,
      ]);
      return {
        accepted: true,
        subjectUsage: nextSubjectUsage,
        globalUsage: nextGlobalUsage,
        remaining: Math.max(0, subjectLimit - nextSubjectUsage),
      };
    });

    const alarm = await this.state.storage.getAlarm();
    if (alarm === null) await this.state.storage.setAlarm(Date.now() + RETENTION_MS);
    return json(result);
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

async function sha256(value: unknown) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function callRequestQuotaLedger(namespace: WorkerEnv['REQUEST_QUOTA_LEDGER'] | null, action: string, {
  periodKey,
  subject,
  subjectLimit,
  globalLimit,
  amount = 1,
  percent,
  tally,
  remaining,
  part,
}: QuotaRequest): Promise<QuotaReading> {
  if (!namespace?.idFromName || !namespace?.get) {
    return { accepted: false, code: 'QUOTA_LEDGER_NOT_CONFIGURED' };
  }
  const subjectKey = await sha256(subject);
  const partKey = part ? await sha256(part.subject) : undefined;
  const id = namespace.idFromName(String(periodKey).slice(0, 160));
  const response = await namespace.get(id).fetch(`https://papertok.internal/quota/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action,
      subjectKey,
      subjectLimit,
      globalLimit,
      amount,
      // JSON leaves an undefined field out, and the object reads its absence
      // as the default.
      percent,
      tally,
      remaining,
      partKey,
      partLimit: part?.limit,
    }),
  });
  if (!response.ok) return { accepted: false, code: 'QUOTA_LEDGER_UNAVAILABLE' };
  return response.json<QuotaReading>();
}

export function reserveRequestQuota(namespace: WorkerEnv['REQUEST_QUOTA_LEDGER'] | null, options: QuotaRequest) {
  return callRequestQuotaLedger(namespace, 'reserve', options);
}

/**
 * What is left, without taking any of it. The reader shows the remaining daily
 * uses before you spend one, and the only other way to learn the number was to
 * reserve — which is to say, to make it wrong by asking.
 */
export function peekRequestQuota(namespace: WorkerEnv['REQUEST_QUOTA_LEDGER'] | null, options: QuotaRequest) {
  return callRequestQuotaLedger(namespace, 'peek', options);
}

/**
 * Records what the provider reports is left (`remaining`). Until the next
 * reading, the global ceiling is the lower of `globalLimit` and the usage at
 * this reading plus `remaining`.
 */
export function observeRequestQuota(namespace: WorkerEnv['REQUEST_QUOTA_LEDGER'] | null, options: QuotaRequest) {
  return callRequestQuotaLedger(namespace, 'observe', options);
}

/**
 * Gives a reserved use back. The caller has to hand over the same `periodKey`
 * it reserved with — recomputing today's key at release time would credit
 * tomorrow's ledger for a request that crossed UTC midnight — and the same
 * `amount`, for the same reason in the other direction.
 */
export function releaseRequestQuota(namespace: WorkerEnv['REQUEST_QUOTA_LEDGER'] | null, options: QuotaRequest) {
  return callRequestQuotaLedger(namespace, 'release', options);
}
