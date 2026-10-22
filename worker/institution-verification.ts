import type { WorkerEnv } from './env.ts';
import { readBoundedJson } from './bounded-body.ts';
import { institutionDomainOf } from '../src/utils/institutionDomain.ts';
import { verifyFirebaseIdentity } from './firebase-auth.ts';
import { getAccessToken, isServiceAccountConfigured } from './firebase-service-account.ts';
import { InstitutionLinkError } from './institution-link.ts';
import { EmailNotificationError, sendInstitutionVerificationEmail } from './email-notifications.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';
import { allowedOrigins } from './http.ts';

export const INSTITUTION_VERIFICATION_PATH = '/institution/verification';
const AUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

async function generateVerificationLink(env: WorkerEnv, email: string, target: URL) {
  const signal = AbortSignal.timeout(8_000);
  const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal });
  try {
    const token = await getAccessToken(env, { fetchImpl: boundedFetch, scope: AUTH_SCOPE });
    const response = await boundedFetch('https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        requestType: 'EMAIL_SIGNIN', email, continueUrl: target.href,
        canHandleCodeInApp: true, targetProjectId: env.FIREBASE_PROJECT_ID,
        returnOobLink: true,
      }),
    });
    const payload = await response.json<{ oobLink?: string }>();
    if (!response.ok || !payload.oobLink) throw new Error('Link generation failed');
    const action = new URL(payload.oobLink);
    if (action.searchParams.get('mode') !== 'signIn'
      || action.searchParams.get('continueUrl') !== target.href
      || action.searchParams.get('apiKey') !== env.FIREBASE_WEB_API_KEY
      || !action.searchParams.get('oobCode')) throw new Error('Invalid action link');
    // Our existing action page consumes Firebase's credential directly, without
    // exposing it in a response to the person requesting the email.
    for (const key of ['apiKey', 'mode', 'oobCode']) target.searchParams.set(key, action.searchParams.get(key)!);
    return target.href;
  } catch {
    // Provider responses and URLs can contain the one-time credential.
    throw new InstitutionLinkError('INSTITUTION_VERIFICATION_UNAVAILABLE', 503);
  }
}

export async function handleInstitutionVerificationRequest(request: Request, env: WorkerEnv) {
  if (request.method !== 'POST') throw new InstitutionLinkError('METHOD_NOT_ALLOWED', 405);
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins(env).has(origin)) throw new InstitutionLinkError('ORIGIN_NOT_ALLOWED', 403);
  const identity = await verifyFirebaseIdentity(request, env, { allowCache: false });
  if (!identity.emailVerified) throw new InstitutionLinkError('INSTITUTION_ACCOUNT_NOT_VERIFIED', 403);
  const body = await readBoundedJson<{ email?: unknown; nonce?: unknown }>(request, 2_048, {
    tooLarge: () => new InstitutionLinkError('BODY_TOO_LARGE', 413),
    invalid: () => new InstitutionLinkError('INVALID_BODY', 400),
  });
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !institutionDomainOf(email) || !/^[^\s<>"(),:;\\]+@/.test(email)
    || email.slice(0, email.indexOf('@')).length > 64) {
    throw new InstitutionLinkError('INSTITUTION_EMAIL_INVALID', 400);
  }
  if (typeof body?.nonce !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.nonce)) {
    throw new InstitutionLinkError('INVALID_BODY', 400);
  }
  if (!isServiceAccountConfigured(env) || !env.BREVO_API_KEY || !env.BREVO_FROM_EMAIL) {
    throw new InstitutionLinkError('INSTITUTION_VERIFICATION_UNAVAILABLE', 503);
  }
  const now = Date.now();
  for (const [period, subjectLimit] of [[Math.floor(now / 60_000), 1], [new Date(now).toISOString().slice(0, 10), 5]] as const) {
    for (const [kind, subject] of [['account', identity.uid], ['recipient', email]]) {
      const quota = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, {
        periodKey: `institution-verification:${kind}:${period}`, subject, subjectLimit, globalLimit: 500,
      });
      if (!quota.accepted) {
        throw new InstitutionLinkError(quota.code ? 'INSTITUTION_VERIFICATION_UNAVAILABLE' : 'INSTITUTION_VERIFICATION_LIMIT', quota.code ? 503 : 429);
      }
    }
  }
  const target = new URL('/institution/verify', origin);
  target.searchParams.set('state', body.nonce);
  try {
    await sendInstitutionVerificationEmail(env, email, `institution:${identity.uid}:${email}:${body.nonce}`, () => generateVerificationLink(env, email, target));
  } catch (error) {
    if (error instanceof InstitutionLinkError) throw error;
    if (error instanceof EmailNotificationError) {
      const code = error.code === 'EMAIL_PROVIDER_LIMIT' ? 'INSTITUTION_VERIFICATION_LIMIT'
        : error.code === 'INSTITUTION_VERIFICATION_UNCERTAIN' ? error.code : 'INSTITUTION_VERIFICATION_UNAVAILABLE';
      throw new InstitutionLinkError(code, error.status === 429 ? 429 : 503);
    }
    throw new InstitutionLinkError('INSTITUTION_VERIFICATION_UNAVAILABLE', 503);
  }
  return { sent: true };
}
