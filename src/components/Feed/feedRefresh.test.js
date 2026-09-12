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
  assert.match(start, /containerTop: box\.top,\s*containerHeight: box\.height,/, 'la franja se mide desde el borde del scroller y escala con su alto');
  const move = src.slice(src.indexOf('const onMove = (event) => {'), src.indexOf('const onEnd = (event) => {'));
  assert.match(move, /if \(!pullTakesOver\(\{[\s\S]{0,200}\}\)\) \{\s*state\.phase = 'idle';/,
    'un primer movimiento hacia arriba suelta el gesto para el resto del arrastre');
  assert.ok(move.indexOf("state.phase = 'owning';") < move.indexOf('event.preventDefault()'),
    'primero se reclama el gesto, y sólo entonces se impide el scroll');
  assert.match(move, /if \(event\.cancelable\) event\.preventDefault\(\);/);
});

/**
 * The refresh reads as a handover, not a cut. Measured 2026-09-12 before it:
 * the card count went 12 → 4 and the paper changed outright at 498ms, with
 * the long frames of mounting a new feed in plain sight.
 *
 * Reworked the same day. 0.4 turned out to be a dimmer and not a cover — the
 * words still read through it, so the swap happened where the eye could
 * follow it — and opacity alone read as the screen blinking. What has not
 * changed is the one thing no rule here may move: the scroller.
 */
test('SOURCE: el feed se cubre mientras se refresca, y el scroller sigue quieto', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  assert.match(src, /className=\{`feed-container\$\{isRefreshing \? ' feed-container--refreshing' : ''\}`\}/);
  const css = strip(await read('./FeedContainer.css'));
  const dip = css.slice(css.indexOf('.feed-container--refreshing {'), css.indexOf('}', css.indexOf('.feed-container--refreshing {')));
  const cover = Number(/opacity: (0?\.\d+)/.exec(dip)[1]);
  assert.ok(cover <= 0.25, `el velo tapa de verdad (${cover}): a 0.4 el título y el abstract se seguían leyendo`);
  assert.doesNotMatch(dip, /transform|translate|scale|height|filter/,
    'nada que toque la geometría: debajo hay un scroll-snap que medir');
  assert.doesNotMatch(dip, /ease-in[;,)\s]/,
    'la ida no arranca lenta: el clic acaba de ocurrir y es justo el momento que se está mirando');
  const sinkAt = css.indexOf('.feed-container--refreshing .pc {');
  const sink = css.slice(sinkAt, css.indexOf('}', sinkAt));
  assert.match(sink, /translate: 0 10px/, 'el recorrido va en la tarjeta, que se hunde por donde llegó');
  const card = strip(await read('./PaperCard.css'));
  assert.match(card, /@keyframes cardSlideUp \{\s*0% \{ transform: translateY\(10px\); \}/,
    'y son los mismos 10px, o deja de ser su entrada al revés');
  assert.match(card, /transition: opacity 0\.9s ease, translate var\(--pc-travel\)/,
    'la tarjeta sabe deslizar, y sin perder su propia transición de opacidad');
  const back = [...css.matchAll(/\.feed-container \{([^}]*)\}/g)]
    .map((m) => m[1]).find((b) => /transition:\s*opacity \d+ms/.test(b));
  const outMs = Number(/opacity (\d+)ms/.exec(back)[1]);
  const inMs = Number(/opacity (\d+)ms/.exec(dip)[1]);
  assert.ok(outMs > inMs, `la vuelta (${outMs}ms) es más lenta que la ida (${inMs}ms): llega, no aparece de golpe`);
  assert.match(back, /opacity \d+ms \d+ms/,
    'y espera antes de empezar: montar el feed nuevo cuesta fotogramas de 90-173ms que van bajo el velo');
  // Un solo reloj por sentido, o son dos llegadas y no una: medido antes de
  // esto, la tarjeta estaba en casa a 134ms con el velo todavía subiendo a 400.
  const clock = (decl) => /transition: opacity ([^;]+)/.exec(decl)[1].replace('opacity ', '');
  assert.equal(/--pc-travel: ([^;]+);/.exec(card)[1], clock(back),
    'la subida de la tarjeta corre el mismo reloj que la vuelta del velo');
  assert.equal(/--pc-travel: ([^;]+);/.exec(sink)[1], clock(dip),
    'y el hundimiento, el mismo que la ida');
  assert.doesNotMatch(clock(back), /expo/,
    'nada de expo en la vuelta: 0.20 → 0.83 en 67ms y luego 250ms arrastrando el último sexto es, medido, un corte con buen perfil');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.feed-container--refreshing \.pc \{ translate: none; \}/,
    'con movimiento reducido se va el recorrido');
  assert.doesNotMatch(reduced, /\.feed-container[^{]*\{[^}]*opacity: 1/,
    'pero el velo se queda: sin él, esta preferencia es la única que sigue viendo el corte');
});

test('SOURCE: la píldora dice qué está haciendo en cada uno de sus tres estados', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  const at = src.indexOf("const refreshPhase = isRefreshing");
  assert.ok(at > 0, 'la píldora sigue tipando sus tres caras');
  const body = src.slice(at, src.indexOf('</button>', at));
  assert.match(body, /AnimatePresence initial=\{false\}/, 'las caras se cruzan, no se cortan');
  assert.match(body, /position: 'absolute'/, 'la cara que sale no colapsa el ancho de la píldora');
  assert.match(body, /refreshPhase === 'done'\s*\?\s*<Check/, 'al terminar, una marca, no la flecha girando');
  assert.match(body, /refreshing: 'Refreshing…', done: 'Updated', idle: 'Refresh'/);
  assert.match(body, /refreshing: 'Actualizando…', done: 'Actualizado', idle: 'Actualizar'/);
  assert.match(body, /layout=\{!prefersReducedMotion\}/, 'el ancho de la píldora morphéa con el texto');
});

