import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: el feed expone un refresco visible en el primer paper y por arrastre', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  assert.match(src, /className=\{`feed-refresh[\s\S]{0,260}onClick=\{handleRefresh\}/);
  const listeners = src.slice(src.indexOf("el.addEventListener('touchstart'"), src.indexOf("return () => {", src.indexOf("el.addEventListener('touchstart'")));
  assert.match(listeners, /touchstart[\s\S]{0,120}touchmove[\s\S]{0,120}touchend[\s\S]{0,120}touchcancel/, 'las cuatro fases del gesto');
  assert.match(listeners, /'touchmove', onMove, \{ passive: false \}/,
    'touchmove NO pasivo: React lo registra pasivo en la ra\u00edz y ah\u00ed preventDefault se ignora');
  assert.doesNotMatch(src, /onTouchStart=|onTouchMove=|onTouchEnd=/, 'nada de props t\u00e1ctiles de React en el scroller');
  assert.match(src, /setActiveIndex\(index\)/);
  assert.match(src, /isActive=\{index === activeIndex\}/);
});

test('SOURCE: la píldora no existe para el invitado, y el tirón tampoco', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  assert.match(src, /\{!publicMode && papers\.length > 0 && \(\s*<button/, 'sin cuenta no hay píldora');
  const attach = src.slice(src.indexOf('const el = feedRef.current;'), src.indexOf('const onStart ='));
  assert.match(attach, /if \(!el \|\| publicMode\) return undefined;/, 'sin cuenta el tirón ni se engancha');
  const hover = src.slice(src.indexOf('const handleMouseMove = useCallback('), src.indexOf('}, [handleMouseMove, publicMode]);'));
  assert.match(hover, /if \(publicMode\) return;/);
  assert.match(hover, /pointer: fine/, 'el hover es solo de puntero fino');
  assert.match(hover, /feedRef\.current\?\.parentElement/, 'se escucha en el envoltorio, padre del scroller y de la píldora');
  assert.doesNotMatch(src, /onMouseMove=\{handleMouseMove\}|onMouseLeave=/, 'nunca en el scroller: la píldora es su hermano y entrar en ella era un mouseleave');
});

test('SOURCE: el tirón escribe su progreso en el elemento, no en el estado del feed', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  const move = src.slice(src.indexOf('const onMove = (event) => {'), src.indexOf('const onEnd = (event) => {'));
  assert.match(move, /setPull\(pullProgress\(/);
  assert.doesNotMatch(move, /set(?!Pull\b)[A-Z]\w*\(/, 'ningún setState por evento de arrastre');
  const pull = src.slice(src.indexOf('const setPull = useCallback('), src.indexOf('const handleMouseMove'));
  assert.match(pull, /style\.setProperty\('--pull'/);
});

test('SOURCE: el invitado ve el modal de intereses al montar, sin esperar al feed', async () => {
  const src = strip(await read('../Public/GuestFeedPage.jsx'));
  const ask = src.slice(src.indexOf('const [askedOnce, setAskedOnce]'), src.indexOf('setInterestsOpen(true);') + 24);
  assert.doesNotMatch(ask, /feedReady|setTimeout|useEffect/, 'ni espera al feed, ni retardo, ni un efecto que llegue un commit tarde');
  assert.match(ask, /if \(firstAsk && !askedOnce && !interestsPromptSuspended\)/);
});

/**
 * The band is what lets the pull exist on a card that is not the first, and
 * the takeover on the first move is what keeps it from stealing the swipe to
 * the previous paper. Both have to stay wired, and the feed has to stop
 * scrolling the moment the gesture is ours.
 */
test('SOURCE: el tirón se decide en el primer movimiento y entonces detiene el feed', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  const start = src.slice(src.indexOf('const onStart = (event) => {'), src.indexOf('const onMove = (event) => {'));
  assert.match(start, /containerTop: el\.getBoundingClientRect\(\)\.top/, 'la franja se mide desde el borde del scroller');
  const move = src.slice(src.indexOf('const onMove = (event) => {'), src.indexOf('const onEnd = (event) => {'));
  assert.match(move, /if \(!pullTakesOver\(\{[\s\S]{0,200}\}\)\) \{\s*state\.phase = 'idle';/,
    'un primer movimiento hacia arriba suelta el gesto para el resto del arrastre');
  assert.ok(move.indexOf("state.phase = 'owning';") < move.indexOf('event.preventDefault()'),
    'primero se reclama el gesto, y sólo entonces se impide el scroll');
  assert.match(move, /if \(event\.cancelable\) event\.preventDefault\(\);/);
});
