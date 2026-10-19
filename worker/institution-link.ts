import type { WorkerEnv, WorkerGlobals } from './env.ts';
import type { VerifiedIdentity } from './firebase-auth.ts';
import type { FirestoreAdmin, FirestoreWrite } from './firestore-admin.ts';

interface RorRecord { id?: unknown; domains?: unknown[]; names?: Array<{ types?: unknown[]; value?: unknown }> }
export interface ResolvedInstitution { domain: string; rorId: string; name: string; acronym: string | null; entityId: string | null }
interface InstitutionLinkOptions {
  admin?: Pick<FirestoreAdmin, 'name'> & { commit(writes: FirestoreWrite[]): Promise<unknown> };
  fetchImpl?: typeof fetch;
  cache?: { match(request: RequestInfo | URL): Promise<Response | null | undefined>; put(request: RequestInfo | URL, response: Response): Promise<void> } | null;
  now?: () => number;
}


/**
 * Links a verified university email to the signed-in account.
 *
 * The browser cannot write `users/{uid}.institution` itself: the only thing
 * that proves an institution is a verified address in its domain, and the
 * Firestore rules can see the session's own address but not a second Google
 * account the person signed into for this purpose. So the proof is checked
 * here — either the session's address or an ID token of that second account,
 * both through Identity Toolkit — and the field is written with the service
 * identity. The rules keep the field frozen for the client afterwards.
 *
 * What gets stored is the institution, not the address: the domain, the ROR
 * record it resolves to, and the SAML entityID of its identity provider when
 * the federation metadata lists one. The address is the proof and is discarded
 * once the domain is known.
 */

import { institutionDomainOf } from '../src/utils/institutionDomain.ts';
import { readBoundedJson } from './bounded-body.ts';
import { verifyFirebaseIdentity, verifyIdToken, WorkerAuthError } from './firebase-auth.ts';
import {
  clearFieldsWrite,
  createFirestoreAdmin,
  FirestoreAdminError,
  isServiceAccountConfigured,
  mergeWrite,
} from './firestore-admin.ts';

export const INSTITUTION_LINK_PATH = '/institution/link';
export const INSTITUTION_UNLINK_PATH = '/institution/unlink';
export const INSTITUTION_PATHS = new Set([INSTITUTION_LINK_PATH, INSTITUTION_UNLINK_PATH]);

// A Firebase ID token runs to about a kilobyte; the body carries at most one.
const BODY_LIMIT_BYTES = 16_384;
const LOOKUP_TIMEOUT_MS = 6000;
// One budget for every registry question of a link: the browser waits 15 s
// for the whole request, which also verifies one or two tokens and writes
// the document, and up to three ROR and two federation questions at 6 s
// each would outrun it (seen with mail.students.uam.es on 2026-10-19).
export const LINK_LOOKUP_BUDGET_MS = 10_000;
const ROR_API = 'https://api.ror.org/v2/organizations';
// SeamlessAccess publishes the eduGAIN metadata as a query service: each entry
// carries the email `scope` its identity provider authenticates.
const FEDERATION_MDQ = 'https://md.seamlessaccess.org/entities/';
const INSTITUTION_CACHE_SECONDS = 7 * 24 * 3600;

