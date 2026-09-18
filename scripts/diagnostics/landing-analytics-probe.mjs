// What actually leaves the browser for Vercel Web Analytics while a reader is
// on a page that names something of theirs — a paper, an author, a list, a
// handle, a search query. The policy published at /privacy.html says:
//
//   "The only thing sent is page views, with the path stripped of identifiers:
//    reading a specific paper is recorded as /public/paper/:id, and visiting an
//    author's profile as /explorer/author/:id. Which one never travels. Neither
//    do your searches or anything from your account."
//
// That is a promise about a request, so it is checked on a request, in a real
// browser, and not on `sanitizeAnalyticsEventUrl` in isolation (which
// src/services/analyticsService.test.js already does).
//
//   node scripts/diagnostics/landing-analytics-probe.mjs [base-url]
//
// Base URL defaults to http://localhost:4173 — the LOCAL `vite preview` of the
// built `dist/`, never the deployment. The point is to read our own outgoing
// request, not to put probe traffic in the real property. Nothing in this file
// may be pointed at papertok.app: the request is intercepted and answered by
// the probe itself (`Fetch.fulfillRequest`), so it never reaches any network.
//
// Same no-dependency CDP harness as landing-axe.mjs: spawn Chrome, resolve the
// binary per platform, start our own `vite preview` if nothing answers at the
// port, and refuse to report on a page that did not really load. Added here:
// `Network.enable` (the record of what was requested) and `Fetch.enable` (the
// substitute transport and the guarantee nothing is delivered anywhere).
//
// ── How analytics is made to fire in a local build ──────────────────────────
//
// Nothing about the app is changed, and no flag is flipped. Consent is granted
// by default since 2026-09-17 (`readAnalyticsConsent`, empty store = granted),
// and a throwaway Chrome profile has an empty store, so `<Analytics />` mounts
// and `AnalyticsProvider` calls `pageview()` exactly as it does in production.
// What is missing locally is the transport: `@vercel/analytics` builds its
// script URL as `/_vercel/insights/script.js` (dist/index.mjs, `getScriptSrc`),
// which only Vercel's edge serves — `vite preview` answers 404, the script
// never runs, and the queued events sit in `window.vaq` forever.
//
// So the probe SERVES that script itself, fulfilling the request with the
// stand-in below. The stand-in reproduces the real script's contract with the
// page, which is the whole of what the app can influence:
//
//   - `window.va` is a queue stub until the script loads (`initQueue`), so the
//     stand-in drains `window.vaq` and then replaces `window.va`;
//   - `inject()` registers `beforeSend` through that same queue, so the
//     stand-in holds it and applies it to every event;
//   - the event handed to `beforeSend` carries `url: location.href` — that is
//     the field this whole task is about, and it is built here exactly as the
//     real script builds it, from the live address bar;
//   - what is POSTed is the event AS `beforeSend` RETURNED IT, plus the
//     referrer. Deliberately a superset: the real payload is a handful of short
//     keys built out of those same values, so an identifier absent from the
//     whole event object and the referrer cannot be present in it.
//
// What this does NOT prove, stated plainly: that Vercel's own script adds no
// field of its own from page state after `beforeSend` returns. Proving that
// would mean executing their script, which means fetching it from their CDN —
// exactly the thing this probe refuses to do. Everything the APP hands the
// transport is measured here, and that is the surface the app owns.
//
// ── What makes a run a pass ─────────────────────────────────────────────────
//
// Both directions, because only one of them is a proof:
//
//   - no scene's identifier appears in a captured request — not in the URL, not
//     in a header (the `Referer` included: a subresource request carries the
//     full address of the page that asked for it), not in the body, raw or
//     percent-encoded;
//   - AND at least one analytics request was captured per scene, and every
//     captured page-view URL is one of the normalized paths that scene is
//     allowed to report. A run that sends nothing proves nothing, so zero
//     captured requests is a LOUD failure, not a quiet pass.
//
// PORT=<n> picks another debugging port, CHROME=<path> another Chromium binary
// — same env convention as this directory's other CDP scripts.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Is this path a file we are allowed to execute? */
function runnable(candidate) {
  try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
}

/** The browser to drive. CHROME= wins, then the platform's usual install
 * paths, then a PATH scan — landing-axe.mjs's own resolution, for the same
 * reason: /Applications does not exist on Linux CI. */
function resolveChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const fixed = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
       '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  for (const candidate of fixed) if (runnable(candidate)) return candidate;

  const named = process.platform === 'darwin'
    ? ['Google Chrome', 'Chromium']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const name of named) {
      const candidate = join(dir, name);
      if (runnable(candidate)) return candidate;
    }
  }

  console.error('landing-analytics-probe: no Chrome or Chromium found. Install one, or point CHROME= at the binary.');
  console.error(`  looked at: ${fixed.join(', ')} and ${named.join('/')} on PATH`);
  process.exit(1);
}

const CHROME = resolveChrome();
const PLATFORM_FLAGS = process.platform === 'darwin' ? [] : ['--no-sandbox', '--disable-dev-shm-usage'];
const PORT = Number(process.env.PORT || 9243);
const PROFILE = join(tmpdir(), `papertok-analytics-probe-${process.pid}`);
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = (process.argv[2] || 'http://localhost:4173').replace(/\/+$/, '');
const ORIGIN = new URL(BASE).origin;
if (!/^https?:$/.test(new URL(BASE).protocol) || !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(BASE).hostname)) {
  // Not a style rule. Pointed at the deployment, a "probe" would be indistinguishable
  // from a reader, and every scene below would put a synthetic page view in the real
  // property — while measuring Vercel's edge instead of this build.
  console.error(`landing-analytics-probe: ${BASE} is not a local preview. This probe reads OUR OWN outgoing`);
  console.error('  request; it must never send events to the real property. Use http://localhost:4173.');
  process.exit(1);
}

// The identifier in each address, and everything it could travel as. A real
// OpenAlex work for the paper (b3BlbmFsZXg6VzI3NDE4MDk4MDc is the base64url
// paper key `getPublicPaperPath` mints for `openalex:W2741809807`, so both the
// key in the URL and the id inside it are looked for); distinctive synthetic
// tokens elsewhere, so a substring hit can only be a real leak and never the
// word "nicolas" occurring somewhere in the bundle.
const PAPER_KEY = 'b3BlbmFsZXg6VzI3NDE4MDk4MDc';
const SCENES = [
  {
    label: 'a paper',
    path: `/public/paper/${PAPER_KEY}`,
    secrets: [PAPER_KEY, 'W2741809807', 'openalex:W2741809807'],
    allowed: ['/public/paper/:id'],
  },
  {
    // Carries a query on purpose. /search below is the real search route, but
    // signed out it is bounced before its page view is emitted, so this is the
    // scene where a view actually fires with a query in the address bar —
    // `?name=` is what `getPublicEntityPath` puts there for a shared entity.
    label: 'an author, with a name in the query',
    path: '/explorer/author/A5023888391?name=Ada%20probe7k2name',
    secrets: ['A5023888391', 'probe7k2name'],
    allowed: ['/explorer/author/:id'],
  },
  {
    label: 'a shared list',
    path: '/public/list/probe7k2list9f3a2b',
    secrets: ['probe7k2list9f3a2b'],
    allowed: ['/public/list/:id'],
  },
  {
    // A handle is a person, not an opaque id: it is the one route segment that
    // is readable on sight, which is why it collapses to `:handle` like the rest.
    label: 'a profile handle',
    path: '/public/user/probe7k2handle',
    secrets: ['probe7k2handle'],
    allowed: ['/public/user/:handle'],
  },
  {
    // What someone typed. Signed out, ProtectedRoute bounces /search to /feed
    // carrying `returnTo` in HISTORY STATE (which goes nowhere), so a second
    // page view for /feed is expected and allowed — neither may carry the query.
    label: 'a search query',
    path: '/search?q=probe7k2query',
    secrets: ['probe7k2query'],
    allowed: ['/search', '/feed'],
  },
];

// The substitute for /_vercel/insights/script.js. See the header: it reproduces
// the contract the real script has with the page and posts a SUPERSET of the
// real payload, so that "the identifier is in none of this" is the stronger
// statement, not the weaker one.
const INSIGHTS_STANDIN = `(function () {
  var data = (document.currentScript && document.currentScript.dataset) || {};
  var viewEndpoint = data.viewEndpoint || '/_vercel/insights/view';
  var eventEndpoint = data.eventEndpoint || '/_vercel/insights/event';
  var beforeSend = null;
  var record = (window.__papertokAnalyticsProbe = { queue: [], sent: [], dropped: [] });

  function handle(kind, value) {
    record.queue.push([kind, value === undefined ? null : value]);
    if (kind === 'beforeSend') { beforeSend = value; return; }

    // \`url: location.href\` is the real script's own behaviour and the reason
    // this file exists: the live address bar carries the identifier.
    var event = kind === 'pageview'
      ? { type: 'pageview', url: location.href, route: value && value.route, path: value && value.path }
      : { type: 'event', url: location.href, name: value && value.name, data: value && value.data };
    if (typeof beforeSend === 'function') {
      event = beforeSend(event);
      if (!event) { record.dropped.push(kind); return; }
    }

    var payload = {
      o: event.url,
      r: document.referrer,
      p: event.path,
      ru: event.route,
      sdkn: data.sdkn,
      sdkv: data.sdkv,
      ts: Date.now(),
      event: event,
    };
    record.sent.push({ endpoint: kind === 'pageview' ? viewEndpoint : eventEndpoint, payload: payload });
    try {
      fetch(kind === 'pageview' ? viewEndpoint : eventEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {});
    } catch (error) { /* the probe answers this request itself */ }
  }

  var queued = window.vaq || [];
  window.vaq = [];
  window.va = function () { handle(arguments[0], arguments[1]); };
  for (var i = 0; i < queued.length; i++) handle(queued[i][0], queued[i][1]);
})();
`;

