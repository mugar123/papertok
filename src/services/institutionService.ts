import { getApps, initializeApp } from 'firebase/app';
import {
  connectAuthEmulator, deleteUser, getAdditionalUserInfo, getAuth,
  inMemoryPersistence, initializeAuth, isSignInWithEmailLink,
  signInWithEmailLink, signOut,
} from 'firebase/auth';
import app, { auth } from './firebase.ts';
import { authenticatedWorkerFetch } from './workerApiClient.ts';
import { institutionDomainOf } from '../utils/institutionDomain.ts';

type InstitutionInput = Partial<Record<'domain' | 'rorId' | 'name' | 'acronym' | 'entityId' | 'verifiedAt', unknown>>;
export type LinkedInstitution = NonNullable<ReturnType<typeof normalizeInstitution>>;
type SignedInAccount = Pick<import('firebase/auth').User, 'uid'> & Partial<Pick<import('firebase/auth').User, 'email' | 'emailVerified'>>;
interface InstitutionOperations {
  request?: typeof authenticatedWorkerFetch;
  apiBase?: string;
  currentUser?: () => SignedInAccount | null;
  secondaryAuth?: typeof secondaryAuth;
  emailSignIn?: typeof signInWithEmailLink;
  additionalUserInfo?: typeof getAdditionalUserInfo;
  deleteUser?: typeof deleteUser;
  signOut?: typeof signOut;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  origin?: string;
  now?: () => number;
}

const PENDING_KEY = 'papertok_institution_verification';
const PROOF_LIFETIME_MS = 60 * 60 * 1000;
type PendingVerification = { uid: string; email: string; nonce: string; createdAt: number };

// Remove the one-time credential before routing, analytics or outbound links
// can read the URL. It stays in this tab's memory until completion or reload.
export const institutionVerificationLink = (() => {
  if (!/^\/institution\/verify\/?$/.test(globalThis.location?.pathname ?? '')) return '';
  const link = globalThis.location.href;
  globalThis.history.replaceState(globalThis.history.state, '', '/institution/verify');
  return link;
})();

export class InstitutionLinkError extends Error {
  declare code: string;
  declare status: number;
  constructor(code = 'INSTITUTION_LINK_FAILED', status = 502) {
    super(code);
    this.name = 'InstitutionLinkError';
    this.code = code;
    this.status = status;
  }
}

function cleanString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The stored shape, or null. The Worker writes every field; this only
 * protects the screens from a document edited by hand or by an older build.
 */
export function normalizeInstitution(value: InstitutionInput | string | null | undefined) {
  if (!value || typeof value !== 'object') return null;
  const domain = institutionDomainOf(`proof@${String(value.domain || '').trim().toLowerCase()}`);
  if (!domain) return null;
  return {
    domain,
    rorId: cleanString(value.rorId),
    name: cleanString(value.name) || domain,
    acronym: cleanString(value.acronym),
    entityId: cleanString(value.entityId),
    verifiedAt: cleanString(value.verifiedAt),
  };
}

/** The short form a pill shows: the acronym when the registry has one. */
export function institutionLabel(institution: Partial<LinkedInstitution> | null | undefined) {
  return institution?.acronym || institution?.name || '';
}

function secondaryAuth() {
  const existing = getApps().find(candidate => candidate.name === 'institution-link');
  if (existing) return getAuth(existing);
  const instance = initializeAuth(initializeApp(app.options, 'institution-link'), {
    persistence: inMemoryPersistence,
  });
  instance.languageCode = 'en';
  if (import.meta.env?.MODE === 'emulators') {
    connectAuthEmulator(instance, 'http://127.0.0.1:9099', { disableWarnings: true });
  }
  return instance;
}

function operations(overrides: InstitutionOperations = {}) {
  return {
        request: authenticatedWorkerFetch,
    apiBase: import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, ''),
    currentUser: () => auth.currentUser as SignedInAccount | null,
    secondaryAuth,
    emailSignIn: signInWithEmailLink,
    additionalUserInfo: getAdditionalUserInfo,
    deleteUser,
    signOut,
    origin: globalThis.location?.origin,
    now: Date.now,
    ...overrides,
  };
}

function storage(api: InstitutionOperations) {
  return api.storage ?? globalThis.localStorage;
}

export function cancelInstitutionVerification(overrides: InstitutionOperations = {}) {
  try { storage(overrides)?.removeItem(PENDING_KEY); } catch {
    // Blocked browser storage also prevents an outstanding proof from being read.
  }
}

export function pendingInstitutionVerification(overrides: InstitutionOperations = {}): PendingVerification | null {
  const api = operations(overrides);
  let saved: string | null | undefined;
  try { saved = storage(api)?.getItem(PENDING_KEY); } catch { return null; }
  if (!saved) return null;
  let pending: PendingVerification;
  try { pending = JSON.parse(saved); } catch { cancelInstitutionVerification(api); return null; }
  if (!pending || pending.uid !== api.currentUser()?.uid || !institutionDomainOf(pending.email)
    || typeof pending.nonce !== 'string' || !Number.isFinite(pending.createdAt)
    || api.now() - pending.createdAt >= PROOF_LIFETIME_MS || pending.createdAt > api.now()) {
    cancelInstitutionVerification(api);
    return null;
  }
  return pending;
}

function requireAccount(api: ReturnType<typeof operations>) {
  if (!api.apiBase) throw new InstitutionLinkError('INSTITUTION_LINK_NOT_CONFIGURED', 503);
  const current = api.currentUser();
  if (!current) throw new InstitutionLinkError('AUTH_REQUIRED', 401);
  return current;
}