export class InstitutionLinkError extends Error {
  declare code: string;
  declare status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.name = 'InstitutionLinkError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Reads the body inside the deadline as well: a registry that sends its
 * headers and then stalls is as unavailable as one that never answered.
 */
async function fetchJson<T>(url: string, fetchImpl: typeof fetch, budget: AbortSignal): Promise<T> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.any([budget, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return JSON.parse(text);
}

function rorName(record: RorRecord, type: string) {
  const names = Array.isArray(record?.names) ? record.names : [];
  const match = names.find(name => Array.isArray(name?.types) && name.types.includes(type));
  return typeof match?.value === 'string' && match.value.trim() ? match.value.trim() : null;
}

// How many domains are asked about for one address: the address's own, then
// its parents. ROR registers a university's primary domain and students
// write from a subdomain of it (estudiante.uam.es, alumnos.upm.es,
// g.ucla.edu, terpmail.umd.edu, checked 2026-10-19), which the university
// controls as much as the primary one.
const ROR_DOMAIN_ATTEMPTS = 3;

/**
 * Verified mail aliases whose ROR lookup must use the university's current
 * domain. ROR mislists neu.edu under Shenyang, while northeastern.edu resolves
 * to Boston (04t5xt781). Northeastern documents both its legacy domain and
 * husky.neu.edu: https://www.northeastern.edu/privacy-information/ and
 * https://cssh.northeastern.edu/writingcenter/tutoring/first-visit/
 * Checked 2026-10-19. Only the ROR query changes; the verified mail domain and
 * federation scope stay intact. Website/mail-domain differences alone do not
 * establish an alias.
 */
const ROR_DOMAIN_ALIASES: Record<string, string> = {
  'neu.edu': 'northeastern.edu',
};

/**
 * The ROR record whose registered domains include this one or a parent of
 * it, with the domain that matched. ROR's search is a text query, so the
 * answer is filtered again on the `domains` field: a record that merely
 * mentions the domain somewhere is not a match. Verified aliases are looked
 * up by their canonical domain, and that domain must match the record. A
 * parent with no record (`ac.uk`, `edu.au`) is simply a miss on the way to
 * not found. A budget that runs out is the registry being unavailable, not
 * a miss, and no further question is started past it.
 */
async function lookupRor(domain: string, fetchImpl: typeof fetch, budget: AbortSignal) {
  const labels = domain.split('.');
  const candidates = [];
  for (let start = 0; start < labels.length - 1 && candidates.length < ROR_DOMAIN_ATTEMPTS; start += 1) {
    candidates.push(labels.slice(start).join('.'));
  }
  for (const candidate of candidates) {
    if (budget.aborted) throw new InstitutionLinkError('INSTITUTION_LOOKUP_UNAVAILABLE', 502);
    const lookupDomain = ROR_DOMAIN_ALIASES[candidate] || candidate;
    const url = `${ROR_API}?query.advanced=${encodeURIComponent(`domains:${lookupDomain}`)}`;
    let payload;
    try {
      payload = await fetchJson<{ items?: RorRecord[] }>(url, fetchImpl, budget);
    } catch {
      throw new InstitutionLinkError('INSTITUTION_LOOKUP_UNAVAILABLE', 502);
    }
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const record = items.find(item => Array.isArray(item?.domains)
      && item.domains.some(value => String(value).toLowerCase() === lookupDomain));
    if (!record || typeof record.id !== 'string') continue;
    const name = rorName(record, 'ror_display') || rorName(record, 'label');
    if (!name) continue;
    return { rorId: record.id, name, acronym: rorName(record, 'acronym'), matchedDomain: candidate };
  }
  throw new InstitutionLinkError('INSTITUTION_NOT_FOUND', 404);
}

/**
 * The identity provider's entityID, which is how GetFTR and the publishers'
 * sign-in pages name an institution. Optional: an institution outside the
 * federation, or a metadata service that is down, leaves it null rather than
 * blocking the link. Null here means "not found now", not "has none".
 */
async function lookupEntityId(domain: string, fetchImpl: typeof fetch, budget: AbortSignal) {
  // Optional, so a budget already spent on the registry is not spent again.
  if (budget.aborted) return null;
  try {
    const entries = await fetchJson<Array<{ scope?: unknown; entityID?: unknown }>>(`${FEDERATION_MDQ}?q=${encodeURIComponent(domain)}`, fetchImpl, budget);
    const entry = (Array.isArray(entries) ? entries : []).find(candidate => String(candidate?.scope || '')
      .split(',')
      .map(scope => scope.trim().toLowerCase())
      .includes(domain));
    return typeof entry?.entityID === 'string' && entry.entityID ? entry.entityID : null;
  } catch {
    return null;
  }
}

// The cache's second generation: the first could hold a record that does
// not own its domain (neu.edu resolved to Shenyang until 2026-10-19).
function cacheRequest(domain: string) {
  return new Request(`https://papertok.internal/institution/v2/${encodeURIComponent(domain)}`);
}

/**
 * What a domain resolves to. Cached a week on success: the registries change
 * slowly and every member of one institution asks the same question. Not
 * found and unavailable are not cached, so a registry outage or a record
 * added tomorrow is not remembered as a refusal. Every registry question
 * shares one `budget`, `LINK_LOOKUP_BUDGET_MS` by default.
 */
export async function resolveInstitution(domain: string, { fetchImpl = fetch, cache = (globalThis as WorkerGlobals).caches?.default, signal: budget = AbortSignal.timeout(LINK_LOOKUP_BUDGET_MS) }: Pick<InstitutionLinkOptions, 'fetchImpl' | 'cache'> & { signal?: AbortSignal } = {}): Promise<ResolvedInstitution> {
  const key = cacheRequest(domain);
  const cached = cache ? await cache.match(key) : null;
  if (cached) return cached.json<ResolvedInstitution>();

  const { matchedDomain, ...ror } = await lookupRor(domain, fetchImpl, budget);
  // The federation lists the identity provider by the university's own
  // scope, which a student subdomain may not be.
  const entityId = await lookupEntityId(domain, fetchImpl, budget)
    ?? (matchedDomain !== domain ? await lookupEntityId(matchedDomain, fetchImpl, budget) : null);
  const institution = { domain, ...ror, entityId };
  if (cache) {
    await cache.put(key, new Response(JSON.stringify(institution), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${INSTITUTION_CACHE_SECONDS}`,
      },
    }));
  }
  return institution;
}

/**
 * The address the link is about. Without a token in the body it is the
 * session's own; with one, the second account's. The second token is verified
 * exactly like the first, but its failures are reported as a bad proof rather
 * than as a lost session, which is what a 401 would tell the browser.
 */
async function proofHolder(request: Request, env: WorkerEnv, identity: VerifiedIdentity) {
  const body = await readBoundedJson<{ institutionToken?: unknown }>(request, BODY_LIMIT_BYTES, {
    tooLarge: () => new InstitutionLinkError('BODY_TOO_LARGE', 413),
    invalid: () => new InstitutionLinkError('INVALID_BODY', 400),
  });
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new InstitutionLinkError('INVALID_BODY', 400);
  }
  const token = body.institutionToken;
  if (token === undefined || token === null || token === '') return identity;
  if (typeof token !== 'string') throw new InstitutionLinkError('INVALID_BODY', 400);
  try {
    return await verifyIdToken(token, env, { allowCache: false });
  } catch (error) {
    if (error instanceof WorkerAuthError && error.status === 401) {
      throw new InstitutionLinkError('INSTITUTION_TOKEN_INVALID', 400);
    }
    throw error;
  }
}

function userDocument(admin: Pick<FirestoreAdmin, 'name'>, uid: string) {
  return admin.name(['users', uid]);
}

export async function handleInstitutionLinkRequest(request: Request, env: WorkerEnv, options: InstitutionLinkOptions = {}) {
  if (request.method !== 'POST') throw new InstitutionLinkError('METHOD_NOT_ALLOWED', 405);
  if (!isServiceAccountConfigured(env)) {
    throw new InstitutionLinkError('INSTITUTION_LINK_NOT_CONFIGURED', 503);
  }
  // A write, so no identity cache: a token revoked a moment ago must not link.
  const identity = await verifyFirebaseIdentity(request, env, { allowCache: false });
  const admin = options.admin || createFirestoreAdmin(env);
  const pathname = new URL(request.url).pathname;

  try {
    if (pathname === INSTITUTION_UNLINK_PATH) {
      await admin.commit([clearFieldsWrite(userDocument(admin, identity.uid), ['institution'])]);
      // A legacy public profile may still hold the copy made while profiles
      // existed; unlinking erases it there too.
      await admin.commit([clearFieldsWrite(admin.name(['userProfiles', identity.uid]), ['institution'])]);
      return { institution: null };
    }

    const holder = await proofHolder(request, env, identity);
    if (!holder.emailVerified) throw new InstitutionLinkError('INSTITUTION_EMAIL_NOT_VERIFIED', 403);
    const domain = institutionDomainOf(holder.email);
    if (!domain) throw new InstitutionLinkError('INSTITUTION_EMAIL_INVALID', 400);

    const resolved = await resolveInstitution(domain, { fetchImpl: options.fetchImpl, cache: options.cache });
    const institution = { ...resolved, verifiedAt: new Date(options.now?.() ?? Date.now()).toISOString() };
    // No existence precondition: during onboarding the user document may not
    // have been written yet, and the link must not have to wait for it.
    await admin.commit([mergeWrite(userDocument(admin, identity.uid), { institution }, { mustExist: false })]);
    return { institution };
  } catch (error) {
    if (error instanceof InstitutionLinkError || error instanceof WorkerAuthError) throw error;
    if (error instanceof FirestoreAdminError) {
      // Unlinking has nothing to clear in a document that never existed: the
      // user document of an account that never onboarded, or the profile most
      // accounts never had. The precondition failure is that, not a fault.
      if (pathname === INSTITUTION_UNLINK_PATH && error.status === 409) return { institution: null };
      throw new InstitutionLinkError('INSTITUTION_LINK_FAILED', 502);
    }
    throw error;
  }
}
