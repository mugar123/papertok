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
  assert.match(move, /setPull\(\s*pullProgress\(/);
  assert.match(move, /pullTravelPx\(\{ startY: state\.startY, currentY: touch\.clientY \}\)/,
    'el recorrido resistido viaja con el progreso: es lo que siguen los papers');
  assert.doesNotMatch(move, /set(?!Pull\b)[A-Z]\w*\(/, 'ningún setState por evento de arrastre');
  const pull = src.slice(src.indexOf('const setPull = useCallback('), src.indexOf('const handleMouseMove'));
  assert.match(pull, /style\.setProperty\('--pull'/);
  assert.match(pull, /style\.setProperty\('--pull-y'/);
  // Un ATRIBUTO, no una clase: `className` en `.feed-wrapper` es un literal
  // del JSX, así que React lo reescribe entero en cada commit. Medido: la
  // clase de aterrizaje se ponía y la renderización que dispara el refresco
  // la borraba en el mismo fotograma.
  assert.match(pull, /wrapper\.setAttribute\('data-pull', progress > 0 \? 'pulling' : ''\);/);
  assert.doesNotMatch(pull, /classList/, 'una clase aquí no sobrevive al primer render');
  // `setAttribute`, no `dataset.x = …`: el lint del repo trata la asignación
  // sobre algo derivado de un ref como una mutación prohibida.
  assert.doesNotMatch(pull, /dataset\./);
  // Al envoltorio, no a la píldora: los papers también tienen que seguir al
  // dedo, y el envoltorio es el único ancestro que comparten.
  assert.match(pull, /const wrapper = feedRef\.current\?\.parentElement;/);
  assert.doesNotMatch(pull, /refreshPillRef/, 'escribirlo en la píldora no llega a las tarjetas');
});

/**
 * El tirón en móvil. Mientras esto sólo hacía crecer una píldora, el lector
 * arrastraba 110px y el mundo no se movía: el único gesto de manipulación
 * directa de toda la app no tenía nada bajo el pulgar salvo una insignia.
 */
test('SOURCE: al tirar, los papers vienen con el dedo y sin reloj de por medio', async () => {
  const css = strip(await read('./FeedContainer.css'));
  const at = css.indexOf(".feed-wrapper[data-pull='pulling'] .pc {");
  assert.ok(at > 0, 'la regla que arrastra las tarjetas sigue ahí');
  const carry = css.slice(at, css.indexOf('}', at));
  assert.match(carry, /transform: translateY\(var\(--pull-y\)\)/,
    '`transform`, no `translate`: el velo del refresco ya usa `translate` en este mismo elemento y los dos tienen que componerse');
  assert.doesNotMatch(carry, /translate:/, 'si el tirón pisa `translate`, el hundimiento del velo deja de existir');
  assert.match(carry, /transition: none/, 'un reloj entre el pulgar y el papel es retraso');
  // El release es CSS, así que sobrevive al re-render que trae el refresco.
  const card = strip(await read('./PaperCard.css'));
  assert.match(card, /transition:\s*opacity 0\.9s ease,\s*translate var\(--pc-travel\),\s*transform \d+ms var\(--ease-out-[a-z]+\)/,
    'la tarjeta sabe volver sola al soltar, y sin perder ni la opacidad ni el hundimiento');
  const pill = css.slice(css.indexOf(".feed-wrapper[data-pull='pulling'] .feed-refresh {"), css.indexOf('}', css.indexOf(".feed-wrapper[data-pull='pulling'] .feed-refresh {")));
  assert.match(pill, /translate: -50% calc\(-40px \+ [\d.]+ \* var\(--pull-y\)\)/,
    'la píldora va en el hueco que abren los papers, no en una distancia suya');
  assert.match(css, /\.feed-wrapper\[data-pull='pulling'\] \.feed-refresh-icon \{\s*rotate: calc\(var\(--pull\) \* 180deg\)/,
    'el icono gira con el tirón y entrega medio giro hecho al spinner');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.feed-wrapper\[data-pull='pulling'\] \.pc \{ transform: none; \}/);
  assert.match(reduced, /\.feed-wrapper\[data-pull='pulling'\] \.feed-refresh-icon \{ rotate: none; \}/);
});

/**
 * Soltar no es una sola cosa. Un tirón que no llega al umbral se CANCELA y la
 * goma devuelve todo con su muelle; uno que refresca ENTREGA, y lo que
 * entrega tiene que llegar sin que se vea el relevo.
 *
 * Sin esto, entre soltar y el commit de React la píldora se queda sin estado,
 * y sin estado su transición es la de marcharse: arranca hacia debajo de la
 * barra y la renderización siguiente la trae de vuelta. En un tirón rápido,
 * que suelta con la píldora a medio salir, eso es asomo + retroceso + tirón en
 * menos de 100ms. Medido con el aterrizaje puesto: opacidad 0,71 → 0,81 →
 * 0,98 → 1,00 y la y de 3,65 a 0, monótono, sin retroceso, y el fotograma en
 * que el atributo se va no se nota porque la pose es la misma.
 */
test('SOURCE: el tirón que refresca aterriza; el que no, vuelve con la goma', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  const end = src.slice(src.indexOf('const onEnd = (event) => {'), src.indexOf('const onCancel ='));
  assert.match(end, /if \(outcome === 'refresh' && !busy && !running\) \{\s*landPull\(\);\s*refresh\?\.\(\);\s*\} else \{\s*setPull\(0, 0\);\s*\}/,
    'las dos salidas son distintas a propósito: entregar y cancelar no significan lo mismo');
  const land = src.slice(src.indexOf('const landPull = useCallback('), src.indexOf('}, []);', src.indexOf('const landPull = useCallback(')));
  assert.match(land, /wrapper\.setAttribute\('data-pull', 'landing'\);/);
  assert.match(land, /clearTimeout\(pullLandingTimerRef\.current\);/, 'dos aterrizajes seguidos no se pisan el temporizador');
  assert.match(src, /useEffect\(\(\) => \(\) => clearTimeout\(pullLandingTimerRef\.current\), \[\]\);/,
    'ni queda vivo tras desmontar');

  const css = strip(await read('./FeedContainer.css'));
  const grab = (sel) => { const at = css.indexOf(sel); assert.ok(at > 0, `falta ${sel}`); return css.slice(at, css.indexOf('}', at)); };
  const landing = grab(".feed-wrapper[data-pull='landing'] .feed-refresh {");
  const visible = grab('.feed-refresh.is-visible,');
  // La pose de aterrizaje TIENE que ser la de trabajo, o al llegar React se
  // ve el salto que todo esto existe para quitar.
  for (const decl of ['opacity: 1', 'translate: -50% 0', 'scale: 1']) {
    assert.ok(landing.includes(decl), `el aterrizaje aterriza en la pose de trabajo (${decl})`);
    assert.ok(visible.includes(decl), `y es la misma que la de is-visible (${decl})`);
  }
  // Y con el reloj del velo, para que del pulgar al velo haya un movimiento.
  const dip = grab('.feed-container--refreshing {');
  const dipMs = /opacity (\d+)ms/.exec(dip)[1];
  assert.ok(landing.includes(`opacity ${dipMs}ms var(--ease-out-quad)`),
    `el aterrizaje corre el reloj del velo (${dipMs}ms), no uno suyo`);
  const cards = grab(".feed-wrapper[data-pull='landing'] .pc {");
  assert.match(cards, /transform: none/, 'los papers entran en el hundimiento del velo');
  assert.ok(cards.includes(`transform ${dipMs}ms var(--ease-out-quad)`),
    'y en el mismo reloj: con el muelle de la goma serían dos movimientos');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.feed-wrapper\[data-pull='landing'\] \.pc \{ transform: none; transition: none; \}/);
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
  assert.match(card, /transition:\s*opacity 0\.9s ease,\s*translate var\(--pc-travel\)/,
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
  assert.match(body, /AnimatePresence initial=\{false\}/, 'las caras se relevan; la primera no se anima al montar');
  assert.match(body, /refreshPhase === 'done'\s*\?\s*<Check/, 'al terminar, una marca, no la flecha girando');
  assert.match(body, /refreshing: 'Refreshing…', done: 'Updated', idle: 'Refresh'/);
  assert.match(body, /refreshing: 'Actualizando…', done: 'Actualizado', idle: 'Actualizar'/);
});

/**
 * El bug que Nicolás reportó el 12-09: al pulsar refresh el texto se iba a la
 * izquierda, volvía a la derecha, y al terminar se iba otra vez. La píldora
 * está centrada con `left: 50%` + `translate: -50%`, así que cualquier cambio
 * de ancho la re-centra en el mismo fotograma; el `layout` de framer que había
 * aquí compensaba la caja de la CARA pero no la del botón que la contiene, y
 * dos cajas moviéndose con una sola animada es justo ese tirón.
 *
 * La cura no es animar también la otra: es que el ancho no cambie.
 */
test('SOURCE: el ancho de la píldora no depende de qué cara lleve puesta', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  const at = src.indexOf("const refreshPhase = isRefreshing");
  const body = src.slice(at, src.indexOf('</button>', at));
  assert.match(body, /<span className="feed-refresh-gauge" aria-hidden="true">[\s\S]{0,320}Object\.values\(refreshLabels\)\.map/,
    'el medidor lleva LAS TRES etiquetas: con una sola, la caja vuelve a depender de cuál');
  assert.doesNotMatch(body, /layout=\{/, 'nada de morphear el ancho: el arreglo es que no cambie');
  assert.doesNotMatch(body, /position: 'absolute'/,
    'la cara que sale se apila en la rejilla; anclarla a left:0 era la mitad del tirón');
  const css = strip(await read('./FeedContainer.css'));
  const face = css.slice(css.indexOf('.feed-refresh-face {'), css.indexOf('}', css.indexOf('.feed-refresh-face {')));
  assert.match(face, /display: grid/);
  assert.match(face, /justify-items: center/, 'las caras se cruzan centradas, o vuelven a anclarse a un lado');
  assert.match(css, /\.feed-refresh-face > \* \{\s*grid-area: 1 \/ 1;/, 'todas en la misma celda');
  const gauge = css.slice(css.indexOf('.feed-refresh-gauge > * {'), css.indexOf('}', css.indexOf('.feed-refresh-gauge > * {')));
  assert.match(gauge, /visibility: hidden/);
  assert.doesNotMatch(gauge, /display: none/, 'lo que se necesita del medidor es que ocupe sitio');
});

/**
 * La salida, rehecha el mismo día. Iba en `ease-in` —la curva que gasta sus
 * primeros fotogramas casi sin moverse, justo cuando el lector acaba de leer
 * «Actualizado»— y sólo 18px, que no llegan a la barra: la píldora se
 * deshacía a medio aire en vez de meterse debajo.
 */
test('SOURCE: la píldora se retira bajo la barra, no se apaga en el aire', async () => {
  const css = strip(await read('./FeedContainer.css'));
  const rest = css.slice(css.indexOf('.feed-refresh {'), css.indexOf('}', css.indexOf('.feed-refresh {')));
  const up = Number(/translate: -50% -(\d+)px/.exec(rest)[1]);
  assert.ok(up >= 34, `el reposo está bajo la barra (${up}px): con menos, la píldora no llega y se deshace a la vista`);
  assert.doesNotMatch(rest, /ease-in[;,)\s]/, 'la salida no arranca lenta');
  const [, opMs, opDelay] = /opacity (\d+)ms (\d+)ms/.exec(rest);
  const travelMs = Number(/translate (\d+)ms/.exec(rest)[1]);
  assert.ok(Number(opDelay) > 0, 'la opacidad espera: si se apaga a la vez que sube, no se ve meterse debajo');
  assert.ok(Number(opMs) + Number(opDelay) <= travelMs, 'y termina dentro del recorrido, no después');
});

/**
 * La píldora se va SIEMPRE diciendo «Actualizado».
 *
 * Al terminar el beat la cara volvía al verbo, y ese cruce no informa de nada:
 * entre uno y otro no ha pasado nada. Con el dedo caía encima de la salida —el
 * texto cambiaba mientras la píldora se marchaba, reportado desde el móvil el
 * 12-09— y con el ratón quieto en la franja ocurría delante del lector, que
 * veía deshacerse la respuesta a lo que acababa de pedir (reportado el mismo
 * día). Ahora la cara se queda puesta hasta que la píldora está fuera de vista
 * y vuelve al verbo debajo de la barra, donde no se la ve.
 */
test('SOURCE: la cara no vuelve al verbo mientras la píldora se ve', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  assert.match(src, /const refreshPhase = isRefreshing \? 'refreshing' : \(refreshDone \|\| doneHold\) \? 'done' : 'idle';/,
    'la cola sostiene la cara, y sólo la cara');
  const hold = src.slice(src.indexOf('const pillOnScreen ='), src.indexOf('const handleOpenPdf'));
  assert.match(hold, /const pillOnScreen = refreshPillHover \|\| refreshPillFocused \|\| isRefreshing \|\| refreshDone;/,
    'las tres condiciones de is-visible MÁS el foco de teclado, que la saca por CSS sin pasar por el estado');
  assert.match(hold, /if \(!doneHold \|\| pillOnScreen\) return undefined;/,
    'mientras se la ve, la cara no cambia: la condición es un estado, no un flanco');
  assert.match(hold, /setTimeout\(\(\) => setDoneHold\(false\), PILL_EXIT_MS\)/);
  assert.match(hold, /return \(\) => clearTimeout\(t\);/,
    'si vuelve a asomar antes de que dispare, sigue siendo la misma visita');
  assert.match(src, /matches\(':focus-visible'\)/,
    'el foco que cuenta es el visible: un clic con el ratón también enfoca, y con `:focus` a secas la cara se quedaría clavada para siempre');
  assert.doesNotMatch(src, /pointer: coarse/,
    'y ya no depende del puntero: la píldora se va diciendo «Actualizado» con el dedo y con el ratón');
  // La cola tiene que cubrir la salida entera, o el texto cambia todavía a la
  // vista, que es exactamente lo reportado.
  const exitMs = Number(/const PILL_EXIT_MS = (\d+);/.exec(src)[1]);
  const css = strip(await read('./FeedContainer.css'));
  const rest = css.slice(css.indexOf('.feed-refresh {'), css.indexOf('}', css.indexOf('.feed-refresh {')));
  const travelMs = Number(/translate (\d+)ms/.exec(rest)[1]);
  assert.ok(exitMs >= travelMs, `la cola (${exitMs}ms) cubre el recorrido de salida (${travelMs}ms)`);
  // Y NO toca ni a `is-visible` ni a `is-done`: la píldora se va cuando se iba
  // y el acuse no se repite.
  assert.match(src, /refreshPillHover \|\| isRefreshing \|\| refreshDone \? ' is-visible'/,
    'la cola no retiene la píldora en pantalla');
  assert.match(src, /refreshDone && !isRefreshing \? ' is-done'/, 'ni repite el acuse');
});

/**
 * El morph de «Actualizando…» a «Actualizado», rehecho el 12-09 (Nicolás: «el
 * morph se ve sucio»). Las caras viven en la misma celda de rejilla y
 * `AnimatePresence` monta la nueva antes de desmontar la vieja, así que sin un
 * reparto explícito de relojes lo que hay en mitad del cambio son dos textos y
 * dos iconos superpuestos sobre catorce píxeles: la doble exposición que la
 * transición de página ya aprendió a no hacer.
 */
test('SOURCE: las caras de la píldora no se leen a la vez', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  const block = src.slice(src.indexOf('function refreshFaceMotion('), src.indexOf('const SCROLL_IDLE_DELAY_MS'));
  assert.ok(block.length > 0 && block.length < 2200, 'el relevo vive en una función suya');
  const out = Number(/const FACE_OUT_S = ([\d.]+);/.exec(src)[1]);
  const delay = Number(/const FACE_IN_DELAY_S = ([\d.]+);/.exec(src)[1]);
  assert.ok(delay > 0, 'la que llega espera a la que se va: sin retardo se leen las dos');
  assert.ok(delay < out,
    `y arranca antes de que aquella termine (${delay}s < ${out}s), o queda un fotograma de píldora vacía`);
  assert.equal((block.match(/delay: FACE_IN_DELAY_S/g) || []).length, 4,
    'las cuatro entradas esperan: reducida, muelle, opacidad del muelle y las otras dos caras');
  assert.doesNotMatch(block, /scale/,
    'la cara viaja y la píldora escala: dos escalas anidadas sobre texto de 0.8rem es lo que emborronaba el momento');
  assert.doesNotMatch(block, /\by: -?[\d.]/,
    'el recorrido va en la cadena de transform, no en el atajo: esto corre mientras el feed se remonta');
  assert.match(block, /transform: 'translateY\(-6px\)'/, 'la que se va sube');
  assert.match(block, /transform: 'translateY\(8px\)'/, 'y la que llega viene de abajo: un relevo, no un cruce');
  assert.doesNotMatch(src, /transition=\{faceMotion\.transition\}/,
    'cada cara declara su reloj; uno compartido vuelve a atar la salida a la entrada');
});

