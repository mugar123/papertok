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

import { institutionDomainOf } from '../src/utils/institutionDomain.js';
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
const ROR_API = 'https://api.ror.org/v2/organizations';
// SeamlessAccess publishes the eduGAIN metadata as a query service: each entry
// carries the email `scope` its identity provider authenticates.
const FEDERATION_MDQ = 'https://md.seamlessaccess.org/entities/';
const INSTITUTION_CACHE_SECONDS = 7 * 24 * 3600;

export class InstitutionLinkError extends Error {
  constructor(code, status = 400) {
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
async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return JSON.parse(text);
}

function rorName(record, type) {
  const names = Array.isArray(record?.names) ? record.names : [];
  const match = names.find(name => Array.isArray(name?.types) && name.types.includes(type));
  return typeof match?.value === 'string' && match.value.trim() ? match.value.trim() : null;
}

/**
 * The ROR record whose registered domains include this one. ROR's search is
 * a text query, so the answer is filtered again on the `domains` field: a
 * record that merely mentions the domain somewhere is not a match.
 */
async function lookupRor(domain, fetchImpl) {
  const url = `${ROR_API}?query.advanced=${encodeURIComponent(`domains:${domain}`)}`;
  let payload;
  try {
    payload = await fetchJson(url, fetchImpl);
  } catch {
    throw new InstitutionLinkError('INSTITUTION_LOOKUP_UNAVAILABLE', 502);
  }
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const record = items.find(item => Array.isArray(item?.domains)
    && item.domains.some(value => String(value).toLowerCase() === domain));
  if (!record || typeof record.id !== 'string') {
    throw new InstitutionLinkError('INSTITUTION_NOT_FOUND', 404);
  }
  const name = rorName(record, 'ror_display') || rorName(record, 'label');
  if (!name) throw new InstitutionLinkError('INSTITUTION_NOT_FOUND', 404);
  return { rorId: record.id, name, acronym: rorName(record, 'acronym') };
}

/**
 * The identity provider's entityID, which is how GetFTR and the publishers'
 * sign-in pages name an institution. Optional: an institution outside the
 * federation, or a metadata service that is down, leaves it null rather than
 * blocking the link. Null here means "not found now", not "has none".
 */
async function lookupEntityId(domain, fetchImpl) {
  try {
    const entries = await fetchJson(`${FEDERATION_MDQ}?q=${encodeURIComponent(domain)}`, fetchImpl);
    const entry = (Array.isArray(entries) ? entries : []).find(candidate => String(candidate?.scope || '')
      .split(',')
      .map(scope => scope.trim().toLowerCase())
      .includes(domain));
    return typeof entry?.entityID === 'string' && entry.entityID ? entry.entityID : null;
  } catch {
    return null;
  }
}

function cacheRequest(domain) {
  return new Request(`https://papertok.internal/institution/${encodeURIComponent(domain)}`);
}

/**
 * What a domain resolves to. Cached a week on success: the registries change
 * slowly and every member of one institution asks the same question. Not
 * found and unavailable are not cached, so a registry outage or a record
 * added tomorrow is not remembered as a refusal.
 */
export async function resolveInstitution(domain, { fetchImpl = fetch, cache = globalThis.caches?.default } = {}) {
  const key = cacheRequest(domain);
  const cached = cache ? await cache.match(key) : null;
  if (cached) return cached.json();

  const ror = await lookupRor(domain, fetchImpl);
  const institution = { domain, ...ror, entityId: await lookupEntityId(domain, fetchImpl) };
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
async function proofHolder(request, env, identity) {
  const body = await readBoundedJson(request, BODY_LIMIT_BYTES, {
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

function userDocument(admin, uid) {
  return admin.name(['users', uid]);
}

function profileDocument(admin, uid) {
  return admin.name(['userProfiles', uid]);
}

/**
 * The public page shows the institution too, from a copy on the profile
 * document. The profile may not exist yet (it is created at the end of
 * onboarding, and `createUserProfile` copies the field then), so its write is
 * a separate commit whose "no such document" is not a failure.
 */
async function writeProfileCopy(admin, uid, write) {
  try {
    await admin.commit([write]);
  } catch (error) {
    if (!(error instanceof FirestoreAdminError && error.status === 409)) throw error;
  }
}

export async function handleInstitutionLinkRequest(request, env, options = {}) {
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
      await writeProfileCopy(admin, identity.uid, clearFieldsWrite(profileDocument(admin, identity.uid), ['institution']));
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
    await writeProfileCopy(admin, identity.uid, mergeWrite(profileDocument(admin, identity.uid), { institution }));
    return { institution };
  } catch (error) {
    if (error instanceof InstitutionLinkError || error instanceof WorkerAuthError) throw error;
    if (error instanceof FirestoreAdminError) {
      // Unlinking an account whose user document never existed has nothing to
      // clear; the precondition failure is that, not a fault.
      if (pathname === INSTITUTION_UNLINK_PATH && error.status === 409) return { institution: null };
      throw new InstitutionLinkError('INSTITUTION_LINK_FAILED', 502);
    }
    throw error;
  }
}
