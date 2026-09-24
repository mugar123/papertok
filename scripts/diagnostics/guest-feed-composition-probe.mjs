// Guest feed composition and request census, against production, over CDP.
// No dependencies (Node >= 22 has a global WebSocket).
//
// What it does, in three phases, with a fresh Chrome profile (a first-time
// visitor, Spanish UI the way the ES button leaves it):
//   A. opens https://papertok.app/ and waits 15 s with the interests sheet up;
//   B. picks the given areas in that sheet, submits, and reads the paper list
//      FeedContainer was handed (from the React fiber) at 1.5/3/6/12/20 s;
//   C. reloads with the interests stored and reads the list again.
// Every request of the page target is recorded per phase. Writes
// <out>/report.json. See docs/AUDITORIA-12-FALLOS-2026-09-23.md, issues 1 and 11.
//
// Live traffic: one run is a real guest session on production -- about 70
// asset requests and 25-30 calls to api.papertok.app and its providers
// (OpenAlex, PubMed, arXiv, Europe PMC...). No account, no writes. Do not loop it.
//
// usage: node scripts/diagnostics/guest-feed-composition-probe.mjs [--areas=cs,med] [--out=<dir>]
//        (ORIGIN=… and PORT=… override the target and the DevTools port)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9231);
const ORIGIN = process.env.ORIGIN || 'https://papertok.app';
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const AREAS = String(args.areas || 'cs,med').split(',');
// Under the OS temp dir by default, never beside this script: the profile is
// left behind on purpose (Chrome children can still be writing when it exits).
const OUT = args.out || join(tmpdir(), `papertok-guest-probe-${Date.now()}`);
const PROFILE = join(OUT, 'profile');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--lang=es-ES',
  'about:blank',
], { stdio: 'ignore' });

