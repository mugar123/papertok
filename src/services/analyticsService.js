import app, { ANALYTICS_MEASUREMENT_ID } from './firebase.js';

export const ANALYTICS_CONSENT_KEY = 'papertok_analytics_consent';
export const ANALYTICS_CONSENT = Object.freeze({
  GRANTED: 'granted',
  DENIED: 'denied',
});

let analyticsInstance = null;
let analyticsModule = null;
let analyticsPromise = null;

export function readAnalyticsConsent(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(ANALYTICS_CONSENT_KEY);
    return Object.values(ANALYTICS_CONSENT).includes(value) ? value : null;
  } catch {
    return null;
  }
}

export function persistAnalyticsConsent(value, storage = globalThis.localStorage) {
  if (!Object.values(ANALYTICS_CONSENT).includes(value)) return false;
  try {
    storage?.setItem(ANALYTICS_CONSENT_KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function normalizeAnalyticsPath(pathname = '/') {
  const path = pathname.split('?')[0].replace(/\/+$/, '') || '/';
  if (path.startsWith('/explorer/')) {
    const [, explorer, type] = path.split('/');
    return `/${explorer}/${type || 'entity'}/:id`;
  }
  return path;
}

async function getAnalyticsInstance() {
  if (!ANALYTICS_MEASUREMENT_ID || typeof window === 'undefined') return null;
  if (analyticsInstance) return analyticsInstance;
  if (analyticsPromise) return analyticsPromise;

  analyticsPromise = import('firebase/analytics')
    .then(async module => {
      analyticsModule = module;
      if (!(await module.isSupported())) return null;
      analyticsInstance = module.initializeAnalytics(app, {
        config: { send_page_view: false },
      });
      module.setAnalyticsCollectionEnabled(analyticsInstance, true);
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
    document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
  });
}

export async function setAnalyticsConsent(value) {
  if (!persistAnalyticsConsent(value)) return false;
  if (value === ANALYTICS_CONSENT.GRANTED) {
    const analytics = await getAnalyticsInstance();
    if (analytics && analyticsModule) {
      analyticsModule.setAnalyticsCollectionEnabled(analytics, true);
    }
    return Boolean(analytics);
  }

  if (analyticsInstance && analyticsModule) {
    analyticsModule.setAnalyticsCollectionEnabled(analyticsInstance, false);
  }
  removeAnalyticsCookies();
  return false;
}

export async function trackPageView(pathname) {
  if (readAnalyticsConsent() !== ANALYTICS_CONSENT.GRANTED) return false;
  const analytics = await getAnalyticsInstance();
  if (!analytics || !analyticsModule) return false;

  const pagePath = normalizeAnalyticsPath(pathname);
  analyticsModule.logEvent(analytics, 'page_view', {
    page_path: pagePath,
    page_location: `${window.location.origin}${window.location.pathname}#${pagePath}`,
    page_title: 'PaperTok',
  });
  return true;
}
