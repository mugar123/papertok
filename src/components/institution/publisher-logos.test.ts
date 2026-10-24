import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const assetsDir = new URL('../../assets/publishers/', import.meta.url);
const files = readdirSync(assetsDir).filter(name => /\.(svg|png|ico)$/.test(name));

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
