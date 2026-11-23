import type { WorkerEnv } from './env.ts';
import type { QuotaReading, QuotaRequest } from './request-quota-ledger.ts';

import { reserveRequestQuota } from './request-quota-ledger.ts';

// The eight groups of an IPv6 address as the URL parser serializes it: hex
// groups, with one `::` for the longest run of zeros.
function ipv6Groups(hostname: string) {
  const [head, tail] = hostname.slice(1, -1).split('::');
  const leading = head ? head.split(':') : [];
  const trailing = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? 0 : 8 - leading.length - trailing.length;
  return [...leading, ...Array<string>(zeros).fill('0'), ...trailing].map(group => parseInt(group, 16));
}

/**
 * The caller every per-address allowance counts: an IPv4 address, or the /64
 * prefix of an IPv6 one. A network hands a subscriber, and often one device,
 * at least a /64, so each full IPv6 address counted as its own caller gave one
 * machine 2^64 allowances (ENG-225). An IPv4-mapped address counts as its IPv4
 * address, not as one caller for the whole mapped range.
 */
function normalizeCallerAddress(ip: string) {
  if (!/^[\da-f:.]+$/i.test(ip)) return '';
  try {
    if (ip.includes(':')) {
      const groups = ipv6Groups(new URL(`https://[${ip}]/`).hostname);
      if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
        return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
      }
      return `${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`;
    }
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return new URL(`https://${ip}/`).hostname;
  } catch { /* The URL parser rejects malformed IPv4 and IPv6 addresses. */ }
  return '';
}

export function isCallerQuotaSecretConfigured(secret: string | undefined): secret is string {
  return Boolean(secret && secret.length >= 32);
}

/**
 * The caller's ledger subject for one window: an HMAC-SHA-256 of `scope` (a
 * namespace and a UTC minute or day) and the address Cloudflare reports, an
 * IPv6 one as its /64 prefix (`normalizeCallerAddress`), keyed with
 * `PDF_RATE_LIMIT_SECRET`. The ledger client hashes it again before storing it,
 * so no counter holds the address. Null when the address or the secret is
 * missing or invalid; every caller fails closed on null.
 */
export async function callerSubject(request: Request, env: WorkerEnv, scope: string) {
  // Cloudflare overwrites this header on ingress; never use a client-supplied
  // forwarding header or a shared fallback identity when it is absent.
  const address = normalizeCallerAddress(request.headers.get('cf-connecting-ip') || '');
  const secret = env.PDF_RATE_LIMIT_SECRET;
  if (!address || !isCallerQuotaSecretConfigured(secret)) return null;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${scope}:${address}`));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface CallerMinute {
  reading: QuotaReading;
  // Seconds until the window resets, for `retry-after`.
  retryAfter: string;
  // What was reserved, for whoever has to give it back.
  reservation?: QuotaRequest;
}

/**
 * One unit of the caller's allowance for this UTC minute, for a route with no
 * shared reservation to carry the caller as a second subject. Only the caller
 * is counted (`globalAmount: 0`), and the counter is deleted a minute after its
 * window ends. A missing identity reads `CALLER_IDENTITY_NOT_CONFIGURED`.
 */
export async function reserveCallerMinute(request: Request, env: WorkerEnv, namespace: string, limit: number): Promise<CallerMinute> {
  const now = Date.now();
  const minute = new Date(now).toISOString().slice(0, 16);
  const nextMinute = (Math.floor(now / 60_000) + 1) * 60_000;
  const retryAfter = String(Math.ceil((nextMinute - now) / 1000));
  const subject = await callerSubject(request, env, `${namespace}:${minute}`);
  if (!subject) return { reading: { accepted: false, code: 'CALLER_IDENTITY_NOT_CONFIGURED' }, retryAfter };
  const reservation = {
    periodKey: `${namespace}:caller:${minute}`,
    subject,
    subjectLimit: limit,
    // The ledger requires a ceiling; with nothing spent against it, it is never read.
    globalLimit: limit,
    globalAmount: 0,
    expiresAt: nextMinute + 60_000,
  };
  const reading = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, reservation);
  return { reading, retryAfter, reservation };
}
