import type { LinkedInstitution } from './institutionService.ts';
type InstitutionInput = Partial<LinkedInstitution>;
interface AccessOperations { request?: typeof authenticatedWorkerFetch; apiBase?: string }
interface AccessPayload { code?: string; status?: string; url?: unknown; collection?: unknown }
interface ServicesPayload { code?: string; services?: Array<Record<string, unknown>>; unchecked?: number; partial?: boolean }
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
 * policy, keyed by domain alone.
 */
import { authenticatedWorkerFetch, workerSourceUrl } from './workerApiClient.ts';
import { normalizeDoi } from './unpaywallService.ts';
import { safeExternalUrl } from '../utils/externalUrl.ts';
import { withRequestDeadline } from '../utils/requestDeadline.ts';

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
// A partial answer is the Worker's deadline cutting some probes short: the
// missing platforms are unasked, not absent, so the gap is worth filling soon.
const PARTIAL_SERVICES_TTL = 60 * 60 * 1000;
// Above the Worker's own 12 s probe deadline, for the same reason as above.
const SERVICES_TIMEOUT_MS = 15000;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const UNSUPPORTED_SERVICES = Object.freeze({ services: Object.freeze([]), partial: false, unsupported: true });

const serviceAnswers = new Map<string, { answer: NonNullable<ReturnType<typeof normalizeInstitutionServices>>; expiresAt: number }>();
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

async function lookUpServices(api: ReturnType<typeof operations>, institution: InstitutionInput & { domain: string }) {
  const url = workerSourceUrl('/institution/services', {
    domain: institution.domain,
    entityId: cleanString(institution.entityId),
    rorId: cleanString(institution.rorId),
  }, api.apiBase);
  if (!url) return null;
  try {
    const response = await api.request(url, withRequestDeadline({ headers: { accept: 'application/json' } }, SERVICES_TIMEOUT_MS));
    const payload = await response.json().catch(() => null) as ServicesPayload | null;
    if (!response.ok) {
      if (response.status === 404 && payload?.code === 'INSTITUTION_NOT_SUPPORTED') {
        unsupportedDomains.add(institution.domain);
        return UNSUPPORTED_SERVICES;
      }
      return null;
    }
    const answer = normalizeInstitutionServices(payload);
    if (answer) {
      const ttl = answer.partial ? PARTIAL_SERVICES_TTL : SERVICES_TTL;
      serviceAnswers.set(institution.domain, { answer, expiresAt: Date.now() + ttl });
    }
    return answer;
  } catch {
    return null;
  }
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

/**
 * The answer `findInstitutionServices` would resolve to at once, or undefined
 * when it would have to ask. A view that opens on the list paints it on its
 * first frame from here instead of growing a frame later.
 */
export function knownInstitutionServices(institution: InstitutionInput | null | undefined): ServicesAnswer | undefined {
  const domain = servicesDomain(institution);
  if (!domain) return undefined;
  if (unsupportedDomains.has(domain)) return UNSUPPORTED_SERVICES;
  const cached = serviceAnswers.get(domain);
  return cached && Date.now() < cached.expiresAt ? cached.answer : undefined;
}

export function findInstitutionServices(institution: InstitutionInput | null | undefined, overrides?: AccessOperations): Promise<ServicesAnswer | null> {
  const domain = servicesDomain(institution);
  if (!domain) return Promise.resolve(null);
  const known = knownInstitutionServices(institution);
  if (known) return Promise.resolve(known);
  if (servicesInFlight.has(domain)) return servicesInFlight.get(domain)!;

  const pending = lookUpServices(operations(overrides), { ...institution, domain })
    .finally(() => servicesInFlight.delete(domain));
  servicesInFlight.set(domain, pending);
  return pending;
}
