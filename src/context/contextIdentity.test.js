import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.jsx?$/.test(entry) && !entry.endsWith('.test.js')) yield full;
  }
}

/**
 * A React context is identified by object identity, not by name: `useContext`
 * only finds a provider that pushed *the same object* `createContext` returned.
 *
 * In dev, Vite re-evaluates a module when Fast Refresh invalidates it. If
 * `createContext()` sits in the same module as the provider component, every
 * such re-evaluation mints a *new* context object. Importers that were not
 * re-fetched in the same pass keep the old one, so their `useContext` reads the
 * default value and a correctly nested provider still throws "must be used
 * within a ...Provider". A production build bundles each module exactly once
 * and never sees it, which is what makes it so easy to leave in place.
 *
 * Keeping `createContext()` in a module that defines no components removes the
 * hazard: that module is not a refresh boundary, so editing a provider never
 * re-creates the context its consumers are holding.
 */
test('createContext lives only in modules that define no components', () => {
  const offenders = [];
  for (const file of sourceFiles(srcDir)) {
    const source = readFileSync(file, 'utf8');
    if (!/\bcreateContext\s*\(/.test(source)) continue;
    const name = relative(srcDir, file);
    const declared = [...source.matchAll(/export\s+(?:default\s+)?(?:function|class)\s+([A-Z]\w*)/g)].map(m => m[1]);
    if (declared.length) offenders.push(`${name} also declares ${declared.join(', ')}`);
    else if (/<[A-Z][\w.]*[\s/>]/.test(source)) offenders.push(`${name} also contains JSX`);
  }
  assert.deepEqual(offenders, [], `createContext() must not share a module with components:\n  ${offenders.join('\n  ')}`);
});

/**
 * FeedContext and AuthContext build the busiest `value` objects in the app
 * (~30 and ~20 keys) and used to rebuild them as a plain object literal on
 * every render — the two providers whose state changes most, so every
 * re-rank, every late-enrichment merge and every like re-rendered every
 * consumer regardless of which key it actually reads.
 *
 * Wrapping that object in `useMemo` only helps if what goes *into* it is also
 * stable: `useMemo` recomputes whenever any dependency in its own list gets a
 * new identity, and a plain `const foo = () => {}` defined in the component
 * body gets a new identity every render no matter what the wrapper around it
 * says. So this test checks that every ingredient of the memo is sourced
 * from `useState`/`useCallback`/`useMemo` (or an allow-listed module
 * constant), and that the memo's own dependency array is complete relative
 * to the object literal it builds.
 *
 * What this test proves and what it does not: it proves *shape* — every key
 * in the object has a matching entry in the dependency array, and every
 * dependency is the kind of thing React can hold a stable reference to. It
 * does NOT prove *identity* the way `Object.is(value1, value2)` across two
 * renders with unchanged state would: `isSourcedFromStableHook` confirms an
 * identifier is *assigned from* a `useCallback`/`useMemo` call, but never
 * looks inside that call's own dependency array. A function wrapped as
 * `useCallback(fn, [])` and one wrapped as `useCallback(fn, [somethingRecreatedEveryRender])`
 * both read as "sourced from useCallback" and both pass. Closing that gap
 * for real would mean walking each `useCallback`'s own deps (and, transitively,
 * theirs) back to a stable root — not attempted here; treat this test as a
 * structural lint against the "forgot to memoize" and "dependency array is
 * incomplete" mistakes, not as a substitute for actually rendering the
 * provider twice and comparing references.
 *
 * It has to be read statically at all: this repo's tests run under plain
 * `node --test`, which cannot even import a `.jsx` file (there is no loader
 * registered for it — confirmed empirically, not assumed) — so there is no
 * way to mount either provider and render it twice, the same constraint
 * `libraryPrefetch.test.js` already documents for FeedContext's other
 * behaviour.
 */

// Free variables referenced inside the memo that are NOT component state:
// module-level imports/constants. React's exhaustive-deps rule exempts these
// (they cannot change identity across renders, so they are never required —
// and, dually, never need to be re-verified as "sourced from a hook" either).
// This mirrors the existing convention throughout FeedContext/AuthContext,
// where `IS_DEMO` never appears in any dependency array despite being read
// inside dozens of `useCallback`s.
const STABLE_MODULE_CONSTANTS = new Set(['IS_DEMO']);

function extractMemoizedValueBlock(source, providerName) {
  const providerStart = source.indexOf(`function ${providerName}(`);
  assert.ok(providerStart > 0, `could not find ${providerName}`);
  const OBJECT_OPEN = 'const value = useMemo(() => ({';
  const valueStart = source.indexOf(OBJECT_OPEN, providerStart);
  assert.ok(
    valueStart > 0,
    `${providerName} must build its context value as \`useMemo(() => ({...}), [...])\`, `
    + 'not a plain object literal rebuilt on every render',
  );
  const valueEnd = source.indexOf('\n  return <', valueStart);
  assert.ok(valueEnd > valueStart, `could not find the end of ${providerName}'s value block`);
  return {
    providerSource: source.slice(providerStart, valueEnd),
    block: source.slice(valueStart, valueEnd),
  };
}

function parseObjectKeys(block) {
  const CLOSE = '}), [';
  const objectSource = block.slice(
    block.indexOf('const value = useMemo(() => ({') + 'const value = useMemo(() => ({'.length,
    block.indexOf(CLOSE),
  );
  return objectSource
    .split(',')
    .map(entry => entry.replace(/\/\/.*$/m, '').trim())
    .filter(Boolean)
    // `key: identifier` exposes `identifier` under an alias (e.g.
    // `setFeedMode: handleSetFeedMode`, `isDemo: IS_DEMO`) — the thing whose
    // stability matters is the identifier on the right, not the public name.
    .map(entry => (entry.includes(':') ? entry.split(':')[1].trim() : entry));
}

function parseDepsArray(block) {
  const CLOSE = '}), [';
  const depsSource = block.slice(
    block.indexOf(CLOSE) + CLOSE.length,
    block.lastIndexOf(']);'),
  );
  return new Set(depsSource.split(',').map(entry => entry.trim()).filter(Boolean));
}

function isSourcedFromStableHook(providerSource, identifier) {
  if (STABLE_MODULE_CONSTANTS.has(identifier)) return true;
  return (
    new RegExp(`const \\[[^\\]]*\\b${identifier}\\b[^\\]]*\\]\\s*=\\s*useState\\(`).test(providerSource)
    || new RegExp(`const ${identifier} = useCallback\\(`).test(providerSource)
    || new RegExp(`const ${identifier} = useMemo\\(`).test(providerSource)
  );
}

for (const [file, providerName] of [
  ['FeedContext.jsx', 'FeedProvider'],
  ['AuthContext.jsx', 'AuthProvider'],
]) {
  test(`${providerName}'s context value is actually stable, not merely wrapped`, () => {
    const source = readFileSync(join(srcDir, 'context', file), 'utf8');
    const { providerSource, block } = extractMemoizedValueBlock(source, providerName);
    const keys = parseObjectKeys(block);
    const deps = parseDepsArray(block);

    assert.ok(keys.length > 10, `expected to have parsed ${providerName}'s value keys, found ${keys.length}`);
    assert.ok(deps.size > 10, `expected to have parsed ${providerName}'s dependency array, found ${deps.size}`);

    for (const identifier of keys) {
      if (STABLE_MODULE_CONSTANTS.has(identifier)) continue;
      assert.ok(
        deps.has(identifier),
        `${providerName}: '${identifier}' is used in the value object but missing from the `
        + 'useMemo dependency array — either it never changes (say so explicitly, e.g. by '
        + 'listing a module constant) or the memo can go stale and hand out an object built '
        + 'from an earlier render',
      );
    }

    for (const identifier of deps) {
      assert.ok(
        isSourcedFromStableHook(providerSource, identifier),
        `${providerName}: dependency '${identifier}' is not sourced from useState/useCallback/`
        + 'useMemo (or an allow-listed module constant) — wrapping the value object in useMemo '
        + 'does not help if an ingredient is still recreated on every render',
      );
    }
  });
}
