import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { installStartupGuard } from './startup-guard.ts';

function boot() {
  class Element extends EventTarget {
    textContent = '';
    connected = true;
    children = 0;
    readonly tagName: string;
    readonly rel: string;
    readonly essential: boolean;
    constructor(tagName = 'DIV', rel = '', essential = false) {
      super();
      this.tagName = tagName;
      this.rel = rel;
      this.essential = essential;
    }
    getAttribute(name: string) { return name === 'data-startup' ? (this.essential ? 'essential' : null) : this.rel; }
    hasChildNodes() { return this.children > 0; }
    remove() { this.connected = false; }
  }
  const panel = new Element('SECTION');
  const root = new Element();
  const title = new Element('H1');
  const message = new Element('P');
  const retry = new Element('A');
  const elements: Record<string, Element> = {
    'startup-status': panel, root, 'startup-title': title,
    'startup-message': message, 'startup-retry': retry,
  };
  let mutation = () => {};
  let observing = false;
  let reloads = 0;
  let clock = 0;
  let nextTimer = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const win = Object.assign(new EventTarget(), {
    location: { reload() { reloads++; } },
    setTimeout(callback: () => void, ms: number) {
      const id = ++nextTimer;
      timers.set(id, { at: clock + ms, callback });
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
  });
  // Exercise the exact self-contained script that Vite embeds, including its
  // independence from imports and browser storage.
  runInNewContext(`(${installStartupGuard.toString()})();`, {
    window: win,
    document: { getElementById: (id: string) => elements[id] },
    MutationObserver: class {
      constructor(callback: () => void) { mutation = callback; }
      observe() { observing = true; }
      disconnect() { observing = false; }
    },
  });
  return {
    panel, title, message, retry, win,
    reloads: () => reloads,
    pendingTimers: () => timers.size,
    advance(ms: number) {
      clock += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= clock) { timers.delete(id); timer.callback(); }
      }
    },
    mount() { root.children = 1; if (observing) mutation(); },
    resourceError(tagName: string, rel = '', essential = false) {
      const event = new Event('error');
      Object.defineProperty(event, 'target', { value: new Element(tagName, rel, essential) });
      win.dispatchEvent(event);
    },
  };
}

test('startup remains readable before the application renders', () => {
  const page = boot();
  assert.equal(page.title.textContent, 'Loading PaperTok');
  assert.equal(page.panel.connected, true);
});

test('missing startup scripts and styles present an error with a working retry', () => {
  for (const [tag, rel] of [['SCRIPT', 'module'], ['LINK', 'modulepreload'], ['LINK', 'stylesheet']]) {
    const page = boot();
    page.resourceError(tag, rel, true);
    assert.equal(page.title.textContent, 'PaperTok could not start');
    assert.match(page.message.textContent, /Reload the page/);
    const click = new Event('click', { cancelable: true });
    page.retry.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true);
    assert.equal(page.reloads(), 1);
    page.advance(30000);
    assert.equal(page.title.textContent, 'PaperTok could not start');
    assert.equal(page.reloads(), 1, 'failures must not start automatic reload loops');
  }
});

test('early runtime errors and rejected promises present the recovery screen', () => {
  for (const kind of ['error', 'unhandledrejection']) {
    const page = boot();
    page.win.dispatchEvent(new Event(kind));
    assert.equal(page.title.textContent, 'PaperTok could not start');
    assert.equal(page.panel.connected, true);
  }
});

test('unavailable classic scripts, images and icons do not report an application failure', () => {
  const page = boot();
  page.resourceError('SCRIPT');
  page.resourceError('LINK', 'modulepreload');
  page.resourceError('LINK', 'stylesheet');
  page.resourceError('IMG');
  page.resourceError('LINK', 'icon');
  assert.equal(page.title.textContent, 'Loading PaperTok');
});

test('a stalled startup offers retry without claiming a known cause', () => {
  const page = boot();
  page.advance(30000);
  assert.equal(page.title.textContent, 'PaperTok is taking longer than expected');
  assert.match(page.message.textContent, /keep waiting or reload/);
  page.retry.dispatchEvent(new Event('click'));
  assert.equal(page.reloads(), 1);
});

test('a successful or late mount removes recovery and stops monitoring', () => {
  for (const state of ['normal', 'slow', 'failed']) {
    const page = boot();
    if (state === 'slow') page.advance(30000);
    if (state === 'failed') page.win.dispatchEvent(new Event('error'));
    page.mount();
    const titleAtMount = page.title.textContent;
    assert.equal(page.panel.connected, false);
    assert.equal(page.pendingTimers(), 0);
    page.advance(30000);
    page.win.dispatchEvent(new Event('unhandledrejection'));
    page.win.dispatchEvent(new Event('error'));
    assert.equal(page.title.textContent, titleAtMount);
    page.retry.dispatchEvent(new Event('click'));
    assert.equal(page.reloads(), 0, 'the detached retry must have no listener');
  }
});
