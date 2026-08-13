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
    if (payload?.action !== 'reserve' || !subjectKey || !subjectLimit || !globalLimit) {
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

      if (subjectUsage >= subjectLimit) {
        return { accepted: false, scope: 'user', subjectUsage, globalUsage };
      }
      if (globalUsage >= globalLimit) {
        return { accepted: false, scope: 'global', subjectUsage, globalUsage };
      }

      const nextSubjectUsage = subjectUsage + 1;
      const nextGlobalUsage = globalUsage + 1;
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

export async function reserveRequestQuota(namespace, {
  periodKey,
  subject,
  subjectLimit,
  globalLimit,
}) {
  if (!namespace?.idFromName || !namespace?.get) {
    return { accepted: false, code: 'QUOTA_LEDGER_NOT_CONFIGURED' };
  }
  const subjectKey = await sha256(subject);
  const id = namespace.idFromName(String(periodKey).slice(0, 160));
  const response = await namespace.get(id).fetch('https://papertok.internal/quota/reserve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'reserve',
      subjectKey,
      subjectLimit,
      globalLimit,
    }),
  });
  if (!response.ok) return { accepted: false, code: 'QUOTA_LEDGER_UNAVAILABLE' };
  return response.json();
}
