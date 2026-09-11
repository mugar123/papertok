import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: el feed expone un refresco visible en el primer paper y por arrastre', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  assert.match(src, /className=\{`feed-refresh[\s\S]{0,260}onClick=\{handleRefresh\}/);
  assert.match(src, /onTouchStart=\{handleTouchStart\}[\s\S]{0,200}onTouchMove=\{handleTouchMove\}[\s\S]{0,200}onTouchEnd=\{handleTouchEnd\}/);
  assert.match(src, /setActiveIndex\(index\)/);
  assert.match(src, /isActive=\{index === activeIndex\}/);
});

test('SOURCE: la píldora no existe para el invitado, y el tirón tampoco', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  assert.match(src, /\{!publicMode && papers\.length > 0 && \(\s*<button/, 'sin cuenta no hay píldora');
  const start = src.slice(src.indexOf('const handleTouchStart = useCallback('), src.indexOf('const handleTouchMove'));
  assert.match(start, /if \(publicMode\) return;/, 'sin cuenta el tirón no arranca');
  const hover = src.slice(src.indexOf('const handleMouseMove = useCallback('), src.indexOf('const handleMouseLeave'));
  assert.match(hover, /if \(publicMode\) return;/);
  assert.match(hover, /pointer: fine/, 'el hover es solo de puntero fino');
});

test('SOURCE: el tirón escribe su progreso en el elemento, no en el estado del feed', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  const move = src.slice(src.indexOf('const handleTouchMove = useCallback('), src.indexOf('const handleTouchEnd'));
  assert.match(move, /setPull\(pullProgress\(/);
  assert.doesNotMatch(move, /set(?!Pull\b)[A-Z]\w*\(/, 'ningún setState por evento de arrastre');
  const pull = src.slice(src.indexOf('const setPull = useCallback('), src.indexOf('const handleTouchStart'));
  assert.match(pull, /style\.setProperty\('--pull'/);
});

test('SOURCE: el invitado ve el modal de intereses al montar, sin esperar al feed', async () => {
  const src = strip(await read('../Public/GuestFeedPage.jsx'));
  const ask = src.slice(src.indexOf('const [askedOnce, setAskedOnce]'), src.indexOf('setInterestsOpen(true);') + 24);
  assert.doesNotMatch(ask, /feedReady|setTimeout|useEffect/, 'ni espera al feed, ni retardo, ni un efecto que llegue un commit tarde');
  assert.match(ask, /if \(firstAsk && !askedOnce && !interestsPromptSuspended\)/);
});
