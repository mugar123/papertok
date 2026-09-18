/**
 * What a tap on the tab bar receives on the phone, and what follows.
 *
 * "The tabs need several taps on the phone" (2026-09-05, again 2026-09-18)
 * is a bug no emulated touch reproduces: Chromium and WebKit, phone
 * emulation, real touch dispatch, every tap clicks and navigates within
 * milliseconds. The one place it exists is the user's iPhone, so this is the
 * instrument that runs there: every touch, pointer, mouse and click event
 * that reaches the bar, logged in the capture phase before anything can
 * cancel it, with what the browser thinks is under the finger; the history
 * pushes, the hash, scrolls in flight, the visual viewport, and a look at the
 * route 300, 1000 and 2500 ms after each click. A panel at the bottom shows
 * the record and copies or shares it.
 *
 * Loaded only behind `?tapdiag=1` (main.jsx), remembered in sessionStorage
 * across the app's own reloads, and `?tapdiag=0` turns it off. Plain DOM and
 * no React on purpose: it has to keep recording whatever the app's render
 * pipeline is doing at the time.
 */

const CAP = 260;
const NAV_EVENTS = ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'contextmenu'];
const log = [];
let started = false;
let panel = null;
let body = null;
let count = null;
let collapsed = false;
let lastFeedScrollAt = -1;
let lastScrollLogAt = new Map();
let touchMoves = 0;
let touchStart = null;

const now = () => Math.round(performance.now());
const num = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : v);

