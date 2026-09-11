import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: el feed expone un refresco visible en el primer paper y por arrastre', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  assert.match(src, /className="feed-refresh"[\s\S]{0,200}onClick=\{handleRefresh\}/);
  assert.match(src, /onTouchStart=\{handleTouchStart\}[\s\S]{0,200}onTouchEnd=\{handleTouchEnd\}/);
  assert.match(src, /setActiveIndex\(index\)/);
  assert.match(src, /isActive=\{index === activeIndex\}/);
});