/** Starts our own `vite preview` for `url`'s port if nothing answers there yet;
 * returns the child to kill in `finally`, or null if a server was already up
 * (left running — it is not ours). landing-axe.mjs's own helper. */
async function ensurePreviewServer(target) {
  try {
    await fetch(target);
    return null;
  } catch { /* nothing there — start our own */ }

  const { port } = new URL(target);
  console.log(`no server answering at ${target} — starting "vite preview --port ${port}" from ${REPO_ROOT}dist`);
  // The vite binary directly, not `npx vite`: npx interposes a process that
  // does not reliably pass a kill on to the vite child underneath.
  const proc = spawn(join(REPO_ROOT, 'node_modules', '.bin', 'vite'), ['preview', '--port', port || '4173', '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
  // "localhost", not 127.0.0.1: `vite preview` binds IPv6 loopback only.
  for (let i = 0; i < 150; i++) {
    try { await fetch(`http://localhost:${port || '4173'}/`); return proc; } catch { /* still starting */ }
    await sleep(200);
  }
  proc.kill('SIGKILL');
  throw new Error(`our own "vite preview --port ${port}" never came up in time`);
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (!p) return;
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
        return;
      }
      for (const fn of this.handlers.get(m.method) || []) fn(m.params);
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  /** Runs `expression`, awaits it if it is a promise, returns the JSON value. */
  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

async function pageTarget() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('no page target');
}

const isInsights = (url) => url.includes('/_vercel/insights/');
const isInsightsScript = (url) => /\/_vercel\/insights\/script\.js(\?|$)/.test(url);

/** Every form an identifier could wear inside a URL, a header or a JSON body. */
function leakForms(secret) {
  const forms = new Set([secret, encodeURIComponent(secret), encodeURIComponent(secret).replace(/%2F/gi, '/')]);
  return [...forms].map((form) => form.toLowerCase()).filter(Boolean);
}

async function runScene(cdp, scene) {
  const url = `${ORIGIN}${scene.path}`;
  const captured = [];   // Network.requestWillBeSent — the record of what was requested
  const paused = [];     // Fetch.requestPaused — the same requests, with their bodies, held at the wire

  const offNetwork = (params) => {
    if (!isInsights(params.request.url)) return;
    captured.push({
      source: 'Network.requestWillBeSent',
      method: params.request.method,
      url: params.request.url,
      headers: params.request.headers || {},
      postData: params.request.postData || (params.request.hasPostData ? '<not inlined>' : ''),
    });
  };
  const offFetch = (params) => {
    if (!isInsights(params.request.url)) return;
    paused.push({
      source: 'Fetch.requestPaused',
      method: params.request.method,
      url: params.request.url,
      headers: params.request.headers || {},
      postData: params.request.postData || '',
    });
  };
  cdp.on('Network.requestWillBeSent', offNetwork);
  cdp.on('Fetch.requestPaused', offFetch);

  const nav = await cdp.send('Page.navigate', { url });
  if (nav.errorText) {
    throw new Error(`[${scene.label}] Page.navigate failed: ${nav.errorText} — is anything serving ${url}?`);
  }

  // Wait for the app to boot, the stand-in to be served and a page view to be
  // handed to it. Polled rather than slept: a fixed sleep either wastes seconds
  // or, worse, gives up before the first view and calls that a clean run.
  let state = null;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    state = await cdp.evaluate(`(() => {
      const probe = window.__papertokAnalyticsProbe;
      return {
        hasApp: !!document.getElementById('main-content'),
        title: document.title,
        bodySnippet: (document.body && document.body.innerText || '').slice(0, 120),
        transportLoaded: !!probe,
        queue: probe ? probe.queue : [],
        sent: probe ? probe.sent : [],
        dropped: probe ? probe.dropped : [],
        href: location.href,
        // Why the transport did not run, when it does not: whether <Analytics />
        // asked for the script at all (the tag), whether the queue stub exists
        // (inject() ran), and what consent reads as (an opt-out unmounts it).
        injectedTag: !!document.querySelector('script[src*="/_vercel/insights/"]'),
        queueStub: typeof window.va,
        pendingQueue: window.vaq ? window.vaq.length : null,
        storedConsent: (() => { try { return localStorage.getItem('papertok_analytics_consent'); } catch { return '<unreadable>'; } })(),
        consentCookie: document.cookie,
      };
    })()`, false);
    if (state.transportLoaded && state.sent.length) break;
  }

  // A page that never really loaded reads as "nothing leaked" — the same
  // failure landing-axe.mjs had to close. Say so instead.
  if (!state.hasApp) {
    throw new Error(
      `[${scene.label}] loaded a page with no #main-content — this is not the app. `
      + `title=${JSON.stringify(state.title)} body starts with ${JSON.stringify(state.bodySnippet)}.`,
    );
  }
  if (!state.transportLoaded) {
    throw new Error(
      `[${scene.label}] the analytics transport never ran, so this probe measures nothing. `
      + `at ${state.href}: script tag injected=${state.injectedTag}, window.va=${state.queueStub}, `
      + `window.vaq length=${state.pendingQueue}, stored consent=${JSON.stringify(state.storedConsent)}, `
      + `cookies=${JSON.stringify(state.consentCookie)}. `
      + `A missing tag means <Analytics /> never mounted (consent, or the component); a tag with no `
      + `stand-in means the request was answered from somewhere other than this probe. `
      + `captured=${JSON.stringify(captured.map((h) => `${h.method} ${h.url}`))} `
      + `paused=${JSON.stringify(paused.map((h) => `${h.method} ${h.url}`))}`,
    );
  }

  // Give any in-flight POST a moment to reach the wire before we stop listening.
  await sleep(400);
  cdp.handlers.set('Network.requestWillBeSent', (cdp.handlers.get('Network.requestWillBeSent') || []).filter((fn) => fn !== offNetwork));
  cdp.handlers.set('Fetch.requestPaused', (cdp.handlers.get('Fetch.requestPaused') || []).filter((fn) => fn !== offFetch));

  const all = [...captured, ...paused];
  const posts = all.filter((hit) => !isInsightsScript(hit.url));

  console.log(`\n=== ${scene.label} — ${scene.path} ===`);
  console.log(`  address in the browser: ${state.href}`);
  console.log(`  handed to the transport (window.vaq, drained): ${JSON.stringify(state.queue.map(([kind, value]) => [kind, typeof value === 'function' ? '<beforeSend fn>' : value]))}`);
  if (state.dropped.length) console.log(`  dropped by beforeSend: ${state.dropped.join(', ')}`);
  for (const hit of all) {
    console.log(`  --- ${hit.source} ---`);
    console.log(`  ${hit.method} ${hit.url}`);
    console.log(`  headers: ${JSON.stringify(hit.headers)}`);
    console.log(`  body: ${hit.postData || '(none)'}`);
  }

  let failures = 0;

  // ── The proof must have a subject. Zero requests is a failure. ──
  if (!posts.length) {
    console.log('  [FAIL] no analytics request was captured at all — this scene proves nothing.');
    failures += 1;
  }

  // ── Nothing of the reader's may appear anywhere in any of it. ──
  for (const hit of all) {
    const haystack = `${hit.url}\n${JSON.stringify(hit.headers)}\n${hit.postData}`.toLowerCase();
    for (const secret of scene.secrets) {
      for (const form of leakForms(secret)) {
        if (haystack.includes(form)) {
          console.log(`  [FAIL] ${JSON.stringify(secret)} (as ${JSON.stringify(form)}) is in this ${hit.method} ${hit.url}`);
          failures += 1;
        }
      }
    }
  }

  // ── And the right thing must be what travelled, not merely "not the id". ──
  const allowedUrls = scene.allowed.map((path) => `${ORIGIN}${path}`);
  for (const hit of posts) {
    let reported = null;
    try { reported = JSON.parse(hit.postData || '{}').o ?? null; } catch { reported = null; }
    if (reported === null) {
      console.log(`  [FAIL] ${hit.method} ${hit.url} carried no readable page URL to check.`);
      failures += 1;
    } else if (!allowedUrls.includes(reported)) {
      console.log(`  [FAIL] reported page ${JSON.stringify(reported)} is not one of ${JSON.stringify(allowedUrls)}`);
      failures += 1;
    } else {
      console.log(`  [ok] reported page: ${reported}`);
    }
  }

  // ── And the Referer, which is the half `beforeSend` cannot reach. ──
  // A same-origin subresource request carries the FULL page URL in this header
  // under the browser default, so the app's own insights script announced the
  // paper key to the edge on every view. Under HashRouter that was safe for
  // free (a fragment is stripped from `Referer`); real paths put the id back
  // in it. `app.html`'s `<meta name="referrer" content="strict-origin">` is
  // what cuts it to the origin — and this is the assertion that keeps it
  // there. Measured by mutation: with the meta taken out of the built page,
  // this header came back reading
  // `/public/paper/b3BlbmFsZXg6VzI3NDE4MDk4MDc`, and also the author's id AND
  // their name from the query string.
  for (const hit of all) {
    const referer = hit.headers?.Referer || hit.headers?.referer;
    if (!referer) continue;
    let path = null;
    try { path = new URL(referer).pathname + new URL(referer).search; } catch { path = referer; }
    if (path !== '/') {
      console.log(`  [FAIL] the Referer of this ${hit.method} ${hit.url} carries ${JSON.stringify(path)}, not just the origin`);
      failures += 1;
    }
  }

  if (!failures) console.log(`  PASS — ${posts.length} analytics request(s), none carrying ${scene.secrets.map((s) => JSON.stringify(s)).join(' / ')}, none with a path in Referer`);
  return failures;
}

