const LEDGER_ACTIONS = new Set(['reserve', 'release', 'peek']);
const MAX_SUBJECT_KEY_LENGTH = 96;
const MAX_LIMIT = 1_000_000;
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_LIMIT ? parsed : 0;
}

function safeSubjectKey(value) {
  const key = String(value || '').trim();
  return /^[a-f0-9]{64}$/.test(key) && key.length <= MAX_SUBJECT_KEY_LENGTH ? key : '';
}

export class RequestQuotaLedger {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    const payload = await request.json().catch(() => null);
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
    if (!LEDGER_ACTIONS.has(action) || !subjectKey || !subjectLimit || !globalLimit || !amount) {
      return json({ code: 'INVALID_REQUEST' }, 400);
    }

    const result = await this.state.storage.transaction(async transaction => {
      const subjectStorageKey = `subject:${subjectKey}`;
      const [subjectValue, globalValue] = await Promise.all([
        transaction.get(subjectStorageKey),
        transaction.get('global'),
      ]);
      const subjectUsage = Math.max(0, Number(subjectValue) || 0);
      const globalUsage = Math.max(0, Number(globalValue) || 0);

      // Reading the allowance must not spend it. The reader shows how many uses
      // are left before you commit one, and a peek that reserved would make the
      // number wrong by the act of looking at it.
      if (action === 'peek') {
        return {
          accepted: true,
          subjectUsage,
          globalUsage,
          remaining: Math.max(0, subjectLimit - subjectUsage),
        };
      }

      if (action === 'release') {
        // Nothing was delivered, so the use goes back -- as much of it as was
        // taken, which is why this reads `amount` too: giving one unit back to a
        // caller that reserved nine would leak eight of them every time. The floor
        // is what keeps a repeated release from minting quota that was never
        // reserved.
        const releasedSubjectUsage = Math.max(0, subjectUsage - amount);
        const releasedGlobalUsage = Math.max(0, globalUsage - amount);
        await Promise.all([
          transaction.put(subjectStorageKey, releasedSubjectUsage),
          transaction.put('global', releasedGlobalUsage),
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
      if (subjectUsage + amount > subjectLimit) {
        return { accepted: false, scope: 'user', subjectUsage, globalUsage };
      }
      if (globalUsage + amount > globalLimit) {
        return { accepted: false, scope: 'global', subjectUsage, globalUsage };
      }

      const nextSubjectUsage = subjectUsage + amount;
      const nextGlobalUsage = globalUsage + amount;
      await Promise.all([
        transaction.put(subjectStorageKey, nextSubjectUsage),
        transaction.put('global', nextGlobalUsage),
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

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function callRequestQuotaLedger(namespace, action, {
  periodKey,
  subject,
  subjectLimit,
  globalLimit,
  amount = 1,
}) {
  if (!namespace?.idFromName || !namespace?.get) {
    return { accepted: false, code: 'QUOTA_LEDGER_NOT_CONFIGURED' };
  }
  const subjectKey = await sha256(subject);
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
    }),
  });
  if (!response.ok) return { accepted: false, code: 'QUOTA_LEDGER_UNAVAILABLE' };
  return response.json();
}

export function reserveRequestQuota(namespace, options) {
  return callRequestQuotaLedger(namespace, 'reserve', options);
}

/**
 * What is left, without taking any of it. The reader shows the remaining daily
 * uses before you spend one, and the only other way to learn the number was to
 * reserve — which is to say, to make it wrong by asking.
 */
export function peekRequestQuota(namespace, options) {
  return callRequestQuotaLedger(namespace, 'peek', options);
}

/**
 * Gives a reserved use back. The caller has to hand over the same `periodKey`
 * it reserved with — recomputing today's key at release time would credit
 * tomorrow's ledger for a request that crossed UTC midnight — and the same
 * `amount`, for the same reason in the other direction.
 */
export function releaseRequestQuota(namespace, options) {
  return callRequestQuotaLedger(namespace, 'release', options);
}
