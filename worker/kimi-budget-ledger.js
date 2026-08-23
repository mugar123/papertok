const MICROS_PER_USD = 1_000_000;
const DEFAULT_PROMPT_USD_PER_MILLION = 3;
const DEFAULT_CACHED_PROMPT_USD_PER_MILLION = 0.3;
const DEFAULT_OUTPUT_USD_PER_MILLION = 15;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(value, fallback = 0) {
  return Math.max(0, Math.ceil(finiteNumber(value, fallback)));
}

export function usdToMicros(value) {
  return Math.max(0, Math.ceil(finiteNumber(value) * MICROS_PER_USD));
}

export function microsToUsd(value) {
  return Math.max(0, finiteNumber(value)) / MICROS_PER_USD;
}

export function getMonthlyBudgetReset(now = Date.now()) {
  const current = new Date(now);
  const resetAt = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1);
  return {
    resetAt: new Date(resetAt).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - current.getTime()) / 1_000)),
  };
}

export function estimateKimiReservationMicros({
  promptBytes,
  maxOutputTokens,
  promptUsdPerMillion = DEFAULT_PROMPT_USD_PER_MILLION,
  outputUsdPerMillion = DEFAULT_OUTPUT_USD_PER_MILLION,
}) {
  // One UTF-8 byte per prompt token is a deliberately high upper bound. Kimi's
  // output cap includes reasoning, but reserving it twice protects against
  // providers reporting/billing visible completion and reasoning separately.
  const promptTokensUpperBound = positiveInteger(promptBytes) + 1_024;
  const outputTokensUpperBound = positiveInteger(maxOutputTokens) * 2;
  const costUsd = (
    (promptTokensUpperBound * finiteNumber(promptUsdPerMillion, DEFAULT_PROMPT_USD_PER_MILLION))
    + (outputTokensUpperBound * finiteNumber(outputUsdPerMillion, DEFAULT_OUTPUT_USD_PER_MILLION))
  ) / 1_000_000;
  return usdToMicros(costUsd);
}

export function calculateKimiUsageMicros(usage = {}, {
  promptUsdPerMillion = DEFAULT_PROMPT_USD_PER_MILLION,
  cachedPromptUsdPerMillion = DEFAULT_CACHED_PROMPT_USD_PER_MILLION,
  outputUsdPerMillion = DEFAULT_OUTPUT_USD_PER_MILLION,
} = {}) {
  const promptTokens = positiveInteger(usage.prompt_tokens);
  const cachedPromptTokens = Math.min(
    promptTokens,
    positiveInteger(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_prompt_tokens),
  );
  const regularPromptTokens = Math.max(0, promptTokens - cachedPromptTokens);
  const completionTokens = positiveInteger(usage.completion_tokens);
  const reasoningTokens = positiveInteger(
    usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
  );
  const costUsd = (
    (regularPromptTokens * finiteNumber(promptUsdPerMillion, DEFAULT_PROMPT_USD_PER_MILLION))
    + (cachedPromptTokens * finiteNumber(cachedPromptUsdPerMillion, DEFAULT_CACHED_PROMPT_USD_PER_MILLION))
    // Counting reasoning in addition to completion is intentionally conservative.
    + ((completionTokens + reasoningTokens) * finiteNumber(outputUsdPerMillion, DEFAULT_OUTPUT_USD_PER_MILLION))
  ) / 1_000_000;
  return usdToMicros(costUsd);
}

const RESERVATION_PREFIX = 'reservation:';
// A reservation only lives while the Modal call is in flight, and that call is
// capped well under a minute. Five minutes is a wide margin for it, and short
// enough that a reservation orphaned between reserve and settle — a cancelled
// request, an eviction — stops shrinking the monthly cap almost at once instead
// of until the first of next month.
export const RESERVATION_TTL_MS = 5 * 60 * 1000;

/**
 * Reservations used to be a bare number, with nothing to tell a live one from
 * the leftovers of an invocation that died before settling. A legacy entry is
 * not dropped on sight — that could cancel a reservation still in flight during
 * a deploy — it is handed a full TTL counted from now.
 */
