import type { LedgerStorage } from './ledger-storage.ts';
export interface SourceSummaryInput {
  attempted?: unknown;
  succeeded?: unknown;
  failed?: unknown;
  requestAttempts?: unknown;
  retried?: unknown;
  requiredFailed?: unknown;
  bySource?: Record<string, Omit<SourceSummaryInput, 'bySource' | 'failureCodes'>>;
  failureCodes?: Record<string, unknown>;
}

export interface DeliveryInput {
  kind?: unknown;
  sentAt?: unknown;
  paperCount?: unknown;
  paperKeys?: unknown[];
  partial?: unknown;
  sources?: SourceSummaryInput;
}

export interface DeliveryDraftInput {
  provider?: unknown;
  recipient?: { email?: unknown; displayName?: unknown };
  content?: { subject?: unknown; html?: unknown; text?: unknown };
  unsubscribeUrl?: unknown;
  delivery?: DeliveryInput;
}

export type Delivery = ReturnType<typeof sanitizeDelivery>;
export type DeliveryDraft = NonNullable<ReturnType<typeof sanitizeDraft>>;
interface LedgerMeta { committed?: unknown; reserved?: unknown }
export interface DeliveryReservation {
  status: string;
  attempts?: number;
  reservedAt?: string;
  committedAt?: string;
  draft?: DeliveryDraft;
  delivery?: Delivery;
}
export interface DeliveryLedgerState extends LedgerMeta {
  reservations?: Record<string, DeliveryReservation>;
}
export interface DeliveryLedgerPayload {
  action?: string;
  reservationId?: unknown;
  limit?: unknown;
  now?: string;
  retryMinAgeMs?: unknown;
  retryWindowMs?: unknown;
  draft?: DeliveryDraftInput;
  delivery?: DeliveryInput;
}
export interface DeliveryLedgerResult {
  accepted?: boolean;
  duplicate?: boolean;
  retry?: boolean;
  released?: boolean;
  status?: string;
  committed?: number | boolean;
  committedCount?: number;
  reserved?: number;
  limit?: number;
  attempts?: number;
  reservedAt?: string;
  committedAt?: string;
  draft?: DeliveryDraft;
  delivery?: Delivery;
  code?: string;
}

const MAX_RESERVATION_ID_LENGTH = 220;
const MAX_DELIVERY_PAPER_KEYS = 400;
const MAX_RESERVATION_ATTEMPTS = 2;
const LEDGER_META_KEY = 'meta';
const LEDGER_RESERVATION_PREFIX = 'reservation:';
const LEDGER_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