test('SOURCE: el beat de Actualizado deja sitio al crossfade de salida', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  const at = src.indexOf('wasRefreshingRef.current && !isRefreshing');
  assert.ok(at > 0, 'el efecto del beat sigue ahí');
  const beat = src.slice(at, at + 350);
  assert.match(beat, /prefersReducedMotion \? 500 : 1000/, '1s en motion pleno; 500ms si reduced');
  assert.match(beat, /setRefreshDone\(true\);\s*setDoneHold\(true\);/,
    'el beat arma la cola en el mismo sitio: son el mismo aterrizaje');
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
  assert.doesNotMatch(css, /feedRefreshSpinBreath|scale: 0\.86/,
    'el icono gira y ya: encogerlo al 86% dos veces por vuelta leía como un tic, no como progreso');
  const spin = css.slice(css.indexOf('.feed-refresh-icon--spinning {'), css.indexOf('}', css.indexOf('.feed-refresh-icon--spinning {')));
  assert.doesNotMatch(spin, /scale|zoom/, 'y nada de zoom por otra puerta');
  assert.match(spin, /animation: feedRefreshSpin [\d.]+s linear infinite;/, 'una sola animación, y lineal');
  const doneKf = css.slice(css.indexOf('@keyframes feedRefreshDone'), css.indexOf('100% { scale: 1; }', css.indexOf('@keyframes feedRefreshDone')));
  const peak = Number(/scale: ([\d.]+);/.exec(doneKf.slice(doneKf.indexOf('0% { scale: 1; }') + 16))[1]);
  assert.ok(peak > 1 && peak <= 1.06,
    `el acuse es un respiro (${peak}): un pop grande multiplica con la entrada de la cara que corre debajo`);
  assert.doesNotMatch(doneKf, /scale: 0\./,
    'y sin rebote por debajo de 1: encoger el texto después de crecerlo lee como un tic');
  const dip = css.slice(css.indexOf('.feed-container--refreshing {'), css.indexOf('}', css.indexOf('.feed-container--refreshing {')));
  const back = [...css.matchAll(/\.feed-container \{([^}]*)\}/g)]
    .map((m) => m[1]).find((b) => /transition:\s*opacity \d+ms/.test(b));
  const outMs = Number(/opacity (\d+)ms/.exec(back)[1]);
  const inMs = Number(/opacity (\d+)ms/.exec(dip)[1]);
  assert.ok(outMs >= 300, `vuelta más suave (${outMs}ms)`);
  assert.ok(inMs <= 200, `ida más rápida (${inMs}ms)`);
  const src = strip(await read('./FeedContainer.jsx'));
  assert.match(src, /phase === 'done'[\s\S]*?type: 'spring'/, 'Actualizado entra con muelle: es la respuesta y se le deja aterrizar');
  assert.match(src, /transform: \{ type: 'spring'[\s\S]*?opacity: \{ duration/,
    'el muelle lleva el recorrido y la opacidad va aparte: un rebote en el fundido lee como parpadeo');
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
