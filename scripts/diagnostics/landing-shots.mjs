// Full-page screenshots of a URL, sliced into PNGs short enough to actually
// look at. No dependencies; Node >= 22 for the global WebSocket - same
// no-dependency CDP harness as the other scripts in this directory (see
// project-badge-frames.mjs).
//
//   node scripts/diagnostics/landing-shots.mjs <url> <outPrefix> [sliceHeight]
//
// Writes <outPrefix>-00.png, <outPrefix>-01.png, ... top to bottom, each
// sliceHeight px tall (default 1000) except the last, which is whatever is
// left over. WIDTH=<px> sets the viewport width (default 1440; anything
// under 768 also flips on mobile/touch emulation, matching the convention in
// follow-sheet-probe.mjs). THEME=light|dark forces prefers-color-scheme
// before the page's own inline script reads it - see index.html, which
// resolves papertok_theme from localStorage first and falls back to
// prefers-color-scheme; a fresh profile has no stored value, so this is the
// only lever available from outside the page. PORT=<n> picks another
// debugging port, CHROME=<path> another Chromium binary.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9241);
const WIDTH = Number(process.env.WIDTH || 1440);
const THEME = process.env.THEME === 'dark' || process.env.THEME === 'light' ? process.env.THEME : null;
const PROFILE = join(tmpdir(), `papertok-landing-shots-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [, , url, outPrefix, sliceHeightArg] = process.argv;
if (!url || !outPrefix) {
  console.error('usage: node scripts/diagnostics/landing-shots.mjs <url> <outPrefix> [sliceHeight]');
  process.exit(1);
}
const SLICE = Number(sliceHeightArg || 1000);

mkdirSync(dirname(outPrefix) || '.', { recursive: true });
mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', `--window-size=${WIDTH},900`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

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
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
}

try {
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  if (THEME) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: THEME }] });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: WIDTH < 768 });
  if (WIDTH < 768) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });

  await cdp.send('Page.navigate', { url });
  await sleep(1200); // self-hosted fonts and the prerendered markup settling; no client JS to wait on in task 5

  const metrics = await cdp.send('Page.getLayoutMetrics');
  const fullHeight = Math.ceil((metrics.cssContentSize || metrics.contentSize).height);

  // Re-override with the full content height so every slice below is a
  // plain in-viewport clip - no captureBeyondViewport needed.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: fullHeight, deviceScaleFactor: 1, mobile: WIDTH < 768 });
  await sleep(150);

  let shot = 0;
  for (let y = 0; y < fullHeight; y += SLICE) {
    const height = Math.min(SLICE, fullHeight - y);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y, width: WIDTH, height, scale: 1 } });
    writeFileSync(`${outPrefix}-${String(shot).padStart(2, '0')}.png`, Buffer.from(data, 'base64'));
    shot += 1;
  }
  console.log(`wrote ${shot} slice(s), full height ${fullHeight}px at width ${WIDTH}${THEME ? `, theme=${THEME}` : ''}`);
} finally {
  chrome.kill('SIGKILL');
  await sleep(400);
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
