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
