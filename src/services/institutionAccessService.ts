import type { LinkedInstitution } from './institutionService.ts';
type InstitutionInput = Partial<LinkedInstitution>;
interface AccessOperations { request?: typeof authenticatedWorkerFetch; apiBase?: string; currentUid?: () => string | null | undefined }
interface AccessPayload { code?: string; status?: string; url?: unknown; collection?: unknown }
interface ServicesPayload { code?: string; services?: Array<Record<string, unknown>>; unchecked?: number; partial?: boolean; nextOffset?: unknown; catalogue?: unknown }
type InstitutionAccess = NonNullable<ReturnType<typeof normalizeInstitutionAccess>>;
type ServicesAnswer = (NonNullable<ReturnType<typeof normalizeInstitutionServices>> & { unsupported?: false }) | (typeof UNSUPPORTED_SERVICES & { unchecked?: never });

/**
 * Whether the reader's linked institution gives access to a paper's published
 * version, through the Worker's `GET /access`.
 *
 * The answer belongs to the institution, not the reader, so the memory cache is
 * keyed by domain and DOI and survives an account change: a different account
 * with the same institution would get the same answer. The tiers follow the
 * Worker's own: a definite answer for a week, `unknown` for six hours, and a
 * failure not at all, so an outage costs a retry rather than a wrong chip.
 *
 * The library's platform list (`GET /institution/services`) follows the same
 * tiers, kept per account and institution, since it also holds where a list
 * cut short goes on: no other account or institution picks that up.
 */
import { auth } from './firebase.ts';
import { authenticatedWorkerFetch, workerSourceUrl } from './workerApiClient.ts';
import { normalizeDoi } from './unpaywallService.ts';
import { safeExternalUrl } from '../utils/externalUrl.ts';
import { withEnforcedDeadline, withRequestDeadline } from '../utils/requestDeadline.ts';

const DEFINITE_TTL = 7 * 24 * 60 * 60 * 1000;
const UNKNOWN_TTL = 6 * 60 * 60 * 1000;
// Above the Worker's own 8 s lookup deadline, so a slow answer still lands
// here and in both caches instead of being abandoned and asked again.
const REQUEST_TIMEOUT_MS = 10000;
const STATUSES = new Set(['entitled', 'not-entitled', 'unknown']);

const answers = new Map<string, { access: InstitutionAccess; expiresAt: number }>();
const inFlight = new Map<string, Promise<InstitutionAccess | null>>();
// Domains the Worker has no resolver for. It will not gain one mid-session, and
// every card of every reader from that domain would otherwise ask again.
const unsupportedDomains = new Set<string>();

function operations(overrides: AccessOperations = {}) {
  return {
    request: overrides.request || authenticatedWorkerFetch,
    currentUid: overrides.currentUid || (() => auth.currentUser?.uid),
    apiBase: overrides.apiBase === undefined
      ? import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '')
      : overrides.apiBase,
  };
}

function cleanString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The Worker's answer in the shape the card reads, or null when it is not one. */
function normalizeInstitutionAccess(payload: AccessPayload | null) {
  if (!payload || !STATUSES.has(payload.status!)) return null;
  const url = safeExternalUrl(payload.url) || null;
  // Entitled means a link the reader can follow: without one there is nothing
  // the chip could honestly promise, so the answer is treated as no answer.
  if (payload.status === 'entitled' && !url) return null;
  return { status: payload.status, collection: cleanString(payload.collection), url };
}

async function lookUp(api: ReturnType<typeof operations>, doi: string, institution: InstitutionInput & { domain: string }) {
  const url = workerSourceUrl('/access', {
    doi,
    domain: institution.domain,
    entityId: cleanString(institution.entityId),
    rorId: cleanString(institution.rorId),
  }, api.apiBase);
  if (!url) return null;
  try {
    const response = await api.request(url, withRequestDeadline({ headers: { accept: 'application/json' } }, REQUEST_TIMEOUT_MS));
    // Read inside the try: the deadline covers the body too.
    const payload = await response.json().catch(() => null) as AccessPayload | null;
    if (!response.ok) {
      if (response.status === 404 && payload?.code === 'INSTITUTION_NOT_SUPPORTED') {
        unsupportedDomains.add(institution.domain);
      }
      return null;
    }
    const access = normalizeInstitutionAccess(payload);
    if (access) {
      const ttl = access.status === 'unknown' ? UNKNOWN_TTL : DEFINITE_TTL;
      answers.set(`${institution.domain}|${doi}`, { access, expiresAt: Date.now() + ttl });
    }
    return access;
  } catch {
    // No session, a timeout or an outage: nothing can be said, and nothing is kept.
    return null;
  }
}

/**
 * `{ status, collection, url }` for the DOI at the institution, or null when
 * nothing can be said. `institution` is the linked record (`useAuth().institution`).
 */