test('SOURCE: el beat de Actualizado deja sitio al crossfade de salida', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  const at = src.indexOf('wasRefreshingRef.current && !isRefreshing');
  assert.ok(at > 0, 'el efecto del beat sigue ahí');
  const beat = src.slice(at, at + 350);
  assert.match(beat, /prefersReducedMotion \? 500 : 1000/, '1s en motion pleno; 500ms si reduced');
  assert.match(src, /refreshDone && !isRefreshing \? ' is-done'/,
    'is-done no se mezcla con el spinner; no hace falta setState al empezar');
});

test('SOURCE: la píldora no asoma solo porque el cursor ya estaba en la franja', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  assert.match(src, /refreshHoverLockedRef = useRef\(true\)/, 'el hover nace cerrado');
  const hover = src.slice(src.indexOf('const handleMouseMove = useCallback('), src.indexOf('}, [handleMouseMove, publicMode]);'));
  assert.match(hover, /refreshHoverLockedRef\.current/, 'mientras está cerrado, la franja no enciende la píldora');
  assert.match(hover, /refreshHoverLockedRef\.current = false/, 'sólo se abre al salir de la franja');
  assert.match(hover, /wrapper\.contains\(t\)\) return/, 'un pointerdown fuera del feed (sheet/modal) vuelve a cerrarlo');
});

test('SOURCE: la píldora trabaja sin halo, y el aterrizaje conserva su spring', async () => {
  const css = strip(await read('./FeedContainer.css'));
  assert.match(css, /\.feed-refresh\.is-refreshing \{[^}]*translate: -50% 0/,
    'mientras corre sigue plantada bajo la barra');
  assert.doesNotMatch(css, /feedRefreshWorking|box-shadow[^;]*accent/,
    'sin glow: el spinner ya dice que trabaja, y el halo se pintaba encima de los papers del lector');
  assert.doesNotMatch(css, /\.feed-refresh\.is-refreshing \{[^}]*animation:/,
    'y sin latido propio: lo que se mueve durante la espera es el entorno');
  assert.match(css, /@keyframes feedRefreshSpinBreath/, 'el spinner respira, no sólo gira');
  assert.match(css, /@keyframes feedRefreshDone[\s\S]*scale: 1\.12/, 'el done hace un pop claro');
  const dip = css.slice(css.indexOf('.feed-container--refreshing {'), css.indexOf('}', css.indexOf('.feed-container--refreshing {')));
  const back = [...css.matchAll(/\.feed-container \{([^}]*)\}/g)]
    .map((m) => m[1]).find((b) => /transition:\s*opacity \d+ms/.test(b));
  const outMs = Number(/opacity (\d+)ms/.exec(back)[1]);
  const inMs = Number(/opacity (\d+)ms/.exec(dip)[1]);
  assert.ok(outMs >= 300, `vuelta más suave (${outMs}ms)`);
  assert.ok(inMs <= 200, `ida más rápida (${inMs}ms)`);
  const src = strip(await read('./FeedContainer.jsx'));
  assert.match(src, /refreshPhase === 'done'[\s\S]*type: 'spring'/, 'Actualizado entra con spring');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.feed-refresh-icon--spinning \{ animation: none; \}/, 'reduced para el spinner');
});

/**
 * The other half of the refresh's environment. From the seventh card a smooth
 * scroll to the top travels seven viewport-heights of the papers the reader is
 * about to lose, at an opacity where they are still legible — a second
 * movement to read on top of the one the dip is already making. Taken under
 * the cover, the same trip costs nothing.
 */
test('SOURCE: el refresco salta arriba bajo el velo, no viaja a la vista', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  const dipMs = Number(/const REFRESH_DIP_MS = (\d+);/.exec(src)[1]);
  const css = strip(await read('./FeedContainer.css'));
  const dip = css.slice(css.indexOf('.feed-container--refreshing {'), css.indexOf('}', css.indexOf('.feed-container--refreshing {')));
  assert.equal(dipMs, Number(/opacity (\d+)ms/.exec(dip)[1]),
    'el JS espera exactamente lo que la hoja tarda en bajar el velo');
  const start = src.indexOf('refreshJumpOwedRef.current = true;');
  assert.ok(start > 0, 'el salto sigue colgando de isRefreshing');
  const jump = src.slice(src.lastIndexOf('useEffect(() => {', start), src.indexOf('}, [isRefreshing]);', start));
  assert.match(jump, /setTimeout\([\s\S]{0,160}REFRESH_DIP_MS\)/, 'espera a que el velo esté abajo');
  assert.match(jump, /scrollTo\(\{ top: 0, behavior: 'auto' \}\)/);
  assert.doesNotMatch(jump, /'smooth'/, 'nunca suave: ese viaje es justo lo que se quitó');
  assert.match(jump, /return \(\) => clearTimeout\(t\);/, 'el temporizador no sobrevive al refresco');
  // Un refresco de caché caliente puede acabar antes que el velo: el salto se
  // debe igual, o el lector se queda en la tarjeta de la que pidió irse.
  const owed = jump.slice(0, jump.indexOf('refreshJumpOwedRef.current = true;'));
  assert.match(owed, /if \(!isRefreshing\)/, 'la rama de "ya terminó" va primero');
  assert.match(owed, /if \(refreshJumpOwedRef\.current\)[\s\S]{0,200}scrollTo\(\{ top: 0/,
    'si el temporizador no llegó a disparar, el salto se cobra ahí');
  assert.match(owed, /refreshJumpOwedRef\.current = false;/, 'y se cobra una sola vez');
});

