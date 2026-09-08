// Census of the two doors into the Explorer's author page, from the real feed.
//
//   PROFILE_DIR=~/.papertok-probe-profile ORIGIN=http://localhost:5174 \
//     node scripts/diagnostics/author-door-census.mjs [waitMs]
//   SCROLL=8 PROFILE_DIR=… node scripts/diagnostics/author-door-census.mjs 15000
//
// A card sends an author to `/explorer/author/<id>?name=…` when it holds an
// OpenAlex id and to `/explorer/author/<name>?arxivId=…` when it does not, and
// the second door costs three round trips before the hero can paint
// (src/utils/explorerPaths.js). This counts which door the feed actually hands
// out, over a signed-in feed served from a PRODUCTION build:
//
//   * DOM: every `.pc-author-link`, split by href — `?name=` is the fast
//     id-keyed route, `arxivId=` the slow name-keyed one.
//   * Data: the feed snapshot the app writes to localStorage
//     (`papertok_feed_snapshot_…`), which holds the whole page rather than only
//     the mounted cards, so each paper's source, its OpenAlex enrichment and
//     whether its authors carry an id can be read together. `openAlexKeys`
//     lists what the enrichment blob actually brought back, which is how one
//     tells "the id is here and is not propagated" from "the id was never
//     asked for".
//
// `SCROLL=<n>` pages the feed down n times before counting: the first screenful
// is the freshest arXiv and is not a sample of the feed. Measured 2026-09-07,
// the split moves from 57% slow on the first page to 92% after eight pages.
//
// A demo build is useless here: its feed only ever hands out the fast door.
// The profile is used as-is and NEVER deleted: it is one the user signed in to,
// and Chrome locks a --user-data-dir, so no other instance may hold it.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9231);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5174';
const OWN_PROFILE = !process.env.PROFILE_DIR;
const PROFILE = process.env.PROFILE_DIR || join(tmpdir(), `papertok-door-census-${process.pid}`);
const WAIT_MS = Number(process.argv[2] || 20000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch() {
  mkdirSync(PROFILE, { recursive: true });
  return spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
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

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      } else (this.listeners.get(m.method) || []).forEach((fn) => fn(m.params));
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

// Reads the same rule the card applies (src/utils/explorerPaths.js) against the
// snapshot, so the data census and the DOM census are comparable.
const CENSUS = `(() => {
  const links = [...document.querySelectorAll('.pc-author-link')].map((a) => a.getAttribute('href') || '');
  const dom = {
    total: links.length,
    fast: links.filter((h) => h.includes('?name=')).length,
    slow: links.filter((h) => h.includes('arxivId=')).length,
    publicMode: links.filter((h) => h.includes('/public/entity/')).length,
    sample: links.slice(0, 6),
  };

  const keys = Object.keys(localStorage).filter((k) => k.startsWith('papertok_feed_snapshot_'));
  const snaps = keys.map((k) => { try { return { k, v: JSON.parse(localStorage.getItem(k)) }; } catch { return null; } })
    .filter((s) => s && Array.isArray(s.v?.papers) && s.v.papers.length);
  const snap = snaps.sort((a, b) => (b.v.savedAt || 0) - (a.v.savedAt || 0))[0];

  const OPENALEX_AUTHOR = /(?:^|\\/)(A\\d+)$/i;
  const hasOaId = (author) => {
    const raw = typeof author === 'string' ? '' : String(author?.id || author?.openAlexId || '').trim();
    return OPENALEX_AUTHOR.test(raw);
  };

  let papers = [];
  if (snap) {
    papers = snap.v.papers.map((p) => {
      const authors = Array.isArray(p.authors) ? p.authors : [];
      const shown = authors.slice(0, 3);
      return {
        id: p.id,
        primary: p.sources?.primary || '?',
        enrichedBy: (p.sources?.enrichedBy || []).join('+') || '-',
        arxivId: p.arxivId || null,
        doi: p.doi || null,
        authors: authors.length,
        shown: shown.length,
        shownFast: shown.filter(hasOaId).length,
        allFast: authors.filter(hasOaId).length,
        // What the OpenAlex enrichment blob actually carries — the question is
        // whether the id is present in the paper and merely not propagated.
        hasOpenAlexBlob: !!p.openAlex,
        openAlexKeys: p.openAlex ? Object.keys(p.openAlex).sort().join(',') : '',
        openAlexHasAuthors: !!(p.openAlex && (p.openAlex.authors || p.openAlex.authorships)),
        firstAuthorId: authors[0] ? String(authors[0].id ?? 'null') : '(none)',
      };
    });
  }

  const sum = (f) => papers.reduce((n, p) => n + f(p), 0);
  return {
    dom,
    snapshotKey: snap ? snap.k : null,
    snapshotAgeMs: snap ? Date.now() - (snap.v.savedAt || 0) : null,
    papers,
    data: {
      papers: papers.length,
      shownLinks: sum((p) => p.shown),
      shownFast: sum((p) => p.shownFast),
      allAuthors: sum((p) => p.authors),
      allFast: sum((p) => p.allFast),
      papersWithOpenAlexBlob: papers.filter((p) => p.hasOpenAlexBlob).length,
      papersWhoseBlobHasAuthors: papers.filter((p) => p.openAlexHasAuthors).length,
      byPrimary: papers.reduce((acc, p) => { acc[p.primary] = (acc[p.primary] || 0) + 1; return acc; }, {}),
    },
  };
})()`;

const chrome = launch();
try {
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const consoleLines = [];
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (consoleLines.length < 60) consoleLines.push(`${p.type}: ${(p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`);
  });

  await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}#/` });

  // The feed only proves the session was inherited once its author links point
  // at /explorer/ rather than /public/entity/.
  for (let i = 0; i < 400; i++) {
    const n = await cdp.eval(`document.querySelectorAll('.pc-author-link').length`).catch(() => 0);
    if (n > 0) break;
    await sleep(100);
  }
  const first = await cdp.eval(`(() => { const a = document.querySelector('.pc-author-link'); return a ? a.getAttribute('href') : null; })()`);
  console.log('first author link:', first);
  console.log('signed in:', await cdp.eval(`!!document.querySelector('.navbar-avatar, .navbar-user, img[alt*="avatar" i]') || !document.querySelector('a[href*="/public/entity/"]')`));

  // Let the late OpenAlex enrichment pass land before counting: if it were the
  // thing that supplies the ids, the census has to be taken after it.
  // More than the first page: the feed only appends as the reader moves, and a
  // census of the first three cards is a census of the freshest arXiv, not of
  // the feed.
  if (process.env.SCROLL) {
    for (let i = 0; i < Number(process.env.SCROLL); i++) {
      await cdp.eval(`(() => { const el = document.querySelector('.feed-container, .feed, #main-content'); (el || window).scrollBy ? (el || window).scrollBy(0, window.innerHeight) : window.scrollBy(0, window.innerHeight); return true; })()`).catch(() => {});
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 }).catch(() => {});
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 }).catch(() => {});
      await sleep(900);
    }
  }
  const before = await cdp.eval(CENSUS);
  console.log('--- census BEFORE waiting out enrichment ---');
  console.log(JSON.stringify(before.dom));
  await sleep(WAIT_MS);
  const after = await cdp.eval(CENSUS);

  console.log('--- census AFTER', WAIT_MS, 'ms ---');
  console.log(JSON.stringify({ dom: after.dom, data: after.data, snapshotKey: after.snapshotKey, snapshotAgeMs: after.snapshotAgeMs }, null, 2));
  console.log('--- per paper ---');
  for (const p of after.papers) console.log(JSON.stringify(p));
  if (consoleLines.length) { console.log('--- console ---'); consoleLines.forEach((l) => console.log(l)); }
  // Opt-in, and never inside the repo by default: a run should not leave an
  // untracked blob behind next to the script.
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ before, after }, null, 2));
} finally {
  chrome.kill();
  await sleep(300);
  if (OWN_PROFILE) rmSync(PROFILE, { recursive: true, force: true });
}