function desc(el) {
  if (!el) return 'null';
  if (el === document) return 'document';
  if (el === window) return 'window';
  if (!el.tagName) return String(el.nodeName || el);
  const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '';
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 14);
  return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}${text ? `[${text}]` : ''}`;
}

function render() {
  if (!body) return;
  body.textContent = log.join('\n');
  if (count) count.textContent = String(log.length);
  if (!collapsed) body.scrollTop = body.scrollHeight;
}

function push(line) {
  log.push(`+${now()} ${line}`);
  if (log.length > CAP) log.shift();
  render();
}

function navbar() {
  return document.querySelector('.navbar');
}

function activeTab() {
  const link = document.querySelector('.navbar-link.active');
  return link ? (link.textContent || '').trim() : '-';
}

function snapshot() {
  const bar = navbar();
  const feed = document.querySelector('.feed-container');
  const vv = window.visualViewport;
  const modal = document.querySelector('[aria-modal="true"]');
  const pages = [...document.querySelectorAll('.page-transition')].map((p) => p.getAttribute('data-page-motion') || 'still');
  return [
    `hash=${location.hash}`,
    `tab=${activeTab()}`,
    `bar=${bar ? `${num(bar.getBoundingClientRect().top, 1)}..${num(bar.getBoundingClientRect().bottom, 1)} pad=${getComputedStyle(bar).paddingTop}` : 'none'}`,
    `vv=${vv ? `scale ${num(vv.scale, 3)} off ${num(vv.offsetTop, 1)} h ${num(vv.height, 1)}` : 'n/a'}`,
    `win=${window.innerWidth}x${window.innerHeight} y=${num(window.scrollY, 1)}`,
    `feed=${feed ? `top ${num(feed.scrollTop, 1)} lastScroll ${lastFeedScrollAt < 0 ? 'never' : (now() - lastFeedScrollAt) + 'ms ago'}` : 'none'}`,
    `pages=${pages.join('|') || 'none'}`,
    `modal=${modal ? desc(modal) : 'no'}`,
    `focus=${desc(document.activeElement)}`,
    `hidden=${document.hidden}`,
  ].join(' ');
}

function point(event) {
  const p = event.changedTouches ? event.changedTouches[0] : event;
  if (!p || typeof p.clientX !== 'number') return null;
  return { x: Math.round(p.clientX), y: Math.round(p.clientY) };
}

function underFinger(pt) {
  if (!pt) return '-';
  try {
    return desc(document.elementFromPoint(pt.x, pt.y));
  } catch {
    return '?';
  }
}

function onNavEvent(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('#tapdiag')) return;
  const inBar = Boolean(target.closest('.navbar'));
  const isCancel = event.type === 'touchcancel' || event.type === 'pointercancel';
  if (!inBar && !isCancel) return;
  const pt = point(event);
  if (event.type === 'touchmove') {
    touchMoves += 1;
    if (touchMoves > 1) return;
  }
  if (event.type === 'touchstart') {
    touchMoves = 0;
    touchStart = pt;
    push(`── touchstart ${desc(target)} @${pt ? `${pt.x},${pt.y}` : '?'} touches=${event.touches ? event.touches.length : '?'} under=${underFinger(pt)}`);
    push(`   snap ${snapshot()}`);
    return;
  }
  const moved = event.type === 'touchend' && touchStart && pt ? ` moved=${Math.abs(pt.x - touchStart.x)},${Math.abs(pt.y - touchStart.y)} moves=${touchMoves}` : '';
  const which = event.type === 'pointerdown' || event.type === 'pointerup' ? ` ptr=${event.pointerType}${event.isPrimary === false ? ' secondary' : ''} btn=${event.button}` : '';
  push(`   ${event.type} ${desc(target)} @${pt ? `${pt.x},${pt.y}` : '?'}${which}${moved}${event.defaultPrevented ? ' PREVENTED' : ''}${event.cancelable === false ? ' uncancelable' : ''}`);
  if (event.type === 'click' && inBar) {
    const href = target.closest('a')?.getAttribute('href') || '';
    push(`   click→ href=${href || '-'} hashBefore=${location.hash}`);
    for (const ms of [300, 1000, 2500]) {
      setTimeout(() => push(`   after+${ms} ${snapshot()}`), ms);
    }
  }
}

function wrapHistory() {
  const wrap = (name) => {
    const original = history[name].bind(history);
    history[name] = (state, title, url) => {
      push(`history.${name} → ${url}`);
      return original(state, title, url);
    };
  };
  wrap('pushState');
  wrap('replaceState');
}

function onScroll(event) {
  const target = event.target === document ? document : event.target;
  const isFeed = target instanceof Element && target.classList.contains('feed-container');
  if (isFeed) lastFeedScrollAt = now();
  const key = target === document ? 'document' : desc(target).slice(0, 40);
  const last = lastScrollLogAt.get(key) || -1000;
  if (now() - last < 150) return;
  lastScrollLogAt.set(key, now());
  const top = target === document ? window.scrollY : target.scrollTop;
  push(`scroll ${key} top=${num(top, 1)}`);
}

function header() {
  const script = document.querySelector('script[src*="/assets/index-"]');
  const build = script ? script.getAttribute('src').replace(/.*\/assets\//, '') : 'dev';
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  return [
    `PaperTok tap diag ${new Date().toISOString()}`,
    `ua=${navigator.userAgent}`,
    `build=${build} standalone=${standalone} dpr=${window.devicePixelRatio} win=${window.innerWidth}x${window.innerHeight} coarse=${window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : '?'} touchPoints=${navigator.maxTouchPoints}`,
  ];
}

function exportText() {
  return [...header(), ...log].join('\n');
}

async function copy() {
  const text = exportText();
  try {
    await navigator.clipboard.writeText(text);
    push('copied to clipboard');
    return;
  } catch {
    // iOS without a secure context, or a denied clipboard: select and copy by hand.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  push(ok ? 'copied to clipboard (fallback)' : 'copy failed: long-press the log to select it');
}

async function share() {
  const text = exportText();
  if (!navigator.share) { push('share not available here; use Copy'); return; }
  try {
    await navigator.share({ title: 'PaperTok tap diag', text });
    push('shared');
  } catch (error) {
    push(`share cancelled: ${error && error.name}`);
  }
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.style.cssText = 'min-height:34px;min-width:52px;padding:0 10px;border:1px solid #666;border-radius:8px;background:#2a2a30;color:#fff;font:600 12px system-ui;touch-action:manipulation';
  b.addEventListener('click', onClick);
  return b;
}

function mountPanel() {
  panel = document.createElement('div');
  panel.id = 'tapdiag';
  panel.setAttribute('aria-hidden', 'true');
  panel.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-height:36vh;display:flex;flex-direction:column;background:rgba(18,18,22,.95);color:#e8e8ec;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;padding-bottom:env(safe-area-inset-bottom,0);box-shadow:0 -2px 12px rgba(0,0,0,.4)';
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #444;flex:none;flex-wrap:wrap';
  const title = document.createElement('strong');
  title.textContent = 'tap diag';
  count = document.createElement('span');
  count.style.cssText = 'opacity:.7;margin-right:auto';
  body = document.createElement('pre');
  body.style.cssText = 'margin:0;padding:6px 8px;overflow:auto;white-space:pre-wrap;word-break:break-word;flex:1 1 auto;-webkit-user-select:text;user-select:text';
  const hide = button('Hide', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    hide.textContent = collapsed ? 'Show' : 'Hide';
  });
  bar.append(title, count, button('Copy', copy), button('Share', share), button('Clear', () => { log.length = 0; render(); }), hide);
  panel.append(bar, body);
  document.body.appendChild(panel);
}

export function start() {
  if (started || typeof document === 'undefined') return;
  started = true;
  const mount = () => {
    mountPanel();
    for (const line of header()) log.push(line);
    render();
  };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });

  for (const type of NAV_EVENTS) document.addEventListener(type, onNavEvent, { capture: true, passive: true });
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  wrapHistory();
  window.addEventListener('hashchange', () => push(`hashchange → ${location.hash}`));
  window.addEventListener('popstate', () => push(`popstate hash=${location.hash}`));
  window.addEventListener('pageshow', (e) => push(`pageshow persisted=${e.persisted}`));
  window.addEventListener('pagehide', () => push('pagehide'));
  document.addEventListener('visibilitychange', () => push(`visibility ${document.visibilityState}`));
  window.addEventListener('vite:preloadError', () => push('vite:preloadError (a chunk failed; the app may reload)'));
  window.addEventListener('error', (e) => push(`error ${String(e.message).slice(0, 120)}`));
  window.addEventListener('unhandledrejection', (e) => push(`rejection ${String(e.reason && (e.reason.message || e.reason)).slice(0, 120)}`));
  window.addEventListener('orientationchange', () => push(`orientation ${window.innerWidth}x${window.innerHeight}`));
  const vv = window.visualViewport;
  if (vv) {
    let last = '';
    const onViewport = () => {
      const key = `${num(vv.scale, 3)}/${num(vv.offsetTop, 1)}/${num(vv.height, 1)}`;
      if (key === last) return;
      last = key;
      push(`viewport scale=${num(vv.scale, 3)} off=${num(vv.offsetTop, 1)} h=${num(vv.height, 1)} inset-top=${navbar() ? getComputedStyle(navbar()).paddingTop : '?'}`);
    };
    vv.addEventListener('resize', onViewport);
    vv.addEventListener('scroll', onViewport);
  }
  push(`started hash=${location.hash}`);
}
