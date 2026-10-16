// Two transports with different jobs. Vercel Web Analytics counts visits,
// pages and countries; AnalyticsProvider renders its <Analytics /> and sends the
// page views. PostHog's EU cloud, in cookieless mode and loaded on the first
// event, receives the product events below. This file's actual subject is what
// both share: the consent gate (an opt-out since 2026-09-17), the event
// registry, and the path normalizer that keeps an identifier out of a report.

export const ANALYTICS_CONSENT_KEY = 'papertok_analytics_consent';
export const ANALYTICS_CONSENT_COOKIE_KEY = 'papertok_analytics_decision';
export const ANALYTICS_CONSENT = Object.freeze({
  GRANTED: 'granted',
  DENIED: 'denied',
});

export const PRODUCT_ANALYTICS_EVENTS = Object.freeze([
  'acquisition_view',
  'guest_demo_start',
  'paper_view',
  'paper_open',
  'search_performed',
  'follow_change',
  'save_change',
  'share',
  'login',
  'sign_up',
  'tutorial_begin',
  'tutorial_complete',
  'activation',
  'newsletter_change',
  'day_7_return',
  'select_content',
  // The reader added by the light redesign. `trackProductEvent` returns false on
  // the first line for a name that is not here, so an unregistered event is not
  // a smaller event — it is no event at all, with nothing at the call site to
  // say so. Both of these shipped instrumented and silent.
  'paper_rewrite',
  'paper_highlight',
  // Annotating a passage and taking the reading away are the two ends of what
  // the reader is for: one says the rewrite was worth marking up, the other
  // that it was worth keeping. Neither is measurable from `paper_rewrite`.
  'paper_annotation',
  'paper_export',
  // The far end of the guest run. `guest_demo_start` already marks where a
  // visitor begins; without its pair, the only thing measurable was how many
  // people started, never how many reached the wall. It was being sent as
  // `select_content`, which is GA4's name for a *click*, so an impression
  // arrived counted as one and the card looked like it converted every viewer.
  'guest_demo_end',
  // The interests prompt a guest meets once the sample feed is on screen.
  // `set` is an answer, `skip` a "not now", `clear` a pick emptied out from
  // the header chip; `areas` is how many areas the answer holds.
  'guest_interests',
]);

const ANALYTICS_CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const ANALYTICS_ACTIVATION_KEY = 'papertok_analytics_activation_at';
const ANALYTICS_ACTIVATION_EVENT_KEY = 'papertok_analytics_activation_sent';
const ANALYTICS_DAY_7_KEY = 'papertok_analytics_day_7_return_sent';
const ANALYTICS_ACQUISITION_SESSION_KEY = 'papertok_analytics_acquisition_sent';
const DAY_7_MS = 7 * 24 * 60 * 60 * 1000;

// Every route `App.jsx` declares has to appear here (or be matched by one of
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
  // (src/main.jsx), which is what this whole list has to keep pace with.
  '/feed',
  '/following',
  '/lists',
  '/login',
  '/onboarding',
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

const CATEGORIES = Object.freeze({
  action: new Set(['add', 'remove']),
  acquisition_channel: new Set(['direct', 'organic_search', 'organic_social', 'referral', 'email', 'paid', 'other']),
  content_type: new Set(['paper', 'author', 'institution', 'project', 'topic', 'list', 'signup_cta', 'other']),
  destination: new Set(['publisher', 'pdf', 'doi', 'arxiv', 'other']),
  entity_type: new Set(['author', 'institution', 'project', 'topic']),
  entry_point: new Set(['home', 'login', 'onboarding', 'shared_link', 'other']),
  guest_interests_action: new Set(['set', 'skip', 'clear']),
  language: new Set(['en', 'es']),
  method: new Set(['google', 'email', 'link', 'native', 'clipboard', 'other']),
  newsletter_action: new Set(['subscribe', 'unsubscribe']),
  rewrite_level: new Set(['beginner', 'university', 'researcher']),
  annotation_origin: new Set(['user', 'ai']),
  export_format: new Set(['tex']),
  search_type: new Set(['all', 'papers', 'authors', 'institutions', 'projects', 'topics']),
  // `reader` and `auth_prompt` are the two surfaces the light redesign added.
  // A surface that is emitted but not listed here is not an error anywhere: the
  // sanitizer drops the parameter and the event still ships, so the event
  // arrives stripped of the one field that says where it happened. Adding a
  // screen means adding it here in the same commit.
  surface: new Set(['feed', 'following', 'lists', 'login', 'onboarding', 'search', 'settings', 'explorer', 'reader', 'auth_prompt', 'other']),
});