async function pageTarget() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('no page target');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      } else (this.listeners.get(m.method) || []).forEach(fn => fn(m.params));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(fn); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`);
    return r.result.value;
  }
}

// Every request the page target makes, with its phase.
const requests = new Map();
let phase = 'boot';
let t0 = 0;
const consoleLines = [];

// Reads the paper list FeedContainer was handed, from the React fiber of the
// first card: the feed mounts a window of cards, not all twelve.
const READ_PAPERS = `(() => {
  const sheet = document.querySelector('.pc-sheet') || document.querySelector('.feed-container');
  if (!sheet) return { papers: null, why: 'no card' };
  const key = Object.keys(sheet).find(k => k.startsWith('__reactFiber'));
  let fiber = sheet[key];
  while (fiber) {
    const papers = fiber.memoizedProps?.source?.papers;
    if (Array.isArray(papers)) {
      return {
        papers: papers.map(p => ({
          title: String(p.title || '').slice(0, 110),
          primary: p.sources?.primary || p.provider || p.source || null,
          provider: p.provider || null,
          categories: (p.categories || []).slice(0, 4),
          primaryCategory: p.primaryCategory || p.category || null,
          year: p.year,
          doi: p.doi || null,
          arxivId: p.arxivId || null,
          pmid: p.pmid || null,
          isPreprint: p.isPreprint ?? null,
          type: p.type || p.publicationType || null,
        })),
      };
    }
    fiber = fiber.return;
  }
  return { papers: null, why: 'no source.papers prop' };
})()`;

const READ_DOM = `(() => ({
  lang: document.documentElement.lang,
  promptOpen: !!document.querySelector('.gip'),
  promptTitle: document.querySelector('.gip-title')?.textContent?.trim() || null,
  cardsMounted: document.querySelectorAll('.pc-sheet').length,
  firstTitles: [...document.querySelectorAll('.pc-title')].slice(0, 3).map(n => n.textContent.trim().slice(0, 90)),
  pills: [...document.querySelectorAll('.pc-category-pill')].slice(0, 6).map(n => n.textContent.trim()),
  topics: [...document.querySelectorAll('.pc-topics')].slice(0, 4).map(n => [...n.querySelectorAll('button')].map(b => b.textContent.trim())),
  chips: [...document.querySelectorAll('.pc-chips')].slice(0, 4).map(n => n.textContent.trim()),
  h1: [...document.querySelectorAll('h1')].map(n => n.textContent.trim()),
  errorText: document.querySelector('.feed-error, [role="alert"]')?.textContent?.trim()?.slice(0, 200) || null,
}))()`;

function summarize(list) {
  const byHost = {};
  for (const r of list) {
    const host = (() => { try { return new URL(r.url).host; } catch { return r.url.slice(0, 30); } })();
    byHost[host] = (byHost[host] || 0) + 1;
  }
  return byHost;
}

try {
  const ws = new WebSocket(await pageTarget());
  await new Promise(r => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('papertok_language','es'); localStorage.setItem('papertok_language_mode','manual'); } catch {}`,
  });

  cdp.on('Network.requestWillBeSent', (p) => {
    if (p.request.url.startsWith('data:')) return;
    const prev = requests.get(p.requestId);
    requests.set(p.requestId, {
      ...(prev || {}),
      url: p.request.url, method: p.request.method, type: p.type, phase: prev?.phase || phase,
      start: Math.round(p.timestamp * 1000 - t0), redirected: !!p.redirectResponse,
    });
  });
  cdp.on('Network.responseReceived', (p) => {
    const r = requests.get(p.requestId); if (!r) return;
    r.status = p.response.status; r.fromSW = p.response.fromServiceWorker; r.fromCache = p.response.fromDiskCache;
  });
  cdp.on('Network.loadingFinished', (p) => {
    const r = requests.get(p.requestId); if (!r) return;
    r.end = Math.round(p.timestamp * 1000 - t0); r.bytes = p.encodedDataLength;
  });
  cdp.on('Network.loadingFailed', (p) => {
    const r = requests.get(p.requestId); if (!r) return;
    r.end = Math.round(p.timestamp * 1000 - t0); r.failed = p.errorText; r.canceled = p.canceled;
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    consoleLines.push({ phase, type: p.type, text: p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleLines.push({ phase, type: 'exception', text: (p.exceptionDetails.exception?.description || p.exceptionDetails.text || '').slice(0, 300) });
  });

  // Network timestamps are monotonic; any constant works as long as every
  // phase is normalised to its own first request below.
  t0 = 0;

  // ---- Phase A: first open, fresh guest
  phase = 'A-open';
  await cdp.send('Page.navigate', { url: `${ORIGIN}/` });
  await sleep(15_000);
  const domA = await cdp.eval(READ_DOM).catch(e => ({ error: String(e) }));
  const papersA = await cdp.eval(READ_PAPERS).catch(e => ({ error: String(e) }));

  // ---- Phase B: answer the prompt with the chosen areas
  phase = 'B-after-pick';
  const pick = await cdp.eval(`(() => {
    const wanted = ${JSON.stringify(AREAS)};
    const names = { cs: ['Ciencias de la Computación','Computer Science'], med: ['Medicina','Medicine'], bio: ['Biología','Biology'], physics: ['Física','Physics'] };
    const buttons = [...document.querySelectorAll('.gip-area')];
    const clicked = [];
    for (const key of wanted) {
      const labels = names[key] || [key];
      const b = buttons.find(btn => labels.includes(btn.querySelector('.gip-area-name')?.textContent?.trim()));
      if (b) { b.click(); clicked.push(key); }
    }
    return { available: buttons.map(b => b.querySelector('.gip-area-name')?.textContent?.trim()), clicked };
  })()`);
  await sleep(400);
  const submit = await cdp.eval(`(() => { const s = document.querySelector('.gip-submit'); if (!s) return 'no submit'; s.click(); return s.disabled ? 'disabled' : 'clicked'; })()`);
  const snapshots = [];
  for (const wait of [1500, 3000, 6000, 12000, 20000]) {
    const prev = snapshots.length ? snapshots[snapshots.length - 1].at : 0;
    await sleep(wait - prev);
    snapshots.push({ at: wait, papers: await cdp.eval(READ_PAPERS).catch(e => ({ error: String(e) })) });
  }
  const domB = await cdp.eval(READ_DOM).catch(e => ({ error: String(e) }));

  // ---- Phase C: a second visit, interests already stored
  phase = 'C-reload';
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(15_000);
  const domC = await cdp.eval(READ_DOM).catch(e => ({ error: String(e) }));
  const papersC = await cdp.eval(READ_PAPERS).catch(e => ({ error: String(e) }));
  const stored = await cdp.eval(`localStorage.getItem('papertok_guestInterests')`);

  // Normalise times to the first document request of each phase.
  const all = [...requests.values()];
  const phases = {};
  for (const r of all) (phases[r.phase] ||= []).push(r);
  const report = { origin: ORIGIN, areas: AREAS, pick, submit, stored, domA, papersA, snapshots, domB, domC, papersC, phases: {}, console: consoleLines };
  for (const [name, list] of Object.entries(phases)) {
    const base = Math.min(...list.map(r => r.start));
    report.phases[name] = {
      count: list.length,
      byHost: summarize(list),
      byType: list.reduce((acc, r) => ((acc[r.type] = (acc[r.type] || 0) + 1), acc), {}),
      requests: list.map(r => ({ ...r, start: r.start - base, end: r.end != null ? r.end - base : null })),
    };
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log('wrote', join(OUT, 'report.json'));
} finally {
  chrome.kill('SIGKILL');
  await sleep(500);
  // profile left in the scratchpad on purpose (Chrome children may still write)
}
