import app, { ANALYTICS_MEASUREMENT_ID } from './firebase.js';

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
  'ai_explanation',
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
// them; `/report` is the legacy alias that redirects to `/research`, and it is
// listed so those arrivals read as the old link they came from rather than as
// noise. The test 'every route the app declares is a named analytics path'
// is what keeps this list from drifting behind the router again.
const STATIC_ANALYTICS_PATHS = new Set([
  '/',
  '/admin/moderation',
  '/following',
  '/lists',
  '/login',
  '/onboarding',
  '/profile',
  '/report',
  '/research',
  '/search',
  '/settings',
  '/settings/comments',
  '/settings/following',
  '/settings/profile',
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
  ai_action: new Set(['request', 'complete', 'error']),
  content_type: new Set(['paper', 'author', 'institution', 'project', 'topic', 'list', 'signup_cta', 'other']),
  destination: new Set(['publisher', 'pdf', 'doi', 'arxiv', 'other']),
  entity_type: new Set(['author', 'institution', 'project', 'topic']),
  entry_point: new Set(['home', 'login', 'onboarding', 'shared_link', 'other']),
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
  surface: new Set(['feed', 'following', 'lists', 'login', 'onboarding', 'research', 'search', 'settings', 'explorer', 'reader', 'auth_prompt', 'other']),
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
  ai_explanation: { action: 'ai_action', surface: 'surface' },
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
});

let analyticsInstance = null;
let analyticsModule = null;
let analyticsPromise = null;
let acquisitionTrackedInMemory = false;

function analyticsConsentPayload(value) {
  return {
    analytics_storage: value === ANALYTICS_CONSENT.GRANTED ? 'granted' : 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  };
}

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

export function readAnalyticsConsent(storage) {
  const targetStorage = storage === undefined ? getBrowserStorage() : storage;
  try {
    const value = targetStorage?.getItem(ANALYTICS_CONSENT_KEY);
    if (Object.values(ANALYTICS_CONSENT).includes(value)) return value;
  } catch {
    // The cookie below preserves the choice when browser storage is unavailable.
  }
  return storage === undefined ? readAnalyticsConsentCookie() : null;
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
  // The handle is the person, so it never leaves the browser: the route
  // collapses to a constant exactly like the id routes above.
  if (/^\/public\/user\/[^/]+$/.test(path)) return '/public/user/:handle';

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

async function getAnalyticsInstance() {
  if (!ANALYTICS_MEASUREMENT_ID || typeof window === 'undefined') return null;
  if (analyticsInstance) return analyticsInstance;
  if (analyticsPromise) return analyticsPromise;

  analyticsPromise = import('firebase/analytics')
    .then(async module => {
      analyticsModule = module;
      if (!(await module.isSupported())) return null;
      const currentConsent = readAnalyticsConsent();
      module.setConsent(analyticsConsentPayload(currentConsent));
      analyticsInstance = module.initializeAnalytics(app, {
        config: {
          send_page_view: false,
          allow_google_signals: false,
          allow_ad_personalization_signals: false,
        },
      });
      module.setAnalyticsCollectionEnabled(
        analyticsInstance,
        currentConsent === ANALYTICS_CONSENT.GRANTED,
      );
      return analyticsInstance;
    })
    .catch(() => null);

  return analyticsPromise;
}

function removeAnalyticsCookies() {
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

export async function setAnalyticsConsent(value) {
  if (!persistAnalyticsConsent(value)) return false;
  if (value === ANALYTICS_CONSENT.GRANTED) {
    const analytics = await getAnalyticsInstance();
    if (
      analytics
      && analyticsModule
      && readAnalyticsConsent() === ANALYTICS_CONSENT.GRANTED
    ) {
      analyticsModule.setConsent(analyticsConsentPayload(ANALYTICS_CONSENT.GRANTED));
      analyticsModule.setAnalyticsCollectionEnabled(analytics, true);
    }
    return true;
  }

  if (analyticsModule?.setConsent) {
    analyticsModule.setConsent(analyticsConsentPayload(ANALYTICS_CONSENT.DENIED));
  }
  if (analyticsInstance && analyticsModule) {
    analyticsModule.setAnalyticsCollectionEnabled(analyticsInstance, false);
  }
  clearConsentScopedAnalyticsState();
  removeAnalyticsCookies();
  return true;
}

export async function trackPageView(pathname) {
  if (readAnalyticsConsent() !== ANALYTICS_CONSENT.GRANTED) return false;
  const analytics = await getAnalyticsInstance();
  if (
    !analytics
    || !analyticsModule
    || readAnalyticsConsent() !== ANALYTICS_CONSENT.GRANTED
  ) return false;

  const pagePath = normalizeAnalyticsPath(pathname);
  analyticsModule.logEvent(analytics, 'page_view', {
    page_path: pagePath,
    page_location: sanitizeAnalyticsLocation(pagePath),
    page_title: 'PaperTok',
  });
  return true;
}

export async function trackProductEvent(eventName, params = {}) {
  if (!Object.hasOwn(EVENT_PARAMETER_SCHEMAS, eventName)) return false;
  if (readAnalyticsConsent() !== ANALYTICS_CONSENT.GRANTED) return false;
  const analytics = await getAnalyticsInstance();
  if (
    !analytics
    || !analyticsModule
    || readAnalyticsConsent() !== ANALYTICS_CONSENT.GRANTED
  ) return false;

  analyticsModule.logEvent(analytics, eventName, sanitizeProductEventParams(eventName, params));
  return true;
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
  language,
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
      language: language === 'en' ? 'en' : 'es',
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

export async function markActivation({ storage = getBrowserStorage(), now = Date.now, track = trackProductEvent } = {}) {
  if (readAnalyticsConsent(storage) !== ANALYTICS_CONSENT.GRANTED) return false;

  try {
    if (storage?.getItem(ANALYTICS_ACTIVATION_EVENT_KEY) === 'true') return false;
    const timestamp = resolveTimestamp(now);
    const tracked = await track('activation');
    if (!tracked) return false;
    storage?.setItem(ANALYTICS_ACTIVATION_KEY, String(timestamp));
    storage?.setItem(ANALYTICS_ACTIVATION_EVENT_KEY, 'true');
    return true;
  } catch {
    return false;
  }
}

export async function trackDay7Return({ storage = getBrowserStorage(), now = Date.now, track = trackProductEvent } = {}) {
  if (readAnalyticsConsent(storage) !== ANALYTICS_CONSENT.GRANTED) return false;

  try {
    if (storage?.getItem(ANALYTICS_DAY_7_KEY) === 'true') return false;
    const activatedAt = Number(storage?.getItem(ANALYTICS_ACTIVATION_KEY));
    if (!Number.isFinite(activatedAt) || activatedAt <= 0) return false;
    if (resolveTimestamp(now) - activatedAt < DAY_7_MS) return false;
    const tracked = await track('day_7_return');
    if (!tracked) return false;
    storage?.setItem(ANALYTICS_DAY_7_KEY, 'true');
    return true;
  } catch {
    return false;
  }
}
