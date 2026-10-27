import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('privacy changes finish while the SDK is stalled, and a late SDK observes the final choice', async () => {
  // A separate process keeps the module loader hook and its pending SDK out of
  // other tests. It imports the real service through the normal public API.
  const script = `
    import { registerHooks } from 'node:module';
    import assert from 'node:assert/strict';
    let started;
    const loading = new Promise(resolve => { started = resolve; });
    let release;
    globalThis.pendingAnalytics = new Promise(resolve => { release = resolve; });
    globalThis.analyticsLoading = started;
    globalThis.analyticsEnabled = false;
    globalThis.identifications = [];
    const sdk = 'data:text/javascript,' + encodeURIComponent(\`
      globalThis.analyticsLoading();
      await globalThis.pendingAnalytics;
      export const posthog = {
        init() {},
        has_opted_in_capturing() { return globalThis.analyticsEnabled; },
        opt_in_capturing() { globalThis.analyticsEnabled = true; },
        opt_out_capturing() { globalThis.analyticsEnabled = false; },
        reset() {},
        identify(uid) { globalThis.identifications.push(uid); },
        get_property() { return null; }
      };
    \`);
    registerHooks({ resolve(specifier, context, next) {
      return specifier === 'posthog-js' ? { url: sdk, shortCircuit: true } : next(specifier, context);
    }});
    const values = new Map();
    globalThis.window = {};
    globalThis.location = { hostname: 'papertok.app' };
    globalThis.localStorage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    };
    const service = await import('./src/services/analytics-service.ts');
    const pending = service.identifyAnalyticsUser({ uid: 'late-account' });
    await loading;
    for (const choice of ['denied', 'enabled', 'denied']) {
      const persisted = await Promise.race([
        service.setAnalyticsConsent(choice),
        new Promise((_, reject) => setTimeout(() => reject(new Error('privacy waited for SDK')), 1000).unref())
      ]);
      assert.equal(persisted, true);
      assert.equal(service.readAnalyticsConsent(), choice);
    }
    release();
    await pending;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(globalThis.analyticsEnabled, false);
    assert.deepEqual(globalThis.identifications, []);
    console.log('preference saved before SDK; late SDK stayed disabled');
  `;
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, cwd: new URL('../..', import.meta.url) });
  assert.match(stdout, /preference saved before SDK; late SDK stayed disabled/);
});