mkdirSync(PROFILE, { recursive: true });
console.log(`chrome: ${CHROME}`);
console.log(`base:   ${BASE}`);
const chrome = spawn(CHROME, ['--headless=new', ...PLATFORM_FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let ownServer = null;
let failures = 0;

try {
  // Inside the try: if the preview server fails to start, `chrome` still needs
  // the `finally` below.
  ownServer = await ensurePreviewServer(`${ORIGIN}/`);
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  // Every scene must ask the network the same question. A cached
  // /_vercel/insights/script.js (or app chunk) would make the second scene
  // measure the first scene's answer, and a cache hit raises no
  // `Fetch.requestPaused` at all -- the transport would silently never load.
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
    const text = (args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (/vercel|analytics|error/i.test(text)) console.log(`  [console.${type}] ${text}`);
  });

  // The app's own service worker has to be stepped around, and the reason is
  // worth writing down because it cost a debugging session: the worker registers
  // on the FIRST scene and takes control from the SECOND on, and from then on
  // every request the page makes is re-issued from the worker's own target,
  // which a page-level `Fetch` interception cannot see. The symptom is not an
  // error — `Network.requestWillBeSent` still reports the request, nothing
  // pauses, the stand-in is never served, and the scene reports "no analytics
  // request" for a page where analytics was working fine. Bypassing it is not a
  // change of subject: the analytics paths are excluded from the precache
  // anyway (src/utils/spaDeploy.test.js), so the worker only ever passed them
  // through to the network.
  await cdp.send('Network.setBypassServiceWorker', { bypass: true });

  // One interception point, two jobs. `/_vercel/insights/script.js` is answered
  // with the stand-in (the local preview would 404 it), and every other
  // insights request is answered here too, so the measured POST is delivered to
  // nobody at all — not to Vercel, and not even to our own preview server.
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/_vercel/insights/*', requestStage: 'Request' }],
  });
  cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
    try {
      if (isInsightsScript(request.url)) {
        await cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'content-type', value: 'application/javascript; charset=utf-8' },
            { name: 'cache-control', value: 'no-store' },
          ],
          body: Buffer.from(INSIGHTS_STANDIN, 'utf8').toString('base64'),
        });
        return;
      }
      if (isInsights(request.url)) {
        await cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'content-type', value: 'application/json' },
            { name: 'cache-control', value: 'no-store' },
          ],
          body: Buffer.from('{}', 'utf8').toString('base64'),
        });
        return;
      }
      // Nothing else is in the patterns above; if something ever is, let it go
      // to the server rather than silently 404 a request the app needed.
      await cdp.send('Fetch.continueRequest', { requestId });
    } catch (error) {
      // Never silent: an interception that could not be answered is the
      // difference between "nothing leaked" and "nothing was measured".
      console.log(`  [fetch-intercept] could not answer ${request.url}: ${error.message}`);
    }
  });

  for (const scene of SCENES) failures += await runScene(cdp, scene);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} issue(s) across ${SCENES.length} scene(s).`);
} finally {
  chrome.kill('SIGKILL');
  if (ownServer) ownServer.kill('SIGKILL');
  await sleep(400);
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
process.exit(failures ? 1 : 0);
