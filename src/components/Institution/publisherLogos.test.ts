import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { SERVICE_CATALOGUE } from '../../../worker/institution-services.ts';

// The module imports the logo files through Vite, so node reads its source instead.
const source = readFileSync(new URL('./publisherLogos.ts', import.meta.url), 'utf8');
const assetsDir = new URL('../../assets/publishers/', import.meta.url);
const imports = [...source.matchAll(/^import (\w+) from '\.\.\/\.\.\/assets\/publishers\/([\w-]+)\.(svg|png|ico)';$/gm)];
const files = readdirSync(assetsDir).filter(name => /\.(svg|png|ico)$/.test(name));

test('every mapped logo is a bundled file named after its platform id', () => {
  assert.ok(imports.length > 0);
  for (const [, name, file, extension] of imports) {
    assert.equal(name, file);
    assert.ok(existsSync(new URL(`${file}.${extension}`, assetsDir)), `${file}.${extension} is missing`);
  }
});

// A reader only ever sees platforms from the Worker's catalogue, whichever
// provider answers for their library, so a platform added there without a
// logo would be the one row drawn as a bare monogram.
test('every platform in the Worker catalogue has a bundled logo', () => {
  const mapped = new Set(imports.map(([, name]) => name));
  for (const { id } of SERVICE_CATALOGUE) assert.ok(mapped.has(id), `${id} has no logo`);
});

test('every bundled logo has a provenance row in the README', () => {
  const readme = readFileSync(new URL('README.md', assetsDir), 'utf8');
  for (const file of files) assert.ok(readme.includes(`\`${file}\``), `${file} is not in the README`);
});

test('no bundled SVG logo can run script or load another resource', () => {
  for (const file of files.filter(name => name.endsWith('.svg'))) {
    const svg = readFileSync(new URL(file, assetsDir), 'utf8');
    for (const pattern of [/<script/i, /<image/i, /<foreignObject/i, /href="http/i, /@import/i, /url\(\s*['"]?http/i]) {
      assert.doesNotMatch(svg, pattern, `${file} matches ${pattern}`);
    }
  }
});