export function findInstitutionAccess(rawDoi: unknown, institution: InstitutionInput | null | undefined, overrides?: AccessOperations) {
  const doi = normalizeDoi(rawDoi);
  const domain = typeof institution?.domain === 'string' ? institution.domain.trim().toLowerCase() : '';
  if (!doi.startsWith('10.') || !domain || unsupportedDomains.has(domain)) return Promise.resolve(null);

  const key = `${domain}|${doi}`;
  const cached = answers.get(key);
  if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.access);
  if (inFlight.has(key)) return inFlight.get(key)!;

  const pending = lookUp(operations(overrides), doi, { ...institution, domain })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

const SERVICES_TTL = 7 * 24 * 60 * 60 * 1000;
// A partial answer is the Worker's deadline cutting some probes short, or the
// page and time limits below stopping the list: the missing platforms are
// unasked, not absent, so the gap is worth filling soon.
const PARTIAL_SERVICES_TTL = 60 * 60 * 1000;
// Above the Worker's own 12 s probe deadline, for the same reason as above.
const SERVICES_TIMEOUT_MS = 15000;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const UNSUPPORTED_SERVICES = Object.freeze({ services: Object.freeze([]), partial: false, unsupported: true });

type ServicesList = NonNullable<ReturnType<typeof normalizeInstitutionServices>>;
/**
 * What a library's list shows (`answer`, until `expiresAt`), and the reading
 * of the catalogue the page or time limit stopped: what it found (`partial`
 * only when a page was), where the next run goes on and the Worker's
 * `catalogue` that position belongs to. While a newer reading is under way the
 * last list read to the end stays the answer (`finished`), so a refresh never
 * shows less than there was.
 */
interface ServicesReading { found: ServicesList; next: number; catalogue: string }
const serviceAnswers = new Map<string, { answer: ServicesList; expiresAt: number; finished: boolean; reading: ServicesReading | null }>();
const servicesInFlight = new Map<string, Promise<ServicesAnswer | null>>();

function normalizeService(raw: Record<string, unknown> | null | undefined) {
  const id = cleanString(raw?.id);
  const name = cleanString(raw?.name);
  if (!id || !name) return null;
  const monogram = cleanString(raw!.monogram);
  return {
    id,
    name,
    publisher: cleanString(raw!.publisher),
    url: safeExternalUrl(raw!.url) || null,
    monogram: monogram && Array.from(monogram).length <= 4 ? monogram : Array.from(name)[0],
    color: typeof raw!.color === 'string' && HEX_COLOR.test(raw!.color) ? raw!.color.toLowerCase() : null,
    collection: cleanString(raw!.collection),
    // Absent (an older Worker) reads as the publisher's own platform.
    ownPlatform: raw!.ownPlatform !== false,
  };
}

function normalizeInstitutionServices(payload: ServicesPayload | null) {
  if (!payload || !Array.isArray(payload.services)) return null;
  const seen = new Set<string>();
  const services = [];
  for (const raw of payload.services) {
    const service = normalizeService(raw);
    if (!service || seen.has(service.id)) continue;
    seen.add(service.id);
    services.push(service);
  }
  const unchecked = Number.isInteger(payload.unchecked) && payload.unchecked! > 0 ? payload.unchecked! : 0;
  return { services, partial: payload.partial === true, unchecked };
}

