import type { CaptureResult, PostHog, PostHogConfig } from 'posthog-js';
import { APP_RELOAD_KEY, PRELOAD_RELOAD_KEY, PRELOAD_RELOAD_WINDOW_MS } from '../utils/app-reload.ts';
import { sanitizeExceptionProperties } from '../utils/error-telemetry.ts';
type Consent = typeof ANALYTICS_CONSENT[keyof typeof ANALYTICS_CONSENT];
type AnalyticsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
interface AcquisitionLocation { referrer?: string; location?: Pick<Location, 'origin' | 'search'> }
interface TrackingOptions { storage?: AnalyticsStorage | null; now?: number | (() => number); track?: (eventName: ProductAnalyticsEvent, params?: Record<string, unknown>) => Promise<unknown> }

// Vercel counts page views; PostHog measures repeat product use with a
// persistent browser identifier, linked to the account on sign-in. Both
// respect the browser's analytics preference. The event allowlist keeps
// account details, free text and raw URLs out of product analytics.

export const ANALYTICS_CONSENT_KEY = 'papertok_analytics_consent';
export const ANALYTICS_CONSENT_COOKIE_KEY = 'papertok_analytics_decision';
export const ANALYTICS_CONSENT = Object.freeze({
  ENABLED: 'enabled',
  DENIED: 'denied',
});

const ANALYTICS_CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const ANALYTICS_ACTIVATION_KEY = 'papertok_analytics_activation_at';
const ANALYTICS_ACTIVATION_EVENT_KEY = 'papertok_analytics_activation_sent';
const ANALYTICS_DAY_7_KEY = 'papertok_analytics_day_7_return_sent';
const ANALYTICS_ACQUISITION_SESSION_KEY = 'papertok_analytics_acquisition_sent';
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_7_MS = 7 * DAY_MS;

// Every route `app.tsx` declares has to appear here (or be matched by one of
// the patterns in `normalizeAnalyticsPath`), because anything else is filed
// under `/unknown` — a page that exists, is used, and is invisible in every
// report. `/profile`, `/settings/profile`, `/settings/comments` and
// `/admin/moderation` shipped missing and took a tenth of all page views with
// them; `/research` (removed) and its legacy alias `/report` both
// redirect to `/feed`, `/profile` (removed) redirects to `/lists`, and they
// stay listed so those arrivals read as the old link they came from rather
// than as noise. The test 'every route the app
// declares is a named analytics path' is what keeps this list from drifting
// behind the router again.
const STATIC_ANALYTICS_PATHS = new Set([
  // The landing, and the only entry here that is not a route of this app at
  // all: `/` is served by index.html, which loads no analytics. It stays
  // because it is still what a route-less or malformed read normalizes down to
  // — `sanitizeAnalyticsEventUrl` falls back to it for a URL it cannot parse.
  '/',
  // The app's own home since it moved off `/`. Every entry below is now a real
  // path the server sees, not a fragment: `location.pathname` IS the route
  // (src/main.tsx), which is what this whole list has to keep pace with.
  '/feed',
  '/following',
  '/lists',
  '/login',
  '/onboarding',
  '/institution/verify',
  '/profile',
  '/report',
  '/research',
  '/search',
  '/settings',
  '/settings/discovery',
  '/settings/following',
  '/settings/notifications',
  '/settings/privacy',
  '/settings/profile',
  '/settings/reading',
]);
const EXPLORER_TYPES = new Set(['author', 'institution', 'project', 'topic']);
const PUBLIC_ANALYTICS_ENTITY_TYPES = new Set([
  ...EXPLORER_TYPES,
  'concept',
  'source',
]);
const SEARCH_ENGINE_HOSTS = ['google.', 'bing.com', 'duckduckgo.com', 'search.yahoo.', 'ecosia.org', 'brave.com'];
const SOCIAL_HOSTS = [
  'bsky.app',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'mastodon.social',
  'reddit.com',
  't.co',
  'threads.net',
  'twitter.com',
  'x.com',
  'youtube.com',
];

