// The tab-bar sequence in desktop Safari (WebKit) through safaridriver's
// WebDriver endpoint: seed the demo session, For you -> Following -> For you
// with real WebDriver clicks, and the per-frame samples of the handover.
// Needs Safari → Settings → Advanced → "Allow remote automation" (once).
// usage: ORIGIN=http://localhost:5174 node scripts/diagnostics/safari-tabs-probe.mjs
import { spawn } from 'node:child_process';

const ORIGIN = process.env.ORIGIN || 'http://localhost:5174';
const PORT = Number(process.env.SD_PORT || 4445);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const driver = spawn('/System/Cryptexes/App/usr/bin/safaridriver', ['-p', String(PORT)], { stdio: 'ignore' });
process.on('exit', () => { try { driver.kill(); } catch {} });
await sleep(1200);

const base = `http://127.0.0.1:${PORT}`;
async function wd(method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${j.value.error}: ${j.value.message}`);
  return j.value;
}

let session;
try {
  session = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
} catch (e) {
  console.log('safaridriver session failed:', e.message);
  process.exit(2);
}
const sid = session.sessionId;
const S = (p) => `/session/${sid}${p}`;
const exec = (script, args = []) => wd('POST', S('/execute/sync'), { script, args });

const FOLLOWS = JSON.stringify([
  ['A5056895519', 'Markus Göker'], ['A5089245822', 'Joshua Adkins'], ['A5006191066', 'Scott Baker'], ['A5005196385', 'Matthew Monroe'], ['A5023982706', 'Richard Smith'],
].map(([id, name]) => ({ type: 'author', id, canonicalId: id, name, source: 'openalex' })));

await wd('POST', S('/url'), { url: `${ORIGIN}/blank-for-seed.html` });
await sleep(500);
await exec(`try { localStorage.setItem('papertok_user', JSON.stringify({ uid: 'probe-demo', email: 'probe@example.com', displayName: 'Probe' })); localStorage.setItem('papertok_onboardingComplete', 'true'); localStorage.setItem('papertok_selectedCategories', JSON.stringify(['quant-ph', 'cond-mat.mtrl-sci', 'cs.AI'])); localStorage.setItem('papertok_following_probe-demo', ${JSON.stringify(FOLLOWS)}); } catch (e) { return String(e); } return 'seeded';`);
await wd('POST', S('/url'), { url: `${ORIGIN}/#/` });

const INSTRUMENT = `
  window.__ev = [];
  const desc = (el) => { if (!el || !el.tagName) return String(el && el.nodeName); const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : ''; const txt = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 16); return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (txt ? '[' + txt + ']' : ''); };
  const push = (o) => window.__ev.push({ t: Math.round(performance.now()), ...o });
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
    document.addEventListener(type, (e) => { push({ type, target: desc(e.target), dp: e.defaultPrevented }); }, true);
  }
  const ps = history.pushState.bind(history); history.pushState = (s, t, u) => { push({ type: 'pushState', url: String(u) }); return ps(s, t, u); };
  window.__fr = []; window.__frOn = false;
  const op = (el) => el ? Number(getComputedStyle(el).opacity).toFixed(2) : null;
  const tick = () => { if (window.__frOn) { const pages = [...document.querySelectorAll('#main-content > div')]; window.__fr.push({ t: Math.round(performance.now()), hash: location.hash, pages: pages.map((p) => op(p) + ' d=' + p.getAttribute('data-nav-direction')).join(' | '), active: (document.querySelector('.navbar-link.active')?.textContent || '').trim(), cards: document.querySelectorAll('.feed-snap-item').length, title: (document.querySelector('.pc-title')?.textContent || '').trim().slice(0, 28) }); } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return 'instrumented';`;

const poll = async (expr, timeoutMs) => { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { if (await exec(`return ${expr};`)) return true; await sleep(150); } return false; };
console.log('feed ready:', await poll("document.querySelectorAll('.pc-sheet').length > 0", 40000), 'ua:', (await exec('return navigator.userAgent;')).slice(0, 80));
await exec(INSTRUMENT);
await sleep(1500);

async function clickAndReport(label, selectorScript, waitMs = 3000) {
  const el = await exec(`return ${selectorScript};`);
  const ref = el && (el['element-6066-11e4-a52e-4f735466cecf'] || el.ELEMENT);
  if (!ref) { console.log(`\n## ${label}: element not found`); return; }
  const evStart = await exec('return window.__ev.length;');
  await exec('window.__fr = []; window.__frOn = true; return true;');
  const t0 = await exec('return Math.round(performance.now());');
  await wd('POST', S(`/element/${ref}/click`));
  await sleep(waitMs);
  const r = await exec(`window.__frOn = false; const t0 = arguments[0]; const ev = window.__ev.slice(arguments[1]).map((e) => ({ ...e, t: e.t - t0 })); const fr = window.__fr; const changes = []; let last = ''; for (const x of fr) { const k = JSON.stringify([x.hash, x.pages, x.active, x.cards > 0, x.title]); if (k !== last) { last = k; changes.push({ ...x, t: x.t - t0 }); } } return { hash: location.hash, active: (document.querySelector('.navbar-link.active')?.textContent || '').trim(), title: (document.querySelector('.pc-title')?.textContent || '').trim().slice(0, 40), events: ev, changes: changes.slice(0, 12) };`, [t0, evStart]);
  console.log(`\n## ${label}`);
  console.log('events:', JSON.stringify(r.events));
  console.log('after:', JSON.stringify({ hash: r.hash, active: r.active, title: r.title }));
  console.log('frames:', JSON.stringify(r.changes, null, 0).replace(/\},\{/g, '},\n{'));
}

for (let cycle = 1; cycle <= 2; cycle++) {
  await clickAndReport(`cycle ${cycle}: For you -> Following (Safari click)`, "document.querySelector('.navbar-link[href=\"#/following\"]')");
  await clickAndReport(`cycle ${cycle}: Following -> For you (Safari click)`, "[...document.querySelectorAll('.navbar-link')].find((l) => /For you|Para ti/.test(l.textContent))");
}
await wd('DELETE', S(''));
process.exit(0);