async function lookUpServices(api: ReturnType<typeof operations>, institution: InstitutionInput & { domain: string }, key: string) {
  const stored = serviceAnswers.get(key);
  const finished = stored?.finished ? stored.answer : null;
  // A reading the page or time limit stopped goes on where it stopped, with
  // what it found. Starting over spent the same pages on the same first
  // titles every time, from the edge cache or not, and never reached the rest.
  let kept = stored?.reading ?? null;
  let found: ServicesList = kept
    ? { services: [...kept.found.services], partial: kept.found.partial, unchecked: kept.found.unchecked }
    : { services: [], partial: false, unchecked: 0 };
  let seen = new Set(found.services.map(service => service.id));
  let offset = kept ? kept.next : 0;
  let catalogue = kept ? kept.catalogue : null;
  let received = false;
  let resumable = true;
  const startOver = () => {
    kept = null;
    found = { services: [], partial: false, unchecked: 0 };
    seen = new Set();
    offset = 0;
    catalogue = null;
    received = false;
  };
  const signal = AbortSignal.timeout(45000);
  try {
    // A bad continuation cannot keep the browser probing indefinitely.
    for (let page = 0; page < 10; page += 1) {
      const url = workerSourceUrl('/institution/services', {
        domain: institution.domain,
        entityId: cleanString(institution.entityId),
        rorId: cleanString(institution.rorId),
        offset: String(offset),
      }, api.apiBase);
      if (!url) return null;
      signal.throwIfAborted();
      const response = await api.request(url, withEnforcedDeadline({ headers: { accept: 'application/json' }, signal }, SERVICES_TIMEOUT_MS));
      const payload = await response.json().catch(() => null) as ServicesPayload | null;
      if (!response.ok) {
        if (!received && response.status === 404 && payload?.code === 'INSTITUTION_NOT_SUPPORTED') {
          unsupportedDomains.add(institution.domain);
          serviceAnswers.delete(key);
          return UNSUPPORTED_SERVICES;
        }
        // The Worker no longer has the title the reading stopped at.
        if (kept && response.status === 400 && payload?.code === 'INVALID_SERVICES_OFFSET') {
          startOver();
          continue;
        }
        throw new Error('library page unavailable');
      }
      const batch = normalizeInstitutionServices(payload);
      if (!batch) throw new Error('invalid library page');
      const next = payload?.nextOffset;
      // Older Workers omit the continuation and still return their bounded list.
      if (next != null && (typeof next !== 'number' || !Number.isSafeInteger(next) || next <= offset)) {
        resumable = false;
        throw new Error('invalid library continuation');
      }
      // A page of another catalogue than the reading's (a new Worker): what
      // the reading kept may sit at other positions in it.
      const pageCatalogue = typeof payload?.catalogue === 'string' ? payload.catalogue : null;
      if (offset > 0 && pageCatalogue !== catalogue) {
        startOver();
        continue;
      }
      catalogue = pageCatalogue;
      received = true;
      for (const service of batch.services) {
        if (!seen.has(service.id)) found.services.push(service);
        seen.add(service.id);
      }
      found.unchecked += batch.unchecked;
      found.partial ||= batch.partial;
      if (next == null) {
        const ttl = found.partial ? PARTIAL_SERVICES_TTL : SERVICES_TTL;
        serviceAnswers.set(key, { answer: found, expiresAt: Date.now() + ttl, finished: true, reading: null });
        return found;
      }
      offset = next as number;
    }
  } catch {
    // Keep what was found if a page fails, without claiming a complete list.
  }
  // Nothing new arrived: what was there stands, still expired, so the next ask is the retry.
  if (!received) return finished || (kept ? { ...found, partial: true } : null);
  const answer = finished || { ...found, partial: true };
  serviceAnswers.set(key, {
    answer,
    expiresAt: Date.now() + PARTIAL_SERVICES_TTL,
    finished: Boolean(finished),
    reading: resumable && catalogue ? { found, next: offset, catalogue } : null,
  });
  return answer;
}

/**
 * The publisher platforms the linked institution's library reaches, as
 * `{ services, partial, unchecked }` (`unchecked`: platforms no provider could
 * decide on); `{ services: [], partial: false, unsupported: true }` when the
 * Worker cannot ask about this library at all; null when the check failed.
 * A failure is not kept, so asking again after one is the retry.
 */
function servicesDomain(institution: InstitutionInput | null | undefined) {
  return typeof institution?.domain === 'string' ? institution.domain.trim().toLowerCase() : '';
}

function servicesKey(institution: InstitutionInput, domain: string, uid: string | null | undefined) {
  return [uid || '', domain, cleanString(institution.entityId) || '', cleanString(institution.rorId) || ''].join('|');
}

/**
 * The answer `findInstitutionServices` would resolve to at once, or undefined
 * when it would have to ask. A view that opens on the list paints it on its
 * first frame from here instead of growing a frame later.
 */
export function knownInstitutionServices(institution: InstitutionInput | null | undefined, overrides?: AccessOperations): ServicesAnswer | undefined {
  const domain = servicesDomain(institution);
  if (!domain) return undefined;
  if (unsupportedDomains.has(domain)) return UNSUPPORTED_SERVICES;
  const cached = serviceAnswers.get(servicesKey(institution!, domain, operations(overrides).currentUid()));
  return cached && Date.now() < cached.expiresAt ? cached.answer : undefined;
}

export function findInstitutionServices(institution: InstitutionInput | null | undefined, overrides?: AccessOperations): Promise<ServicesAnswer | null> {
  const domain = servicesDomain(institution);
  if (!domain) return Promise.resolve(null);
  const known = knownInstitutionServices(institution, overrides);
  if (known) return Promise.resolve(known);
  const api = operations(overrides);
  // Taken when the lookup starts: an answer that lands after the account
  // changed is kept for the account that asked.
  const key = servicesKey(institution!, domain, api.currentUid());
  if (servicesInFlight.has(key)) return servicesInFlight.get(key)!;

  const pending = lookUpServices(api, { ...institution, domain }, key)
    .finally(() => servicesInFlight.delete(key));
  servicesInFlight.set(key, pending);
  return pending;
}