const CATEGORIES: Readonly<Record<string, Set<string>>> = Object.freeze({
  action: new Set(['add', 'remove']),
  acquisition_channel: new Set(['direct', 'organic_search', 'organic_social', 'referral', 'email', 'paid', 'other']),
  content_type: new Set(['paper', 'author', 'institution', 'project', 'topic', 'list', 'signup_cta', 'other']),
  destination: new Set(['publisher', 'pdf', 'doi', 'arxiv', 'other']),
  entity_type: new Set(['author', 'institution', 'project', 'topic']),
  language: new Set(['en', 'es']),
  method: new Set(['google', 'github', 'email', 'link', 'native', 'clipboard', 'other']),
  rewrite_result: new Set(['success', 'incomplete', 'error', 'cancelled']),
  rewrite_error: new Set(['AI_REWRITE_NEEDS_FULL_TEXT', 'AI_AUTH_REQUIRED', 'AI_QUOTA_EXHAUSTED', 'AI_NOT_CONFIGURED', 'AI_TIMEOUT', 'AI_BUSY', 'AI_INVALID_PAPER', 'AI_INVALID_RESPONSE', 'AI_EMPTY_RESPONSE', 'AI_CANCELLED', 'AI_REQUEST_TOO_LARGE', 'AI_INVALID_REQUEST_UPSTREAM', 'AI_UNAVAILABLE', 'other']),
  auth_result: new Set(['success', 'error', 'cancelled']),
  auth_error: new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/popup-blocked', 'auth/network-request-failed', 'AUTH_EMAIL_ALREADY_USED', 'other']),
  auth_reason: new Set(['default', 'related', 'explorer_search']),
  newsletter_action: new Set(['subscribe', 'unsubscribe']),
  rewrite_level: new Set(['beginner', 'university', 'researcher']),
  annotation_origin: new Set(['user', 'ai']),
  app_error_kind: new Set(['render_crash', 'chunk_load_failed', 'feed_load_failed']),
  activation_age: new Set(['day_0', 'day_1', 'days_2_6', 'days_7_13', 'days_14_29', 'days_30_59', 'days_60_plus']),
  ai_feature: new Set(['rewrite', 'annotation']),
  ai_quota_scope: new Set(['user', 'provider']),
  search_type: new Set(['all', 'papers', 'authors', 'institutions', 'projects', 'topics']),
  // `reader` and `auth_prompt` are the two surfaces the light redesign added.
  // A surface that is emitted but not listed here is not an error anywhere: the
  // sanitizer drops the parameter and the event still ships, so the event
  // arrives stripped of the one field that says where it happened. Adding a
  // screen means adding it here in the same commit.
  surface: new Set(['feed', 'following', 'lists', 'login', 'onboarding', 'search', 'settings', 'explorer', 'reader', 'auth_prompt', 'other']),
});

const PAPER_DETAIL = { paper_id: 'identifier' };

// The registry of product events: an event name the app emits must be a key
// here. `trackProductEvent` only accepts these keys, so an unregistered name
// fails the type check instead of being silently dropped.
const EVENT_PARAMETER_SCHEMAS = Object.freeze({
  // Sent once per browser session, so `activation_age` turns it into a
  // retention curve without an identifier: unset before activation, then how
  // long ago this browser activated.
  acquisition_view: { acquisition_channel: 'acquisition_channel', language: 'language', activation_age: 'activation_age' },
  paper_view: { surface: 'surface', position: 'boundedNumber', ...PAPER_DETAIL },
  paper_open: { surface: 'surface', destination: 'destination', position: 'boundedNumber', ...PAPER_DETAIL },
  search_performed: { search_type: 'search_type', result_count: 'boundedNumber', has_results: 'boolean' },
  follow_change: { entity_type: 'entity_type', action: 'action', surface: 'surface', entity_id: 'identifier' },
  save_change: { action: 'action', surface: 'surface', ...PAPER_DETAIL },
  share: { method: 'method', content_type: 'content_type', surface: 'surface' },
  login: { method: 'method' },
  sign_up: { method: 'method' },
  tutorial_begin: { language: 'language' },
  tutorial_complete: { language: 'language' },
  activation: {},
  newsletter_change: { action: 'newsletter_action' },
  day_7_return: {},
  select_content: { content_type: 'content_type', surface: 'surface', position: 'boundedNumber', method: 'method' },
  // The reader added by the light redesign. Its events (`paper_rewrite` through
  // `paper_highlight`) shipped instrumented and silent before they were
  // registered here: an unregistered event is not a smaller event, it is no
  // event at all.
  paper_rewrite: { level: 'rewrite_level', surface: 'surface', ...PAPER_DETAIL },
  reader_open: { surface: 'surface' },
  paper_rewrite_result: { level: 'rewrite_level', surface: 'surface', result: 'rewrite_result', cached: 'boolean', duration_ms: 'duration', error_code: 'rewrite_error' },
  auth_prompt_view: { reason: 'auth_reason', surface: 'surface' },
  auth_result: { method: 'method', surface: 'surface', result: 'auth_result', error_code: 'auth_error' },
  paper_highlight: { level: 'rewrite_level', surface: 'surface', ...PAPER_DETAIL },
  // Annotating a passage and taking the reading away are the two ends of what
  // the reader is for: one says the rewrite was worth marking up, the other
  // that it was worth keeping. Neither is measurable from `paper_rewrite`.
  // `origin` is what separates a note the reader wrote from an answer they
  // asked for — the second costs one of the day's AI uses and the first is free,
  // so counting them together would hide which one people actually want.
  paper_annotation: { level: 'rewrite_level', surface: 'surface', origin: 'annotation_origin', ...PAPER_DETAIL },
  // How the For You feed is landing, one event per twenty cards: of those
  // cards, how many were skipped, read past the reader's own median dwell,
  // liked and saved. Counts only; no paper, topic or account travels with it.
  feed_engagement: {
    cards: 'boundedNumber', skips: 'boundedNumber', deep_reads: 'boundedNumber', likes: 'boundedNumber', saves: 'boundedNumber',
  },
  // A failure the reader is left looking at: the error boundary's screen or the
  // feed's "Error loading papers". Only the kind travels, never the error.
  app_error: { kind: 'app_error_kind' },
  // A reader who ran out of AI uses for the day asked for more than the product
  // gives away, which is the clearest demand signal it has. `scope` keeps that
  // apart from the provider's own budget running out, which is an outage.
  ai_limit_reached: { feature: 'ai_feature', scope: 'ai_quota_scope' },
  // Likes from every surface. `feed_engagement` counts only the For You feed's.
  like_change: { action: 'action', ...PAPER_DETAIL },
  // How long a card was on screen, and how long the reader stayed open: the
  // time spent per paper, which no count of views can give.
  paper_dwell: { surface: 'surface', position: 'boundedNumber', seconds: 'seconds', ...PAPER_DETAIL },
  reader_time: { level: 'rewrite_level', seconds: 'seconds', ...PAPER_DETAIL },
}) satisfies Readonly<Record<string, Record<string, string>>>;

