import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { loadOptionalModule, recoverModuleLoad } from './module-load-recovery.ts';

function browser(t: TestContext) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  let reloads = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: storage, location: { reload() { reloads++; } } } });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousStorage) Object.defineProperty(globalThis, 'sessionStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  return { reloads: () => reloads, values, storage };
}

function failImport(error: Error): Promise<never> {
  // Vite dispatches this before the import's rejection reaches its caller.
  const event = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: error });
  recoverModuleLoad(event);
  assert.equal(event.defaultPrevented, false, 'the caller must receive its original failure');
  return Promise.reject(error);
}

test('a successful optional module retains its exports', async () => {
  const module = { available: true };
  assert.equal(await loadOptionalModule(() => Promise.resolve(module)), module);
});

test('blocked optional modules settle as unavailable without reloading or storing reload marks', async t => {
  const page = browser(t);
  assert.equal(await loadOptionalModule(() => failImport(new TypeError('blocked analytics'))), null);
  t.mock.timers.runAll();
  assert.equal(page.reloads(), 0);
  assert.equal(page.values.size, 0);
});

test('an optional failure cannot suppress a simultaneous required module failure', async t => {
  const page = browser(t);
  const optional = loadOptionalModule(() => failImport(new TypeError('blocked analytics')));
  const required = failImport(new TypeError('missing reader'));
  await assert.rejects(required, /missing reader/);
  await optional;
  t.mock.timers.runAll();
  assert.equal(page.reloads(), 1);
});

test('required modules still reload once within the recovery window', async t => {
  const page = browser(t);
  await assert.rejects(failImport(new TypeError('missing page')));
  t.mock.timers.runAll();
  await assert.rejects(failImport(new TypeError('still missing')));
  t.mock.timers.runAll();
  assert.equal(page.reloads(), 1);
});

test('unavailable session storage prevents a required failure from creating a reload loop', async t => {
  const page = browser(t);
  t.mock.method(page.storage, 'getItem', () => { throw new Error('storage denied'); });
  await assert.rejects(failImport(new TypeError('missing page')));
  t.mock.timers.runAll();
  assert.equal(page.reloads(), 0);
});
