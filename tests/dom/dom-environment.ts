import { JSDOM } from 'jsdom';

/**
 * A browser for React under `node --test`, installed by importing this module.
 * It must run before `react-dom` and `@testing-library/react` are imported: both
 * read `window` and `document` when they load, so the helper that imports them
 * imports this module first.
 *
 * Each test file runs in its own process, so the globals never reach another file.
 */
const BROWSER_GLOBALS = [
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'SVGElement',
  'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'StorageEvent', 'MutationObserver',
  'DocumentFragment', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
] as const;

function installDom(url: string) {
  const { window } = new JSDOM('<!doctype html><html><body></body></html>', { url, pretendToBeVisual: true });
  for (const name of BROWSER_GLOBALS) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: (window as unknown as Record<string, unknown>)[name] });
  }
  // A phone-sized, motion-free screen, with the observers a browser has and jsdom lacks.
  const observer = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  Object.assign(globalThis, { IntersectionObserver: observer, ResizeObserver: observer });
  window.matchMedia = (query: string) => ({
    matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
  window.scrollTo = () => {};
  Object.assign(window.HTMLElement.prototype, { scrollTo() {}, scrollIntoView() {} });
  return window;
}

// Not papertok.app, where the app starts its browser analytics.
installDom('http://localhost/feed');