const EVENT_PARAMETER_SCHEMAS = Object.freeze({
  acquisition_view: { acquisition_channel: 'acquisition_channel', language: 'language' },
  guest_demo_start: { entry_point: 'entry_point', language: 'language' },
  paper_view: { surface: 'surface', position: 'boundedNumber' },
  paper_open: { surface: 'surface', destination: 'destination', position: 'boundedNumber' },
  search_performed: { search_type: 'search_type', result_count: 'boundedNumber', has_results: 'boolean' },
  follow_change: { entity_type: 'entity_type', action: 'action', surface: 'surface' },
  save_change: { action: 'action', surface: 'surface' },
  share: { method: 'method', content_type: 'content_type', surface: 'surface' },
  login: { method: 'method' },
  sign_up: { method: 'method' },
  tutorial_begin: { language: 'language' },
  tutorial_complete: { language: 'language' },
  activation: {},
  newsletter_change: { action: 'newsletter_action' },
  day_7_return: {},
  select_content: { content_type: 'content_type', surface: 'surface', position: 'boundedNumber' },
  paper_rewrite: { level: 'rewrite_level', surface: 'surface' },
  paper_highlight: { level: 'rewrite_level', surface: 'surface' },
  // `origin` is what separates a note the reader wrote from an answer they
  // asked for — the second costs one of the day's AI uses and the first is free,
  // so counting them together would hide which one people actually want.
  paper_annotation: { level: 'rewrite_level', surface: 'surface', origin: 'annotation_origin' },
  paper_export: { level: 'rewrite_level', surface: 'surface', format: 'export_format', notes: 'boundedNumber' },
  // Mirrors `guest_demo_start`'s shape so the two ends of the run can be read
  // as one funnel; `position` is how many papers were behind the reader.
  guest_demo_end: { position: 'boundedNumber', language: 'language' },
  guest_interests: { action: 'guest_interests_action', areas: 'boundedNumber', language: 'language' },
});

let acquisitionTrackedInMemory = false;

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
    return Object.values(ANALYTICS_CONSENT).includes(value) ? value : null;
  } catch {
    return null;
  }
}