function reservationRecord(value, now) {
  const isObject = value !== null && typeof value === 'object';
  const expiresAt = isObject ? Number(value.expiresAt) : Number.NaN;
  const dated = Number.isFinite(expiresAt);
  return {
    amountMicros: positiveInteger(isObject ? value.amountMicros : value),
    expiresAt: dated ? expiresAt : now + RESERVATION_TTL_MS,
    dated,
  };
}

async function sweepExpiredReservations(transaction, now) {
  const entries = await transaction.list({ prefix: RESERVATION_PREFIX });
  let releasedMicros = 0;
  for (const [key, value] of entries) {
    const record = reservationRecord(value, now);
    if (record.expiresAt <= now) {
      await transaction.delete(key);
      releasedMicros += record.amountMicros;
    } else if (!record.dated) {
      await transaction.put(key, { amountMicros: record.amountMicros, expiresAt: record.expiresAt });
    }
  }
  return releasedMicros;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export class KimiBudgetLedger {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    const payload = await request.json().catch(() => null);
    const action = payload?.action;
    const reservationId = String(payload?.reservationId || '').slice(0, 160);
    if (!reservationId || !['reserve', 'settle'].includes(action)) {
      return json({ code: 'INVALID_REQUEST' }, 400);
    }

    const result = await this.state.storage.transaction(async transaction => {
      const now = Date.now();
      const reservationKey = `${RESERVATION_PREFIX}${reservationId}`;
      const [spentValue, reservedValue, existingReservation] = await Promise.all([
        transaction.get('spentMicros'),
        transaction.get('reservedMicros'),
        transaction.get(reservationKey),
      ]);
      const spentMicros = positiveInteger(spentValue);
      const reservedMicros = positiveInteger(reservedValue);

      if (action === 'reserve') {
        if (existingReservation) {
          return {
            accepted: true,
            reservationMicros: reservationRecord(existingReservation, now).amountMicros,
            spentMicros,
            reservedMicros,
          };
        }
        const releasedMicros = await sweepExpiredReservations(transaction, now);
        const liveReservedMicros = Math.max(0, reservedMicros - releasedMicros);
        // Written before the cap check: those keys are already gone, so a
        // rejected reservation must not leave the counter claiming otherwise.
        if (releasedMicros) await transaction.put('reservedMicros', liveReservedMicros);
        const amountMicros = positiveInteger(payload.amountMicros);
        const hardCapMicros = positiveInteger(payload.hardCapMicros);
        if (!amountMicros || !hardCapMicros || spentMicros + liveReservedMicros + amountMicros > hardCapMicros) {
          return { accepted: false, spentMicros, reservedMicros: liveReservedMicros, hardCapMicros };
        }
        await Promise.all([
          transaction.put(reservationKey, { amountMicros, expiresAt: now + RESERVATION_TTL_MS }),
          transaction.put('reservedMicros', liveReservedMicros + amountMicros),
        ]);
        return {
          accepted: true,
          reservationMicros: amountMicros,
          spentMicros,
          reservedMicros: liveReservedMicros + amountMicros,
          hardCapMicros,
        };
      }

      if (!existingReservation) {
        // Nothing to settle against: a second settle for the same id, or one
        // arriving after the sweep took the reservation. Staying a no-op keeps
        // settle idempotent, which matters more than the spend it declines to
        // count — charging an amount with no reservation to bound it would make
        // a double settle charge twice, and a call cannot outlive its own
        // reservation anyway (52 s cap against a 5 min TTL).
        return { settled: true, spentMicros, reservedMicros };
      }
      const reservationMicros = reservationRecord(existingReservation, now).amountMicros;
      const chargedMicros = Math.min(
        reservationMicros,
        positiveInteger(payload.chargedMicros, reservationMicros),
      );
      const nextSpentMicros = spentMicros + chargedMicros;
      const nextReservedMicros = Math.max(0, reservedMicros - reservationMicros);
      await Promise.all([
        transaction.delete(reservationKey),
        transaction.put('spentMicros', nextSpentMicros),
        transaction.put('reservedMicros', nextReservedMicros),
      ]);
      return {
        settled: true,
        spentMicros: nextSpentMicros,
        reservedMicros: nextReservedMicros,
        chargedMicros,
      };
    });

    return json(result);
  }
}
