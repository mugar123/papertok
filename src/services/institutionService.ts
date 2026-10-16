/**
 * Linking a university to the account, through the Worker.
 *
 * The proof is a verified Google address in the university's domain. When the
 * signed-in account already carries one, the Worker can check it on the
 * session token and nothing else is needed. Otherwise the person signs into
 * Google with the university account on a second Auth instance — Firebase
 * will not attach two Google identities to one uid, and signing the main
 * instance into the other account would switch sessions under the app — and
 * that account's ID token travels to the Worker as the proof. The second
 * sign-in keeps no persistence and is released as soon as the Worker has
 * answered: an account Firebase had to create for it is deleted again, an
 * existing one is signed out.
 *
 * What comes back is the institution, never the address.
 */
import { getApps, initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  deleteUser,
  getAdditionalUserInfo,
  getAuth,
  inMemoryPersistence,
  setPersistence,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import app, { auth, IS_DEMO } from './firebase.ts';
import { authenticatedWorkerFetch } from './workerApiClient.ts';
import { institutionDomainOf } from '../utils/institutionDomain.ts';

export class InstitutionLinkError extends Error {
  constructor(code = 'INSTITUTION_LINK_FAILED', status = 502) {
    super(code);
    this.name = 'InstitutionLinkError';
    this.code = code;
    this.status = status;
  }
}

const SECONDARY_APP_NAME = 'institution-link';

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The stored shape, or null. The Worker writes every field; this only
 * protects the screens from a document edited by hand or by an older build.
 */
export function normalizeInstitution(value) {
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
export function institutionLabel(institution) {
  return institution?.acronym || institution?.name || '';
}

function secondaryAuth() {
  const existing = getApps().find(candidate => candidate.name === SECONDARY_APP_NAME);
  return getAuth(existing || initializeApp(app.options, SECONDARY_APP_NAME));
}

function operations(overrides = {}) {
  return {
    isDemo: overrides.isDemo === undefined ? IS_DEMO : overrides.isDemo,
    request: overrides.request || authenticatedWorkerFetch,
    apiBase: overrides.apiBase === undefined
      ? import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '')
      : overrides.apiBase,
    currentUser: overrides.currentUser || (() => auth.currentUser),
    secondaryAuth: overrides.secondaryAuth || secondaryAuth,
    setPersistence: overrides.setPersistence || setPersistence,
    provider: overrides.provider || (() => new GoogleAuthProvider()),
    popupSignIn: overrides.popupSignIn || signInWithPopup,
    additionalUserInfo: overrides.additionalUserInfo || getAdditionalUserInfo,
    deleteUser: overrides.deleteUser || deleteUser,
    signOut: overrides.signOut || signOut,
  };
}

async function postJson(api, path, body) {
  if (!api.apiBase) throw new InstitutionLinkError('INSTITUTION_LINK_NOT_CONFIGURED', 503);
  let response;
  let payload;
  try {
    response = await api.request(`${api.apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    payload = await response.json().catch(() => ({}));
  } catch (error) {
    if (error?.code === 'WORKER_AUTH_REQUIRED' || error?.code === 'auth/user-token-expired') {
      throw new InstitutionLinkError('AUTH_REQUIRED', 401);
    }
    throw new InstitutionLinkError(error?.code || 'INSTITUTION_LINK_UNREACHABLE', 0);
  }
  if (!response.ok) {
    throw new InstitutionLinkError(
      payload?.code || (response.status === 401 ? 'AUTH_REQUIRED' : 'INSTITUTION_LINK_FAILED'),
      response.status,
    );
  }
  return payload;
}

/**
 * Signs into Google with the university account on the second instance and
 * hands back its ID token with the release that undoes the sign-in. The hint
 * and `hd` steer Google's chooser to that domain; the domain is still checked
 * on the account that actually came back, because a chooser is a suggestion.
 */
async function proveWithUniversityAccount(api, email, domain) {
  const secondary = api.secondaryAuth();
  await api.setPersistence(secondary, inMemoryPersistence);
  const provider = api.provider();
  provider.setCustomParameters({ login_hint: email, hd: domain, prompt: 'select_account' });
  const result = await api.popupSignIn(secondary, provider);
  const holder = result.user;
  const isNewUser = Boolean(api.additionalUserInfo(result)?.isNewUser);
  const release = async () => {
    try {
      if (isNewUser) await api.deleteUser(holder);
      else await api.signOut(secondary);
    } catch {
      // Best effort: a sign-in that could not be undone is not a failed link,
      // and in-memory persistence means it ends with the tab regardless.
    }
  };
  try {
    if (institutionDomainOf(holder?.email) !== domain) {
      throw new InstitutionLinkError('INSTITUTION_EMAIL_MISMATCH', 400);
    }
    return { idToken: await holder.getIdToken(), release };
  } catch (error) {
    await release();
    throw error;
  }
}

export async function linkInstitution(email, overrides) {
  const api = operations(overrides);
  if (api.isDemo) throw new InstitutionLinkError('INSTITUTION_UNSUPPORTED_IN_DEMO', 400);
  const domain = institutionDomainOf(email);
  if (!domain) throw new InstitutionLinkError('INSTITUTION_EMAIL_INVALID', 400);
  const current = api.currentUser();
  if (!current) throw new InstitutionLinkError('AUTH_REQUIRED', 401);

  if (current.emailVerified && institutionDomainOf(current.email) === domain) {
    const payload = await postJson(api, '/institution/link', {});
    return normalizeInstitution(payload.institution);
  }

  const { idToken, release } = await proveWithUniversityAccount(api, email, domain);
  try {
    const payload = await postJson(api, '/institution/link', { institutionToken: idToken });
    return normalizeInstitution(payload.institution);
  } finally {
    await release();
  }
}

export async function unlinkInstitution(overrides) {
  const api = operations(overrides);
  if (api.isDemo) throw new InstitutionLinkError('INSTITUTION_UNSUPPORTED_IN_DEMO', 400);
  if (!api.currentUser()) throw new InstitutionLinkError('AUTH_REQUIRED', 401);
  await postJson(api, '/institution/unlink', {});
  return null;
}