function persistAnalyticsConsentCookie(value) {
  if (typeof document === 'undefined') return false;
  try {
    const secure = globalThis.location?.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${ANALYTICS_CONSENT_COOKIE_KEY}=${encodeURIComponent(value)}; Max-Age=${ANALYTICS_CONSENT_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
    return readAnalyticsConsentCookie() === value;
  } catch {
    return false;
  }
}

// Granted unless the reader has said otherwise. Nobody is asked any more
// (2026-09-17): neither transport sets cookies or identifies anybody (Vercel
// Web Analytics by design, PostHog in cookieless mode, see POSTHOG_OPTIONS), and
// one choice turns both off: the switch in Settings, or
// a visitor's Privacy button (PrivacyPopover), is the way out. The default is
// never written down -- a stored "granted" means somebody chose it, a stored
// "denied" is respected, and an empty store IS the default.
export function readAnalyticsConsent(storage) {
  const targetStorage = storage === undefined ? getBrowserStorage() : storage;
  try {
    const value = targetStorage?.getItem(ANALYTICS_CONSENT_KEY);
    if (Object.values(ANALYTICS_CONSENT).includes(value)) return value;
  } catch {
    // The cookie below preserves the choice when browser storage is unavailable.
  }
  const stored = storage === undefined ? readAnalyticsConsentCookie() : null;
  return stored ?? ANALYTICS_CONSENT.GRANTED;
}

export function persistAnalyticsConsent(value, storage) {
  if (!Object.values(ANALYTICS_CONSENT).includes(value)) return false;
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
  if (/^\/public\/paper\/[^/]+$/.test(path)) return '/public/paper/:id';
  if (/^\/public\/list\/[^/]+$/.test(path)) return '/public/list/:id';

  return '/unknown';
}

export function sanitizeAnalyticsLocation(pathname, browserLocation = globalThis.location) {
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
 * whatever the address bar says: `https://papertok.app/public/paper/<the real
 * id>`, or `/search?q=<what was searched>`, precisely the value the privacy
 * policy promises never leaves the browser. AnalyticsContext's `beforeSend`
 * and `sanitizeAnalyticsCapture` are where it gets replaced, and this is what
 * replaces it.
 *
 * The fragment branch below is the LEGACY case, and it stays because links
 * minted before the migration are still out there: one arrives as
 * `/#/public/paper/<id>`, and `utils/legacyHashRoute.js` translates it inside
 * the app — so `location.href` can carry a fragment route for the length of one
 * page view. Both forms read the same way and reach the same normalizer.
 */
export function sanitizeAnalyticsEventUrl(url) {
  try {
    const parsed = new URL(url);
    const fragmentPath = parsed.hash.startsWith('#/') ? parsed.hash.slice(1) : '';
    return sanitizeAnalyticsLocation(fragmentPath || parsed.pathname, parsed);
  } catch {
    // An unparseable URL is not a reason to ship the original: fall back to the
    // path with no origin, which is still a valid page for the report.
    return normalizeAnalyticsPath('/');
  }
}

export function sanitizeProductEventParams(eventName, params = {}) {
  const schema = EVENT_PARAMETER_SCHEMAS[eventName];
  if (!schema || !params || typeof params !== 'object' || Array.isArray(params)) return {};

  return Object.entries(schema).reduce((safeParams, [key, type]) => {
    const value = params[key];
    if (type === 'boolean' && typeof value === 'boolean') safeParams[key] = value;
    if (type === 'boundedNumber' && Number.isFinite(value)) {
      safeParams[key] = Math.min(1000, Math.max(0, Math.round(value)));
    }
    if (CATEGORIES[type]?.has(value)) safeParams[key] = value;
    return safeParams;
  }, {});
}

/**
 * Anyone who granted consent before the move to Vercel is carrying `_ga` and
 * `_ga_<id>` cookies with a two-year expiry, set by a measurement library this
 * app no longer loads. Nothing reads them any more and nothing else will ever
 * clear them, so they would sit in the browser until 2028 as the only remaining
 * trace of GA4. Neither current transport sets cookies of its own, which is why
 * this is a one-off cleanup on mount rather than part of withdrawing consent.
 */
export function removeLegacyGoogleAnalyticsCookies() {
  if (typeof document === 'undefined') return;
  document.cookie.split(';').forEach(cookie => {
    const name = cookie.split('=')[0]?.trim();
    if (!name?.startsWith('_ga')) return;
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  });
}

function clearConsentScopedAnalyticsState(storage = getBrowserStorage()) {
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

// Granting only has to persist: AnalyticsProvider renders the Vercel script
// while consent reads as granted, and PostHog loads on the next event.
// Withdrawing stops recording at once: the provider stops rendering the Vercel
// script and sending its page views, and the senders below and
// `sanitizeAnalyticsCapture` read the stored choice at capture time. A library
// already loaded in this tab stays in memory and records nothing new. Events
// recorded before can still leave afterwards: in PostHog's next batch, or, for
// a send that failed (offline, say), whenever its retry queue gets through.
// Kept `async` because every caller awaits it.
export async function setAnalyticsConsent(value) {
  if (!persistAnalyticsConsent(value)) return false;
  if (value === ANALYTICS_CONSENT.GRANTED) return true;
  clearConsentScopedAnalyticsState();
  return true;
}

// Public by design, like the Firebase web config: this token sends events and
// reads the project's public client config (flags, surveys), never its data.
const POSTHOG_PROJECT_TOKEN = 'phc_BNGdTudnBx4BoLJFLChGGbCzsBtNLagJJ5vgiVNha9yy';

// Only the production site reports. Preview deployments are production builds
// that share vercel.json, and a local server has nothing behind the proxy.
const ANALYTICS_HOSTS = new Set(['papertok.app', 'www.papertok.app']);

/**
 * Everything PostHog would switch on by itself stays off. `cookieless_mode`
 * keeps the SDK out of cookies and storage, and PostHog's servers tell visits
 * apart with a hash of IP and browser whose salt changes every day. It needs
 * "Cookieless server hash mode" on in the project settings, or PostHog drops
 * every event. With flags off, nothing can be switched back on from the
 * PostHog dashboard, and no script is fetched besides this module. Requests go
 * to our own origin, which vercel.json rewrites to PostHog's EU host.
 */
const POSTHOG_OPTIONS = {
  api_host: '/ingest',
  ui_host: 'https://eu.posthog.com',
  cookieless_mode: 'always',
  person_profiles: 'never',
  autocapture: false,
  capture_pageview: false,
  capture_heatmaps: false,
  capture_dead_clicks: false,
  capture_exceptions: false,
  capture_performance: false,
  disable_session_recording: true,
  disable_surveys: true,
  advanced_disable_flags: true,
  disable_external_dependency_loading: true,
  // Collected only to be thrown away below; the device model is also read
  // through a high-entropy browser API.
  save_referrer: false,
  save_campaign_params: false,
  disableDeviceModel: true,
  before_send: sanitizeAnalyticsCapture,
};

/**
 * What survives of PostHog's own properties: the ones it needs to accept and
 * hash a cookieless event (the server drops one without `$raw_user_agent` or
 * `$host`, and deletes the user agent once hashed), and a coarse picture of the
 * device. The rest of what the SDK attaches is dropped, and some of it would
 * carry the person or the paper: `title` is a paper's title or a person's name
 * on public pages, `$pathname` and `$prev_pageview_pathname` are raw paths,
 * `ph_keyword` is what the reader typed into a search engine, and `$timezone`
 * says roughly where they are (without it, PostHog's daily hash turns over at
 * the project's midnight instead of the reader's). An allowlist, so a property
 * a future SDK version adds stays home until someone decides otherwise.
 */
const POSTHOG_PROPERTIES = new Set([
  'token',
  'distinct_id',
  '$cookieless_mode',
  '$process_person_profile',
  '$raw_user_agent',
  '$host',
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
 * The last step before an event leaves (`before_send`). Rebuilds it from the
 * allowlist above, the event's own parameter schema and the normalized URL, and
 * drops it when it is neither a page view nor a registered event, or when the
 * reader has turned analytics off.
 */
export function sanitizeAnalyticsCapture(capture, consent = readAnalyticsConsent()) {
  if (!capture || consent !== ANALYTICS_CONSENT.GRANTED) return null;
  const { event, properties = {} } = capture;
  if (event !== '$pageview' && !Object.hasOwn(EVENT_PARAMETER_SCHEMAS, event)) return null;

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
      ...sanitizeProductEventParams(event, properties),
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
export function sanitizeVercelEvent(event, consent = readAnalyticsConsent()) {
  if (!event || consent !== ANALYTICS_CONSENT.GRANTED) return null;
  return { ...event, url: sanitizeAnalyticsEventUrl(event.url) };
}

let analyticsClient = null;

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
  analyticsClient ??= import('posthog-js')
    .then(({ posthog }) => {
      posthog.init(POSTHOG_PROJECT_TOKEN, POSTHOG_OPTIONS);
      return posthog;
    })
    .catch(() => null);
  return analyticsClient;
}

// `true` means PostHog accepted the event into its send queue, which is as much
// as a batched transport can honestly report. The callers' bookkeeping
// (`activation`, `day_7_return`, the guest demo) relies on it never being true
// for an event that was dropped.
async function sendAnalyticsEvent(eventName, properties) {
  if (typeof window === 'undefined' || !ANALYTICS_HOSTS.has(globalThis.location?.hostname)) return false;
  if (!analyticsClient && globalThis.navigator?.onLine === false) return false;
  const client = await loadAnalyticsClient();
  return Boolean(client?.capture(eventName, properties));
}

/**
 * One view per change of concrete pathname, filed under its pattern: two papers
 * share `/public/paper/:id` and are still two views. PostHog's own page view
 * capture stays off because it would read the address bar. The URL is fixed
 * here, from the route the view belongs to, so a navigation made while the
 * library loads cannot file this view under the next page.
 */
export async function trackPageView(pathname) {
  if (readAnalyticsConsent() !== ANALYTICS_CONSENT.GRANTED) return false;
  return sendAnalyticsEvent('$pageview', { $current_url: sanitizeAnalyticsLocation(pathname) });
}

export async function trackProductEvent(eventName, params = {}) {
  if (!Object.hasOwn(EVENT_PARAMETER_SCHEMAS, eventName)) return false;
  if (readAnalyticsConsent() !== ANALYTICS_CONSENT.GRANTED) return false;
  return sendAnalyticsEvent(eventName, sanitizeProductEventParams(eventName, params));
}

function hostnameMatches(hostname, patterns) {
  return patterns.some(pattern => hostname === pattern || hostname.endsWith(`.${pattern}`) || hostname.includes(pattern));
}

export function inferAcquisitionChannel({
  referrer = globalThis.document?.referrer || '',
  location = globalThis.location,
} = {}) {
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

export async function trackAcquisition({
  storage = getSessionStorage(),
  referrer,
  location,
  track = trackProductEvent,
} = {}) {
  if (readAnalyticsConsent() !== ANALYTICS_CONSENT.GRANTED) return false;
  try {
    const persistedForSession = storage?.getItem(ANALYTICS_ACQUISITION_SESSION_KEY) === 'true';
    if (persistedForSession || (!storage && acquisitionTrackedInMemory)) return false;
    const tracked = await track('acquisition_view', {
      acquisition_channel: inferAcquisitionChannel({ referrer, location }),
      language: 'en',
    });
    if (!tracked) return false;
    acquisitionTrackedInMemory = true;
    storage?.setItem(ANALYTICS_ACQUISITION_SESSION_KEY, 'true');
    return true;
  } catch {
    return false;
  }
}

function resolveTimestamp(now) {
  const timestamp = typeof now === 'function' ? now() : now;
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

// Marks whose send is still waiting, in this tab. The first event of a page
// waits for PostHog to load, and a second call in that window would otherwise
// pass the stored check and send the mark twice: opening `/` asks on the way in
// and again after the redirect to `/feed`. Kept in memory, not in storage, so a
// tab closed mid-send leaves the mark unsent and the next visit tries again.
const marksInFlight = new Set();

export async function markActivation({ storage = getBrowserStorage(), now = Date.now, track = trackProductEvent } = {}) {
  if (readAnalyticsConsent(storage) !== ANALYTICS_CONSENT.GRANTED) return false;

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

export async function trackDay7Return({ storage = getBrowserStorage(), now = Date.now, track = trackProductEvent } = {}) {
  if (readAnalyticsConsent(storage) !== ANALYTICS_CONSENT.GRANTED) return false;

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