function positiveInteger(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function boundedString(value: unknown, maxLength: number) {
  return String(value || '').trim().slice(0, maxLength);
}

function boundedCounts(value: Record<string, unknown> = {}, maxEntries = 24) {
  return Object.fromEntries(Object.entries(value || {})
    .map(([key, count]): [string, number] => [
      boundedString(key, 80).replace(/[^a-zA-Z0-9:_-]/g, '_'),
      positiveInteger(count),
    ])
    .filter(([key, count]) => key && count > 0)
    .slice(0, maxEntries));
}

function sanitizeSourceSummary(value: SourceSummaryInput = {}) {
  const bySource = Object.fromEntries(Object.entries(value.bySource || {})
    .map(([source, counts]): [string, { attempted: number; succeeded: number; failed: number; requestAttempts: number; retried: number }] => [
      boundedString(source, 40).replace(/[^a-zA-Z0-9_-]/g, '_'),
      {
        attempted: positiveInteger(counts?.attempted),
        succeeded: positiveInteger(counts?.succeeded),
        failed: positiveInteger(counts?.failed),
        requestAttempts: positiveInteger(counts?.requestAttempts),
        retried: positiveInteger(counts?.retried),
      },
    ])
    .filter(([source]) => source)
    .slice(0, 8));
  return {
    attempted: positiveInteger(value.attempted),
    succeeded: positiveInteger(value.succeeded),
    failed: positiveInteger(value.failed),
    requestAttempts: positiveInteger(value.requestAttempts),
    retried: positiveInteger(value.retried),
    requiredFailed: positiveInteger(value.requiredFailed),
    bySource,
    failureCodes: boundedCounts(value.failureCodes),
  };
}

function sanitizeDelivery(value: DeliveryInput = {}) {
  const paperKeys = Array.isArray(value.paperKeys)
    ? [...new Set(value.paperKeys
      .map(key => boundedString(key, 700))
      .filter(Boolean))].slice(-MAX_DELIVERY_PAPER_KEYS)
    : [];
  return {
    kind: value.kind === 'test' ? 'test' : 'digest',
    sentAt: boundedString(value.sentAt, 40),
    paperCount: positiveInteger(value.paperCount),
    paperKeys,
    partial: Boolean(value.partial),
    sources: sanitizeSourceSummary(value.sources),
  };
}

function sanitizeDraft(value: DeliveryDraftInput = {}) {
  if (!value || typeof value !== 'object') return null;
  const provider = value.provider === 'resend' ? 'resend' : value.provider === 'brevo' ? 'brevo' : '';
  const email = boundedString(value.recipient?.email, 320);
  const subject = boundedString(value.content?.subject, 500);
  if (!provider || !email || !subject) return null;
  return {
    provider,
    recipient: {
      email,
      displayName: boundedString(value.recipient?.displayName, 160),
    },
    content: {
      subject,
      html: boundedString(value.content?.html, 120_000),
      text: boundedString(value.content?.text, 40_000),
    },
    unsubscribeUrl: boundedString(value.unsubscribeUrl, 1_000),
    delivery: sanitizeDelivery(value.delivery),
  };
}

function normalizeMeta(value: LedgerMeta | null = {}) {
  return {
    committed: positiveInteger(value?.committed),
    reserved: positiveInteger(value?.reserved),
  };
}

function normalizeFallbackState(value: DeliveryLedgerState | null = {}) {
  return {
    ...normalizeMeta(value),
    reservations: value?.reservations && typeof value.reservations === 'object'
      ? { ...value.reservations }
      : {},
  };
}

function reservationKey(reservationId: string) {
  return `${LEDGER_RESERVATION_PREFIX}${reservationId}`;
}

function publicReservation(existing: DeliveryReservation, meta: ReturnType<typeof normalizeMeta>, extra: Partial<DeliveryLedgerResult> = {}): DeliveryLedgerResult {
  return {
    accepted: true,
    duplicate: true,
    retry: false,
    status: existing.status,
    committed: meta.committed,
    reserved: meta.reserved,
    attempts: positiveInteger(existing.attempts, 1),
    ...(existing.reservedAt ? { reservedAt: existing.reservedAt } : {}),
    ...(existing.committedAt ? { committedAt: existing.committedAt } : {}),
    ...(existing.draft ? { draft: existing.draft } : {}),
    ...(existing.delivery ? { delivery: existing.delivery } : {}),
    ...extra,
  };
}

function applyReservationAction(metaInput: LedgerMeta | null | undefined, existingInput: DeliveryReservation | null | undefined, payload: DeliveryLedgerPayload = {}): {
  status: number;
  meta: ReturnType<typeof normalizeMeta>;
  reservation: DeliveryReservation | null;
  result: DeliveryLedgerResult;
  deleteReservation?: boolean;
} {
  const meta = normalizeMeta(metaInput);
  const existing = existingInput && typeof existingInput === 'object' ? { ...existingInput } : null;
  const action = payload.action;

  if (action === 'inspect') {
    return {
      status: 200,
      meta,
      reservation: existing,
      result: existing
        ? publicReservation(existing, meta)
        : { accepted: true, duplicate: false, status: 'missing', committed: meta.committed, reserved: meta.reserved },
    };
  }

  if (action === 'reserve') {
    const limit = positiveInteger(payload.limit);
    if (!limit) return { status: 400, meta, reservation: existing, result: { code: 'INVALID_REQUEST' } };
    if (existing) {
      const now = Date.parse(payload.now || '');
      const reservedAt = Date.parse(existing.reservedAt || '');
      const attempts = positiveInteger(existing.attempts, 1);
      const retryMinAgeMs = positiveInteger(payload.retryMinAgeMs);
      const retryWindowMs = positiveInteger(payload.retryWindowMs);
      const canRetryPending = (
        existing.status === 'reserved'
        && Boolean(existing.draft)
        && attempts < MAX_RESERVATION_ATTEMPTS
        && retryWindowMs > 0
        && Number.isFinite(now)
        && Number.isFinite(reservedAt)
        && now >= reservedAt
        && now - reservedAt >= retryMinAgeMs
        && now - reservedAt <= retryWindowMs
      );
      if (canRetryPending) existing.attempts = attempts + 1;
      return {
        status: 200,
        meta,
        reservation: existing,
        result: publicReservation(existing, meta, {
          retry: canRetryPending,
          attempts: positiveInteger(existing.attempts, attempts),
        }),
      };
    }
    if (meta.committed + meta.reserved >= limit) {
      return {
        status: 200,
        meta,
        reservation: null,
        result: {
          accepted: false,
          code: 'EMAIL_PROVIDER_LIMIT',
          committed: meta.committed,
          reserved: meta.reserved,
          limit,
        },
      };
    }
    const draft = sanitizeDraft(payload.draft);
    const reservation = {
      status: 'reserved',
      reservedAt: boundedString(payload.now, 40),
      attempts: 1,
      ...(draft ? { draft } : {}),
    };
    meta.reserved += 1;
    return {
      status: 200,
      meta,
      reservation,
      result: {
        accepted: true,
        duplicate: false,
        status: 'reserved',
        committed: meta.committed,
        reserved: meta.reserved,
        limit,
        ...(draft ? { draft } : {}),
      },
    };
  }

  if (action === 'release') {
    if (!existing) {
      return {
        status: 200,
        meta,
        reservation: null,
        deleteReservation: true,
        result: { released: true, status: 'released', committed: meta.committed, reserved: meta.reserved },
      };
    }
    if (existing.status === 'committed') {
      return {
        status: 200,
        meta,
        reservation: existing,
        result: {
          released: false,
          status: 'committed',
          committed: meta.committed,
          reserved: meta.reserved,
          delivery: existing.delivery,
        },
      };
    }
    meta.reserved = Math.max(0, meta.reserved - 1);
    return {
      status: 200,
      meta,
      reservation: null,
      deleteReservation: true,
      result: { released: true, status: 'released', committed: meta.committed, reserved: meta.reserved },
    };
  }

  if (action === 'commit') {
    if (!existing) {
      return {
        status: 409,
        meta,
        reservation: null,
        result: { committed: false, code: 'RESERVATION_NOT_FOUND' },
      };
    }
    if (existing.status === 'committed') {
      return {
        status: 200,
        meta,
        reservation: existing,
        result: {
          committed: true,
          duplicate: true,
          status: 'committed',
          committedCount: meta.committed,
          reserved: meta.reserved,
          delivery: existing.delivery,
        },
      };
    }
    const delivery = sanitizeDelivery(payload.delivery || existing.draft?.delivery);
    const reservation = {
      status: 'committed',
      committedAt: boundedString(payload.now, 40),
      delivery,
    };
    meta.reserved = Math.max(0, meta.reserved - 1);
    meta.committed += 1;
    return {
      status: 200,
      meta,
      reservation,
      result: {
        committed: true,
        duplicate: false,
        status: 'committed',
        committedCount: meta.committed,
        reserved: meta.reserved,
        delivery,
      },
    };
  }

  return { status: 400, meta, reservation: existing, result: { code: 'INVALID_REQUEST' } };
}

export function applyEmailDeliveryLedgerAction(currentState: DeliveryLedgerState | null | undefined, payload: DeliveryLedgerPayload = {}) {
  const state = normalizeFallbackState(currentState);
  const reservationId = boundedString(payload.reservationId, MAX_RESERVATION_ID_LENGTH);
  if (!reservationId || !['inspect', 'reserve', 'commit', 'release'].includes(payload.action!)) {
    return { status: 400, state, result: { code: 'INVALID_REQUEST' } };
  }
  const outcome = applyReservationAction(state, state.reservations[reservationId], payload);
  const nextState = {
    committed: outcome.meta.committed,
    reserved: outcome.meta.reserved,
    reservations: { ...state.reservations },
  };
  if (outcome.deleteReservation) delete nextState.reservations[reservationId];
  else if (outcome.reservation) nextState.reservations[reservationId] = outcome.reservation;
  return { status: outcome.status, state: nextState, result: outcome.result };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export class EmailDeliveryLedger {
  declare state: { storage: LedgerStorage & Pick<DurableObjectStorage, 'setAlarm' | 'deleteAll'> };

  constructor(state: { storage: LedgerStorage & Pick<DurableObjectStorage, 'setAlarm' | 'deleteAll'> }) {
    this.state = state;
  }

  async fetch(request: Request) {
    if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    const payload = await request.json<DeliveryLedgerPayload>().catch(() => null);
    const reservationId = boundedString(payload?.reservationId, MAX_RESERVATION_ID_LENGTH);
    if (!payload || !reservationId || !['inspect', 'reserve', 'commit', 'release'].includes(payload.action!)) {
      return json({ code: 'INVALID_REQUEST' }, 400);
    }

    const storageKey = reservationKey(reservationId);
    const outcome = await this.state.storage.transaction(async (transaction) => {
      const [meta, existing] = await Promise.all([
        transaction.get<LedgerMeta>(LEDGER_META_KEY),
        transaction.get<DeliveryReservation>(storageKey),
      ]);
      const next = applyReservationAction(meta, existing, payload);
      if (next.status < 400 && payload.action !== 'inspect') {
        await transaction.put(LEDGER_META_KEY, next.meta);
        if (next.deleteReservation) await transaction.delete(storageKey);
        else if (next.reservation) await transaction.put(storageKey, next.reservation);
      }
      return next;
    });

    if (outcome.status < 400 && payload.action !== 'inspect' && this.state.storage.setAlarm) {
      await this.state.storage.setAlarm(Date.now() + LEDGER_RETENTION_MS);
    }
    return json(outcome.result, outcome.status);
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}
