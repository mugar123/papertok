import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./EmailNotificationsContext.jsx', import.meta.url), 'utf8');

/**
 * `newsletter_change` is a delta: it fires when the saved preference differs
 * from the one held in state, and once state has caught up there is nothing
 * left to report. That makes every writer of the preference a place the event
 * can be lost, and there are two — `savePreferences` behind «Guardar cambios»
 * and `sendTest` behind «Enviar prueba», which subscribes for real before it
 * sends the sample. While only the first reported, the second silently spent
 * the delta for anyone who tried the sample email first, and the event arrived
 * zero times in three months of traffic.
 *
 * The fix was to route every saved response through one helper. These tests
 * hold that shape: one emitter, and no writer that bypasses it.
 */
test('newsletter_change has a single emitter', () => {
  const emitters = [...source.matchAll(/trackEvent\(\s*'newsletter_change'/g)];
  assert.equal(
    emitters.length,
    1,
    'a second emitter means the delta is being decided in two places again',
  );
  assert.match(
    source,
    /const applySavedPreferences = useCallback\(\(saved, wasEnabled\) => \{/,
    'the emitter should live in applySavedPreferences',
  );
});

test('every write of the preference reports through applySavedPreferences', () => {
  // Each `await saveEmailNotificationPreferences(...)` is a subscription
  // reaching the server. Whatever the callback does with the response, it has
  // to pass it through the helper before returning.
  const writes = [...source.matchAll(/await saveEmailNotificationPreferences\(/g)];
  assert.ok(writes.length >= 2, 'the scan found the writers at all');

  const unreported = writes.filter(({ index }) => {
    const tail = source.slice(index, source.indexOf('\n  }, [', index));
    return !tail.includes('applySavedPreferences(saved, wasEnabled)');
  });

  assert.equal(
    unreported.length,
    0,
    'a preference write that never reaches applySavedPreferences subscribes without recording it',
  );
});