export type ProductAnalyticsEvent = keyof typeof EVENT_PARAMETER_SCHEMAS;

function isProductAnalyticsEvent(eventName: unknown): eventName is ProductAnalyticsEvent {
  return typeof eventName === 'string' && Object.hasOwn(EVENT_PARAMETER_SCHEMAS, eventName);
}

// A card or the reader left open in a forgotten tab is not four hours of reading.
const MAX_TRACKED_SECONDS = 4 * 60 * 60;

let acquisitionTrackedInMemory = false;
let analyticsClient: Promise<PostHog | null> | null = null;

function getBrowserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function getSessionStorage() {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function readAnalyticsConsentCookie() {
  if (typeof document === 'undefined') return null;
  try {
    const prefix = `${ANALYTICS_CONSENT_COOKIE_KEY}=`;
    const entry = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
    if (!entry) return null;
    const value = decodeURIComponent(entry.slice(prefix.length));
    return normalizeStoredConsent(value);
  } catch {
    return null;
  }
}

function persistAnalyticsConsentCookie(value: string) {
  if (typeof document === 'undefined') return false;
  try {
    const secure = globalThis.location?.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${ANALYTICS_CONSENT_COOKIE_KEY}=${encodeURIComponent(value)}; Max-Age=${ANALYTICS_CONSENT_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
    return readAnalyticsConsentCookie() === value;
  } catch {
    return false;
  }
}

function normalizeStoredConsent(value: string | null): Consent | null {
  if (value === 'granted' || value === ANALYTICS_CONSENT.DENIED) return ANALYTICS_CONSENT.DENIED;
  if (value === 'detailed' || value === ANALYTICS_CONSENT.ENABLED) return ANALYTICS_CONSENT.ENABLED;
  return null;
}

function readStoredAnalyticsConsent(storage?: AnalyticsStorage | null) {
  const targetStorage = storage === undefined ? getBrowserStorage() : storage;
  try {
    const value = targetStorage?.getItem(ANALYTICS_CONSENT_KEY);
    const consent = normalizeStoredConsent(value ?? null);
    if (consent) return consent;
  } catch {
    // The cookie below preserves the choice when browser storage is unavailable.
  }
  return storage === undefined ? readAnalyticsConsentCookie() : null;
}

// A previous anonymous-only choice did not permit persistent tracking.
// Preserve it as disabled rather than upgrading it to identified analytics.
export function readAnalyticsConsent(storage?: AnalyticsStorage | null): Consent {
  return readStoredAnalyticsConsent(storage) ?? ANALYTICS_CONSENT.ENABLED;
}

export function persistAnalyticsConsent(value: string, storage?: AnalyticsStorage | null) {
  if (!Object.values(ANALYTICS_CONSENT).includes(value as Consent)) return false;
  const targetStorage = storage === undefined ? getBrowserStorage() : storage;
  let persisted = false;
  try {
    targetStorage?.setItem(ANALYTICS_CONSENT_KEY, value);
    persisted = targetStorage?.getItem(ANALYTICS_CONSENT_KEY) === value;
  } catch {
    // Continue with the cookie fallback for browsers that restrict localStorage.
  }
  if (storage === undefined) persisted = persistAnalyticsConsentCookie(value) || persisted;
  return persisted;
}

export function normalizeAnalyticsPath(pathname = '/') {
  const rawPath = String(pathname || '/').split(/[?#]/, 1)[0];
  const path = `/${rawPath.split('/').filter(Boolean).join('/')}`.replace(/\/+$/, '') || '/';
  if (STATIC_ANALYTICS_PATHS.has(path)) return path;

  const explorerMatch = path.match(/^\/explorer\/([^/]+)\/[^/]+$/);
  if (explorerMatch) {
    const type = EXPLORER_TYPES.has(explorerMatch[1]) ? explorerMatch[1] : 'entity';
    return `/explorer/${type}/:id`;
  }

  const publicEntityMatch = path.match(/^\/public\/entity\/([^/]+)\/[^/]+$/);
  if (publicEntityMatch) {
    const type = PUBLIC_ANALYTICS_ENTITY_TYPES.has(publicEntityMatch[1])
      ? publicEntityMatch[1]
      : 'entity';
    return `/public/entity/${type}/:id`;
  }
  if (/^\/paper\/[^/]+$/.test(path)) return '/paper/:id';
  // The address before ENG-44. What an earlier visit stored (its first URL, the
  // previous page) still carries it, and it is on screen for one render when
  // app.tsx redirects it.
  if (/^\/public\/paper\/[^/]+$/.test(path)) return '/public/paper/:id';
  if (/^\/public\/list\/[^/]+$/.test(path)) return '/public/list/:id';

  return '/unknown';
}

export function sanitizeAnalyticsLocation(pathname: string|undefined, browserLocation: Pick<Location, 'origin'> | undefined = globalThis.location) {
  const pagePath = normalizeAnalyticsPath(pathname);
  try {
    const origin = new URL(browserLocation?.origin).origin;
    if (!/^https?:$/.test(new URL(origin).protocol)) return pagePath;
    return `${origin}${pagePath}`;
  } catch {
    return pagePath;
  }
}

/**
 * The door that is easy to miss. Both transports read `location.href` on their
 * own: the Vercel script builds its payload's `url` field from it, and PostHog
 * fills `$current_url` from it on EVERY event, page view or not. That string is
 * whatever the address bar says: `https://papertok.app/paper/<the real
 * id>`, or `/search?q=<what was searched>`, precisely the value the privacy
 * policy promises never leaves the browser. AnalyticsContext's `beforeSend`
 * and `sanitizeAnalyticsCapture` are where it gets replaced, and this is what
 * replaces it.
 *
 * The fragment branch below is the LEGACY case, and it stays because links
 * minted before the migration are still out there: one arrives as
 * `/#/public/paper/<id>`, and `utils/legacy-hash-route.ts` translates it inside
 * the app — so `location.href` can carry a fragment route for the length of one
 * page view. Both forms read the same way and reach the same normalizer.
 */
export function sanitizeAnalyticsEventUrl(url: unknown) {
  try {
    const parsed = new URL(url as string);
    const fragmentPath = parsed.hash.startsWith('#/') ? parsed.hash.slice(1) : '';
    return sanitizeAnalyticsLocation(fragmentPath || parsed.pathname, parsed);
  } catch {
    // An unparseable URL is not a reason to ship the original: fall back to the
    // path with no origin, which is still a valid page for the report.
    return normalizeAnalyticsPath('/');
  }
}

export function sanitizeProductEventParams(eventName: string | number, params: Record<string, unknown> = {}, consent = readAnalyticsConsent()) {
  const schema: Readonly<Record<string, string>> | undefined = isProductAnalyticsEvent(eventName) ? EVENT_PARAMETER_SCHEMAS[eventName] : undefined;
  if (!schema || !params || typeof params !== 'object' || Array.isArray(params)) return {};

  return Object.entries(schema).reduce<Record<string, unknown>>((safeParams, [key, type]) => {
    const value = params[key];
    if (type === 'boolean' && typeof value === 'boolean') safeParams[key] = value;
    if (type === 'boundedNumber' && Number.isFinite(value)) {
      safeParams[key] = Math.min(1000, Math.max(0, Math.round(value as number)));
    }
    if (type === 'duration' && Number.isFinite(value)) safeParams[key] = Math.min(3_600_000, Math.max(0, Math.round(value as number)));
    if ((type === 'rewrite_error' || type === 'auth_error') && typeof value === 'string') {
      safeParams[key] = CATEGORIES[type].has(value) ? value : 'other';
    }
    if (type === 'seconds' && Number.isFinite(value)) {
      safeParams[key] = Math.min(MAX_TRACKED_SECONDS, Math.max(0, Math.round(value as number)));
    }
    if (type === 'identifier' && consent === ANALYTICS_CONSENT.ENABLED && typeof value === 'string' && value.trim()) {
      safeParams[key] = value.trim().slice(0, 300);
    }
    if (CATEGORIES[type]?.has(value as string)) safeParams[key] = value;
    return safeParams;
  }, {});
}

// The removed GA4 client left long-lived cookies behind. No active SDK owns
// them now, so remove them on mount independently of the analytics preference.
export function removeLegacyGoogleAnalyticsCookies() {
  if (typeof document === 'undefined') return;
  document.cookie.split(';').forEach(cookie => {
    const name = cookie.split('=')[0]?.trim();
    if (!name?.startsWith('_ga')) return;
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  });
}

function clearConsentScopedAnalyticsState(storage: AnalyticsStorage | null = getBrowserStorage()) {
  acquisitionTrackedInMemory = false;
  try {
    storage?.removeItem(ANALYTICS_ACTIVATION_KEY);
    storage?.removeItem(ANALYTICS_ACTIVATION_EVENT_KEY);
    storage?.removeItem(ANALYTICS_DAY_7_KEY);
    getSessionStorage()?.removeItem(ANALYTICS_ACQUISITION_SESSION_KEY);
  } catch {
    // Consent withdrawal still disables collection when storage is unavailable.
  }
}

// Allowing only has to persist: AnalyticsProvider renders the Vercel script
// while analytics is on, and PostHog loads on the next event. A PostHog
// already loaded in this tab switches level at once (see `applyConsent`).
// Withdrawing stops recording at once: the provider stops rendering the Vercel
// script and sending its page views, and the senders below and
// `sanitizeAnalyticsCapture` read the stored choice at capture time. Events
// recorded before can still leave afterwards: in PostHog's next batch, or, for
// a send that failed (offline, say), whenever its retry queue gets through.
export async function setAnalyticsConsent(value: string) {
  if (!persistAnalyticsConsent(value)) return false;
  if (value === ANALYTICS_CONSENT.DENIED) clearConsentScopedAnalyticsState();
  const client = analyticsClient && await analyticsClient;
  if (client) applyConsent(client, value as Consent);
  return true;
}

// Public by design, like the Firebase web config: this token sends events and
// reads the project's public client config (flags, surveys), never its data.
const POSTHOG_PROJECT_TOKEN = 'phc_BNGdTudnBx4BoLJFLChGGbCzsBtNLagJJ5vgiVNha9yy';

// Only the production site reports. Preview deployments are production builds
// that share vercel.json, and a local server has nothing behind the proxy.
const ANALYTICS_HOSTS = new Set(['papertok.app', 'www.papertok.app']);

// Start opted out so init cannot emit anything before our stored preference
// is applied. Persistence then lets repeat visits retain the same identity.
const POSTHOG_OPTIONS: Partial<PostHogConfig> = {
  api_host: '/ingest',
  ui_host: 'https://eu.posthog.com',
  persistence: 'localStorage+cookie',
  opt_out_capturing_by_default: true,
  opt_out_persistence_by_default: true,
  advanced_disable_flags: true,
  disable_surveys: true,
  disable_product_tours: true,
  disable_conversations: true,
  save_campaign_params: false,
  save_referrer: false,
  person_profiles: 'identified_only',
  // Page views are sent by `trackPageView`, one per pathname. PostHog's own
  // would read the address bar on every history change.
  capture_pageview: false,
  capture_pageleave: false,
  autocapture: false,
  capture_heatmaps: false,
  capture_dead_clicks: false,
  capture_exceptions: true,
  capture_performance: false,
  disable_session_recording: true,
  before_send: sanitizeAnalyticsCapture,
};

/**
 * Keep the SDK's identity and session fields so identify can join guest use
 * to an account. Strip automatic page metadata and person properties: these
 * may contain searches, credentials or names.
 */
const POSTHOG_PROPERTIES = new Set([
  'token',
  'distinct_id',
  '$cookieless_mode',
  '$process_person_profile',
  '$host',
  '$device_id',
  '$user_id',
  '$anon_distinct_id',
  '$session_id',
  '$window_id',
  '$insert_id',
  '$time',
  '$lib',
  '$lib_version',
  '$browser',
  '$browser_version',
  '$os',
  '$os_version',
  '$device_type',
]);

/**
 * Apply the event and property allowlists to every capture, including SDK
 * identity events. Error messages and raw URLs can contain private content.
 */
export function sanitizeAnalyticsCapture(capture: CaptureResult | null, consent = readAnalyticsConsent()): CaptureResult | null {
  if (!capture || consent === ANALYTICS_CONSENT.DENIED) return null;
  const { event, properties = {} } = capture;
  const exception = event === '$exception' ? sanitizeExceptionProperties(properties) : null;
  if (event !== '$pageview' && event !== '$identify' && !exception && !Object.hasOwn(EVENT_PARAMETER_SCHEMAS, event)) return null;

  const currentUrl = sanitizeAnalyticsEventUrl(properties.$current_url);
  const kept = Object.fromEntries(
    Object.entries(properties).filter(([key]) => POSTHOG_PROPERTIES.has(key)),
  );
  return {
    uuid: capture.uuid,
    event,
    timestamp: capture.timestamp,
    properties: {
      ...kept,
      ...(exception ?? sanitizeProductEventParams(event, properties, consent)),
      $current_url: currentUrl,
      $pathname: new URL(currentUrl, 'https://papertok.app').pathname,
    },
  };
}

/**
 * The same last step for Vercel Web Analytics (`beforeSend`): the normalized
 * address, or nothing once the reader has turned analytics off. The choice is
 * read from storage at send time rather than from the tab's React state,
 * because another tab may have turned analytics off since this one rendered.
 */
export function sanitizeVercelEvent<T extends { url: string }>(event: T | null, consent = readAnalyticsConsent()) {
  if (!event || consent === ANALYTICS_CONSENT.DENIED) return null;
  return { ...event, url: sanitizeAnalyticsEventUrl(event.url) };
}

/**
 * Loaded on the first event of a reader who has not turned analytics off, so
 * for anyone who has, the library is never even downloaded. PostHog drops a
 * capture made before `init` instead of queueing it, so every send waits for
 * this promise rather than firing into a client that is not ready yet.
 *
 * A load that fails is not retried: the tab stops reporting, and the next page
 * load tries again. Vite reports the failure like any other chunk's, so
 * main.jsx's reload (once a minute at most) applies to it, which is the right
 * answer when a deploy replaced the chunk. That is also why nothing is loaded
 * while the browser says it is offline: a failure there would only reload.
 */
function loadAnalyticsClient() {
  if (!analyticsClient && globalThis.navigator?.onLine === false) return Promise.resolve(null);
  analyticsClient ??= import('posthog-js')
    .then(({ posthog }) => {
      startAnalyticsClient(posthog, readAnalyticsConsent());
      return posthog;
    })
    .catch(() => null);
  return analyticsClient;
}

type ConsentControls = Pick<PostHog, 'has_opted_in_capturing' | 'opt_in_capturing' | 'opt_out_capturing' | 'reset'>;

export function startAnalyticsClient(client: ConsentControls & { init(token: string, config: Partial<PostHogConfig>): unknown }, consent: Consent) {
  client.init(POSTHOG_PROJECT_TOKEN, POSTHOG_OPTIONS);
  applyConsent(client, consent);
}

// Do not opt in again on reload: the SDK must retain its browser identity.
function applyConsent(client: ConsentControls, consent: Consent) {
  const enabled = consent === ANALYTICS_CONSENT.ENABLED;
  if (enabled === client.has_opted_in_capturing()) return;
  if (enabled) client.opt_in_capturing({ captureEventName: false });
  else {
    client.reset(true);
    client.opt_out_capturing();
  }
}

export interface AnalyticsUser { uid: string }
let identityVersion = 0;

/**
 * Reset on sign-out and account switches so one account cannot inherit
 * another account's activity. The SDK owns the persistent browser identity.
 */
export async function identifyAnalyticsUser(user: AnalyticsUser | null) {
  const version = ++identityVersion;
  if (readAnalyticsConsent() === ANALYTICS_CONSENT.DENIED || !canSendAnalytics()) return;
  const client = await loadAnalyticsClient();
  if (version !== identityVersion || readAnalyticsConsent() === ANALYTICS_CONSENT.DENIED || !client || !client.has_opted_in_capturing()) return;
  // PostHog's own persisted state, so a sign-out in another tab counts too.
  const identifiedAs = client.get_property('$user_state') === 'identified' ? client.get_distinct_id() : null;
  if (identifiedAs && identifiedAs !== user?.uid) {
    // `reset` also forgets the opt-in, which this module owns.
    client.reset();
    client.opt_in_capturing({ captureEventName: false });
  }
  if (!user || identifiedAs === user.uid) return;
  client.identify(user.uid);
}

function canSendAnalytics() {
  return typeof window !== 'undefined' && ANALYTICS_HOSTS.has(globalThis.location?.hostname);
}

// `true` means PostHog accepted the event into its send queue, which is as much
// as a batched transport can honestly report. The callers' bookkeeping
// (`activation`, `day_7_return`, the guest demo) relies on it never being true
// for an event that was dropped.
async function sendAnalyticsEvent(eventName: string, properties: Record<string, unknown>) {
  if (!canSendAnalytics()) return false;
  const client = await loadAnalyticsClient();
  return Boolean(client?.capture(eventName, properties));
}

/**
 * One view per change of concrete pathname, filed under its pattern: two papers
 * share `/paper/:id` and are still two views. PostHog's own page view
 * capture stays off because it would read the address bar. The URL is fixed
 * here, from the route the view belongs to, so a navigation made while the
 * library loads cannot file this view under the next page.
 */
export async function trackPageView(pathname: string) {
  const consent = readAnalyticsConsent();
  if (consent === ANALYTICS_CONSENT.DENIED) return false;
  // Read now: by the time the library has loaded, the address may be the next page's.
  const url = sanitizeAnalyticsLocation(pathname);
  return sendAnalyticsEvent('$pageview', { $current_url: url });
}

export async function trackProductEvent(eventName: ProductAnalyticsEvent, params: Record<string, unknown> = {}) {
  if (!Object.hasOwn(EVENT_PARAMETER_SCHEMAS, eventName)) return false;
  const consent = readAnalyticsConsent();
  if (consent === ANALYTICS_CONSENT.DENIED) return false;
  return sendAnalyticsEvent(eventName, sanitizeProductEventParams(eventName, params, consent));
}

function hostnameMatches(hostname: string, patterns: string[]) {
  return patterns.some(pattern => hostname === pattern || hostname.endsWith(`.${pattern}`) || hostname.includes(pattern));
}

export function inferAcquisitionChannel({
  referrer = globalThis.document?.referrer || '',
  location = globalThis.location,
}: AcquisitionLocation = {}) {
  const medium = (() => {
    try {
      return new URLSearchParams(location?.search || '').get('utm_medium')?.toLowerCase() || '';
    } catch {
      return '';
    }
  })();

  if (['email', 'newsletter'].includes(medium)) return 'email';
  if (['cpc', 'ppc', 'paid', 'paid_search', 'paid_social', 'display'].includes(medium)) return 'paid';
  if (['social', 'social-network', 'social_media', 'organic_social'].includes(medium)) return 'organic_social';
  if (!referrer) return 'direct';

  try {
    const referrerUrl = new URL(referrer);
    const currentOrigin = location?.origin ? new URL(location.origin).origin : '';
    if (currentOrigin && referrerUrl.origin === currentOrigin) return 'direct';
    const hostname = referrerUrl.hostname.toLowerCase();
    if (hostnameMatches(hostname, SEARCH_ENGINE_HOSTS)) return 'organic_search';
    if (hostnameMatches(hostname, SOCIAL_HOSTS)) return 'organic_social';
    return 'referral';
  } catch {
    return 'other';
  }
}

// Coarse on purpose: a day-exact activation date beside the device type would
// narrow a small audience down to one person.
function activationAge(now: number) {
  const activatedAt = Number(getBrowserStorage()?.getItem(ANALYTICS_ACTIVATION_KEY));
  if (!Number.isFinite(activatedAt) || activatedAt <= 0) return undefined;
  const days = Math.floor((now - activatedAt) / DAY_MS);
  if (days <= 0) return 'day_0';
  if (days === 1) return 'day_1';
  if (days < 7) return 'days_2_6';
  if (days < 14) return 'days_7_13';
  if (days < 30) return 'days_14_29';
  if (days < 60) return 'days_30_59';
  return 'days_60_plus';
}

export async function trackAcquisition({
  storage = getSessionStorage(),
  referrer,
  location,
  now = Date.now,
  track = trackProductEvent,
}: AcquisitionLocation & TrackingOptions & { language?: string } = {}) {
  if (readAnalyticsConsent() === ANALYTICS_CONSENT.DENIED) return false;
  try {
    const persistedForSession = storage?.getItem(ANALYTICS_ACQUISITION_SESSION_KEY) === 'true';
    if (persistedForSession || (!storage && acquisitionTrackedInMemory)) return false;
    const age = activationAge(resolveTimestamp(now));
    const tracked = await track('acquisition_view', {
      acquisition_channel: inferAcquisitionChannel({ referrer, location }),
      language: 'en',
      ...(age && { activation_age: age }),
    });
    if (!tracked) return false;
    acquisitionTrackedInMemory = true;
    storage?.setItem(ANALYTICS_ACQUISITION_SESSION_KEY, 'true');
    return true;
  } catch {
    return false;
  }
}

function resolveTimestamp(now: number | (() => number)) {
  const timestamp = typeof now === 'function' ? now() : now;
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

// Marks whose send is still waiting, in this tab. The first event of a page
// waits for PostHog to load, and a second call in that window would otherwise
// pass the stored check and send the mark twice: opening `/` asks on the way in
// and again after the redirect to `/feed`. Kept in memory, not in storage, so a
// tab closed mid-send leaves the mark unsent and the next visit tries again.
const marksInFlight = new Set<string>();

export async function markActivation({ storage = getBrowserStorage(), now = Date.now, track = trackProductEvent }: TrackingOptions = {}) {
  if (readAnalyticsConsent(storage) === ANALYTICS_CONSENT.DENIED) return false;

  try {
    if (storage?.getItem(ANALYTICS_ACTIVATION_EVENT_KEY) === 'true') return false;
    if (marksInFlight.has(ANALYTICS_ACTIVATION_EVENT_KEY)) return false;
    const timestamp = resolveTimestamp(now);
    marksInFlight.add(ANALYTICS_ACTIVATION_EVENT_KEY);
    try {
      const tracked = await track('activation');
      if (!tracked) return false;
      storage?.setItem(ANALYTICS_ACTIVATION_KEY, String(timestamp));
      storage?.setItem(ANALYTICS_ACTIVATION_EVENT_KEY, 'true');
      return true;
    } finally {
      marksInFlight.delete(ANALYTICS_ACTIVATION_EVENT_KEY);
    }
  } catch {
    return false;
  }
}

export async function trackDay7Return({ storage = getBrowserStorage(), now = Date.now, track = trackProductEvent }: TrackingOptions = {}) {
  if (readAnalyticsConsent(storage) === ANALYTICS_CONSENT.DENIED) return false;

  try {
    if (storage?.getItem(ANALYTICS_DAY_7_KEY) === 'true') return false;
    if (marksInFlight.has(ANALYTICS_DAY_7_KEY)) return false;
    const activatedAt = Number(storage?.getItem(ANALYTICS_ACTIVATION_KEY));
    if (!Number.isFinite(activatedAt) || activatedAt <= 0) return false;
    if (resolveTimestamp(now) - activatedAt < DAY_7_MS) return false;
    marksInFlight.add(ANALYTICS_DAY_7_KEY);
    try {
      const tracked = await track('day_7_return');
      if (!tracked) return false;
      storage?.setItem(ANALYTICS_DAY_7_KEY, 'true');
      return true;
    } finally {
      marksInFlight.delete(ANALYTICS_DAY_7_KEY);
    }
  } catch {
    return false;
  }
}

// main.tsx imports this module through the boundary, so it is evaluated before
// this page can write a reload mark. Both marks are written with Date.now().
const PAGE_LOADED_AT = Date.now();
// The error boundary's fallback stays up until the reader reloads, so one
// report per page load covers it.
let appCrashReported = false;

/**
 * The report for GlobalErrorBoundary, which sits outside AnalyticsProvider.
 * A crash inside main.tsx's window after an earlier page's chunk reload counts
 * as the chunk failing again. A forced-reload mark written by this page means
 * the app is already reloading it, for a missing chunk (main.tsx) or for a
 * deploy (utils/service-worker-updates.ts). The crash is then not what the
 * reader is left looking at, and the next page reports it if it recurs.
 */
export async function trackAppCrash({
  storage = getSessionStorage(),
  now = Date.now(),
  pageLoadedAt = PAGE_LOADED_AT,
  track = trackProductEvent,
}: Omit<TrackingOptions, 'now'> & { now?: number; pageLoadedAt?: number } = {}) {
  if (appCrashReported) return false;
  let reloadedAt = 0;
  let forcedReloadAt = 0;
  try {
    reloadedAt = Number(storage?.getItem(PRELOAD_RELOAD_KEY)) || 0;
    forcedReloadAt = Number(storage?.getItem(APP_RELOAD_KEY)) || 0;
  } catch {
    // Without session storage main.tsx does not reload, and a deploy reload
    // leaves no mark to recognise.
  }
  if (forcedReloadAt >= pageLoadedAt) return false;
  appCrashReported = true;
  const kind = now - reloadedAt < PRELOAD_RELOAD_WINDOW_MS ? 'chunk_load_failed' : 'render_crash';
  return track('app_error', { kind });
}

// The error boundary's report. PostHog captures uncaught errors and rejections
// itself once loaded, but React hands a render error to the boundary instead.
export async function captureAppException(error: unknown) {
  if (readAnalyticsConsent() === ANALYTICS_CONSENT.DENIED || !canSendAnalytics()) return;
  const client = await loadAnalyticsClient();
  client?.captureException(error, { operation: 'render' });
}