function assertAccount(api: ReturnType<typeof operations>, uid: string) {
  if (api.currentUser()?.uid !== uid) throw new InstitutionLinkError('INSTITUTION_VERIFICATION_CANCELED', 400);
}

async function postJson(api: ReturnType<typeof operations>, path: string, body: Record<string, unknown>) {
  if (!api.apiBase) throw new InstitutionLinkError('INSTITUTION_LINK_NOT_CONFIGURED', 503);
  let response;
  let payload;
  try {
    response = await api.request(`${api.apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(path === '/institution/verification' ? { signal: AbortSignal.timeout(30_000) } : {}),
    });
    payload = await response.json().catch(() => ({})) as { code?: string; institution?: InstitutionInput };
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'WORKER_AUTH_REQUIRED' || (error as { code?: string } | null)?.code === 'auth/user-token-expired') {
      throw new InstitutionLinkError('AUTH_REQUIRED', 401);
    }
    throw new InstitutionLinkError((error as { code?: string } | null)?.code || 'INSTITUTION_LINK_UNREACHABLE', 0);
  }
  if (!response.ok) {
    throw new InstitutionLinkError(
      payload?.code || (response.status === 401 ? 'AUTH_REQUIRED' : 'INSTITUTION_LINK_FAILED'),
      response.status,
    );
  }
  return payload;
}

export function needsUniversityProof(email: string, overrides?: InstitutionOperations) {
  const current = operations(overrides).currentUser();
  const domain = institutionDomainOf(email);
  return !(domain && current?.emailVerified && institutionDomainOf(current.email) === domain);
}

export async function sendInstitutionVerification(email: string, overrides?: InstitutionOperations) {
  const api = operations(overrides);
  const current = requireAccount(api);
  if (!institutionDomainOf(email)) throw new InstitutionLinkError('INSTITUTION_EMAIL_INVALID', 400);
  const pending = { uid: current.uid, email: email.trim().toLowerCase(), nonce: crypto.randomUUID(), createdAt: api.now() };
  // Persist before sending: a storage failure must not send an unusable link.
  try { storage(api).setItem(PENDING_KEY, JSON.stringify(pending)); } catch {
    throw new InstitutionLinkError('INSTITUTION_STORAGE_UNAVAILABLE', 400);
  }
  try {
    await postJson(api, '/institution/verification', { email: pending.email, nonce: pending.nonce });
    assertAccount(api, current.uid);
    if (pendingInstitutionVerification(api)?.nonce !== pending.nonce) {
      throw new InstitutionLinkError('INSTITUTION_VERIFICATION_CANCELED', 400);
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    const uncertain = code === 'INSTITUTION_VERIFICATION_UNCERTAIN' || code === 'INSTITUTION_LINK_UNREACHABLE'
      || code === 'TimeoutError' || (error as { status?: number }).status === 0;
    if (!uncertain && pendingInstitutionVerification(api)?.nonce === pending.nonce) cancelInstitutionVerification(api);
    if (uncertain) throw new InstitutionLinkError('INSTITUTION_VERIFICATION_UNCERTAIN', 503);
    throw error;
  }
}

export async function completeInstitutionVerification(link: string, overrides?: InstitutionOperations) {
  const api = operations(overrides);
  const current = requireAccount(api);
  const pending = pendingInstitutionVerification(api);
  if (!pending || new URL(link, api.origin).searchParams.get('state') !== pending.nonce) {
    throw new InstitutionLinkError('INSTITUTION_VERIFICATION_CANCELED', 400);
  }
  const secondary = api.secondaryAuth();
  if (!isSignInWithEmailLink(secondary, link)) throw new InstitutionLinkError('INSTITUTION_TOKEN_INVALID', 400);
  const result = await api.emailSignIn(secondary, pending.email, link);
  const isNewUser = Boolean(api.additionalUserInfo(result)?.isNewUser);
  try {
    if (!result.user.emailVerified || result.user.email?.toLowerCase() !== pending.email) {
      throw new InstitutionLinkError('INSTITUTION_EMAIL_NOT_VERIFIED', 403);
    }
    const institutionToken = await result.user.getIdToken();
    assertAccount(api, current.uid);
    if (pendingInstitutionVerification(api)?.nonce !== pending.nonce) {
      throw new InstitutionLinkError('INSTITUTION_VERIFICATION_CANCELED', 400);
    }
    cancelInstitutionVerification(api);
    const payload = await postJson(api, '/institution/link', { institutionToken });
    assertAccount(api, current.uid);
    return normalizeInstitution(payload.institution);
  } finally {
    try {
      if (isNewUser) await api.deleteUser(result.user);
    } catch {
      // Cleanup must not turn a confirmed Worker write into a reported failure.
    } finally {
      // Also release in-memory credentials when deletion fails.
      await api.signOut(secondary).catch(() => {});
    }
  }
}

export async function linkInstitution(email: string, overrides?: InstitutionOperations) {
  const api = operations(overrides);
  const current = requireAccount(api);
  if (!institutionDomainOf(email)) throw new InstitutionLinkError('INSTITUTION_EMAIL_INVALID', 400);
  if (needsUniversityProof(email, api)) throw new InstitutionLinkError('INSTITUTION_EMAIL_NOT_VERIFIED', 403);
  cancelInstitutionVerification(api);
  const payload = await postJson(api, '/institution/link', {});
  assertAccount(api, current.uid);
  return normalizeInstitution(payload.institution);
}

export async function unlinkInstitution(overrides?: InstitutionOperations) {
  const api = operations(overrides);
  const current = requireAccount(api);
  cancelInstitutionVerification(api);
  await postJson(api, '/institution/unlink', {});
  assertAccount(api, current.uid);
  return null;
}
