# «Para ti» responde al primer toque en el móvil — Auditoría y plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que en el móvil, estando en «Following», un solo toque en «For you» cambie el feed — y que la barra no vuelva a depender de que React reciba el `click` para que una pestaña navegue.

**Architecture:** La barra tiene tres pestañas y una sola asimetría de código: «Research» y «Following» son `NavLink` (un `<a href="#/…">`), y «For you» es un `<button>` que llama a `navigate('/')`. Si el `click` sintético de React no llega, el `<a>` navega igual porque el navegador sigue el `href` y el `HashRouter` escucha el hash; el `<button>` es un toque muerto. Esa asimetría coincide exactamente con el sentido que falla. El plan (1) captura la evidencia del propio móvil, porque Chromium con toques reales no reproduce el fallo, (2) quita la asimetría — «For you» pasa a ser `NavLink to="/" end` y las tres pestañas acusan la presión con `:active` sin pasar por React —, (3) deja una tarea condicionada a lo que diga la evidencia (la página que sale deja de re-renderizarse mientras se va), y (4) fija todo con un test de fuente y un modo `tap` de la sonda que toca con `Input.dispatchTouchEvent`, no con `.click()`.

**Tech Stack:** React 19.2, React Router 7.18 (`HashRouter useTransitions={false}`), framer-motion 12.40, Vite 8; tests con `node:test` (los componentes no se montan bajo node: tests de FUENTE); medición con `scripts/diagnostics/explorer-loading-probe.mjs` sobre Chromium headless por CDP; Safari Web Inspector desde el Mac para el iPhone.

**Spec:** Este documento, secciones «Diagnóstico» y «Lo que no está probado».

## Global Constraints

- Node 22 en CI: nada de APIs solo de Node 25. Tests con `node --test <fichero>`; la suite completa con `npm test`; antes del último commit, `npm run check`.
- Otra sesión de Claude puede estar editando el árbol principal: este plan se ejecuta en el worktree `.claude/worktrees/tabs-audit` (rama `worktree-tabs-audit`, creada el 05-09 desde `e4c7a00`). Ya tiene `.env.local` copiado y `node_modules` enlazado por symlink (las fuentes dan 403 en el dev server: es ruido conocido). Antes de cada commit, `git status --short` y `git add` solo de los ficheros de la tarea.
- `IS_DEMO = true` en `src/services/firebase.js` está volteado en ese worktree para medir: **nunca se commitea**; revertir con `git checkout HEAD -- src/services/firebase.js` antes de cualquier `git add`. (`accountWarmup.test.js` falla con él volteado.)
- Puertos: el Worker solo admite `localhost:5173/5174/5175` (wrangler.toml `ALLOWED_ORIGINS`); un origen fuera de la lista rompe la cadena de Following por CORS. Otro proceso tiene 5175; usar 5174 para el worktree (`.claude/launch.json` del árbol principal tiene las entradas `papertok-tabs-5174` — dev — y `papertok-tabs-preview-5174` — `vite preview` del build; borrarlas al terminar). Si un Chrome queda colgado en 9224: `pkill -f remote-debugging-port=9224`.
- Mensajes de commit en español, prefijo `fix(nav):` / `test(nav):` / `chore(diagnostics):`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Comentarios de código en inglés y que citen la medida (fecha, cifra), como el resto de `Navbar.jsx` y `main.jsx`.
- El frontend se despliega en Vercel al hacer push a `main`; el push se pide al usuario. El service worker es `autoUpdate` con `skipWaiting`/`clientsClaim`: un móvil recibe el build nuevo al reabrir la pestaña, no en la que ya tiene abierta.

## Diagnóstico (2026-09-05)

Síntoma reportado: en el móvil, de «For you» a «Following» basta un toque; de «Following» a «For you» hay que tocar varias veces «hasta que finalmente cambia el feed». En ordenador no ocurre.

### Verificado

1. **El arreglo anterior está en producción.** `https://papertok.app/assets/index-ClyhgGPE.js` (last-modified 2026-09-05 02:39 UTC) contiene `jsx(p,{useTransitions:!1,…})`: la navegación ya no es una transición de React (plan `2026-09-05-pestanas-sin-transicion.md`, commit `55fecef`). El síntoma nuevo es asimétrico; el que arregló ese commit era simétrico.
2. **La única asimetría de código de la barra es el elemento.** `src/components/Layout/Navbar.jsx:145-157`: «For you» es `<button type="button" onClick={() => { if (location.pathname !== '/') navigate('/'); setFeedMode('top'); }}>`; «Research» (`:159`) y «Following» (`:167`) son `<NavLink to=…>`. Un `NavLink` es un `<a href="#/following">`: si el `onClick` de React no corre, el navegador sigue el `href`, el hash cambia y `HashRouter` navega por `popstate`. Un `<button>` sin `onClick` no hace nada. `setFeedMode('top')` es un no-op: `feedMode` nace `'top'` (`FeedContext.jsx:232`) y nadie más lo cambia; `handleSetFeedMode` devuelve en `newMode === feedMode` (`:1634`).
3. **Nada tapa la barra desde Following.** `.navbar` es `position: fixed; z-index: var(--z-nav)` (100). El veil del feed (`.feed-empty--veil`) es `absolute; inset: 0; z-index: 2` dentro de `.feed-wrapper` (`position: relative`, `margin-top: var(--nav-total)`): no alcanza la barra. Los `position: fixed` de `PaperCard.css` son hojas y modales que no están montados. `RouteFallback` es `fixed; inset: 0` pero solo existe mientras un chunk perezoso suspende, y `/` no es perezosa. En cada estado sondeado, `document.elementFromPoint` en el centro del botón devolvió el propio botón.
4. **Nada devuelve la ruta a `/following`.** Los únicos `navigate('/following')` no existen; los `navigate('/')` son botones. Ningún contexto ni servicio llama a `useNavigate`. No hay bucles de `replaceState` (Safari corta a 100 llamadas por 30 s): los únicos `replace: true` son login, onboarding y listas.
5. **No hay «primer toque = hover» de WebKit posible por código.** Ningún `onMouseEnter/Move/Over` ni `pointerenter/move` en la cadena de la barra; todos los `:hover` de `Navbar.css`, `global.css` y el feed viven bajo `@media (hover: hover) and (pointer: fine)`. Sin `whileHover`/`whileTap` de framer en la barra.
6. **Chromium con toques reales no reproduce el fallo.** Sonda propia (`Input.dispatchTouchEvent`, emulación 390×844 táctil, perfil limpio, demo) — no `.click()`, que salta el hit-testing y era lo que medía la sonda `tabswitch`:

| Escenario | Toque en «For you» desde Following | `click` llega al `<button>` | `pushState('#/')` | Primer frame con `#/` y filete en «For you» | Sale la página vieja | Monta For you |
|---|---|---|---|---|---|---|
| Dev build, CPU normal, Following = veil+esqueleto (1 seguimiento) | ciclo 1 | +97 ms (touchend +95) | +98 ms | +122 ms | +126 ms | +293 ms |
| Ídem, ciclo 2 | | +71 ms | +71 ms | +93 ms | +101 ms | +266 ms |
| Build de producción, CPU ×4, 14 seguimientos, Following con 37 tarjetas y la cadena aún cargando | 420 ms tras entrar | +111 ms | +111 ms | +141 ms | +155 ms | (título de For you presente a los 3,5 s) |
| Ídem, 2,5 s tras entrar, 34 tarjetas + esqueleto | | +75 ms | +75 ms | +220 ms (tarea larga de 148 ms: el manejador síncrono re-renderiza la página que sale) | +227 ms | ídem |

Seis toques, cero perdidos, cero revertidos, ningún retraso de segundos. El sentido contrario cuesta más (el manejador de «Following» tarda 155–162 ms en un CPU de escritorio porque la página que sale, For you, lleva 15 tarjetas), y aun así el usuario lo describe como el que funciona.

### Lo que no está probado

El mecanismo exacto en el móvil del usuario. Este Mac no tiene Xcode (sin simulador iOS) y Safari de escritorio no acepta `safaridriver` sin activar «Permitir automatización remota» en Ajustes → Avanzado (se intentó: `session not created`). Quedan cuatro candidatos, casi todos de la tubería táctil de WebKit, y cada uno se distingue en el móvil en un minuto:

| Candidato | Qué pasa | Cómo se distingue en el móvil | Qué lo arregla |
|---|---|---|---|
| **C-A. El `click` de React no llega al `<button>`** (pero un `<a>` habría navegado por su `href`) | Toque muerto: ni filete ni URL | El filete NO se mueve; «Research» desde Following SÍ cambia al primer toque | Tarea 1 (el href de respaldo) |
| **C-B. WebKit se come el toque entero** (un scroll que considera en curso: tras deslizar tarjetas, o el rebote del documento en el estado vacío) | Nada recibe el toque | El filete NO se mueve; «Research» TAMPOCO; el «me gusta» de una tarjeta tampoco justo tras deslizar; esperar 3 s quieto lo cura | Otro plan (asentar el snap); la Tarea 1 no basta |
| **C-C. La navegación ocurre y el relevo tarda** (la página que sale se re-renderiza con cada entrega de la cadena de Following, y For you monta detrás de una pantalla en blanco) | Filete y URL cambian al primer toque; el contenido tarda >1 s | El filete SÍ se mueve y la URL pasa a `#/` al primer toque; el feed llega tarde | Tarea 2 |
| **C-D. El toque nunca llega al elemento** (la fila de pestañas se alinea a la derecha: «For you» es la más a la izquierda y tiene una franja de barra muerta a su lado, y mide ~30 px de alto en una barra de 52) | El dedo cae fuera del enlace y no pasa nada | La pestaña NO se oscurece al presionarla; fallar hacia «Following» (la más a la derecha) golpea a un vecino y sí da respuesta | Otro plan: agrandar el área táctil, no el `href` |

La Tarea 1 no cubre C-D, y `elementFromPoint` en el CENTRO del enlace —lo que
comprobó «Verificado 3»— no puede verlo. Lo que sí lo separa de todo lo demás
es el `:active` que esa misma tarea añadió: si la pestaña no se oscurece, el
dedo nunca tocó el elemento (C-D, o la barra de Safari reexpandiéndose junto al
borde superior); si se oscurece y no navega, el toque llegó y se perdió la
navegación.

La Tarea 0 obtiene esta evidencia. Las Tareas 1 y 3 no dependen de ella (quitan la asimetría y fijan la regresión pase lo que pase); la Tarea 2 sí.

## Decisiones de diseño

- **Quitar la asimetría, no parchearla.** «For you» pasa a `NavLink to="/" end`, igual que sus dos hermanas: mismo elemento, mismo `aria-current` automático, y el `href="#/"` como red si React no llega. `setFeedMode('top')` sigue en su `onClick` (React Router ejecuta el `onClick` del usuario antes del suyo y solo navega si no hay `preventDefault`), sin coste y sin cambiar `FeedContext`.
- **La pestaña acusa la presión sin React.** `.navbar-link:active { opacity: 0.55 }` con `transition: opacity 0.12s`: la misma receta que ya usan el nombre de autor, el chip de tema y la insignia de proyecto de la tarjeta (`paperCardPress.test.js`). En el móvil no hay hover, y el filete solo se mueve cuando el router ha confirmado. Es también diagnóstico: si la pestaña se oscurece y nada más pasa, el toque llegó al elemento y se perdió después.
- **Sin subrayado optimista.** Ya se descartó el 05-09: acusaría el toque y dejaría la espera intacta.
- **Nada especulativo sin evidencia.** La Tarea 2 lleva su condición de entrada escrita; no se ejecuta si la Tarea 0 no la activa.

## Fuera del alcance (y por qué)

- Sustituir `AnimatePresence mode="wait"` por un cruce simultáneo de páginas: cambia el diseño del relevo que el 03-09 y el 05-09 midieron y eligieron a propósito. Si la Tarea 0 dice C-C y la Tarea 2 no basta, es un plan aparte.
- Asentar el snap de `.feed-container` (C-B): sin evidencia de que el toque se pierda ahí, tocar `scroll-snap-stop`/`overflow-anchor` es adivinar.

## Mapa de ficheros

- Modify: `src/components/Layout/Navbar.jsx:145-157` — el botón «For you» pasa a `NavLink`.
- Modify: `src/components/Layout/Navbar.css:198-233` — `:active` y la transición de opacidad en `.navbar-link`.
- Create: `src/components/Layout/navbarTabs.test.js` — test de fuente: tres `NavLink`, sin `<button>` en la fila, y la presión en CSS.
- Modify (condicional): `src/components/Following/FollowingFeedPage.jsx:63-76` — la página que sale no vuelve a rankear.
- Create (condicional): `src/components/Following/followingFeedPageExit.test.js`.
- Modify: `scripts/diagnostics/explorer-loading-probe.mjs` — modo `tap`.
- Create: `scripts/diagnostics/safari-tabs-probe.mjs` — la misma secuencia en WebKit de escritorio por `safaridriver`.
- Modify: `scripts/diagnostics/README.md` — documentar ambos.

---

### Task 0: Evidencia del móvil (5 minutos, la hace el usuario)

**Files:** ninguno. Produce evidencia que decide la Tarea 2.

**Interfaces:**
- Produces: un JSON de `__tapReport()` o las respuestas al cuestionario, pegados en el hilo.

- [ ] **Step 1: Confirmar el build que corre el móvil**

En el iPhone: cerrar del todo la pestaña de Safari (o la app instalada en la pantalla de inicio: deslizarla fuera del selector de apps), esperar 10 s, volver a abrir `https://papertok.app`. El service worker instala el build nuevo al abrir y recarga.

- [ ] **Step 2: Cuestionario (sin cable)**

Repetir tres veces el gesto (For you → Following → esperar a que Following esté pintado → For you) y anotar:

1. Al presionar «For you», ¿se oscurece la pestaña bajo el dedo, en el momento?
   (sí/no) — es la pregunta que más separa: distingue «el dedo no tocó el
   enlace» de «lo tocó y se perdió la navegación».
2. Al primer toque en «For you», ¿se mueve el filete amarillo bajo «For you»? (sí/no)
3. ¿Cambia la URL de Safari? (`papertok.app/#/` en vez de `#/following`) (sí/no; en la app instalada no hay barra: saltar)
4. Desde Following, ¿«Research» cambia al primer toque? (sí/no)
5. Justo después de deslizar una tarjeta en Following, ¿el «me gusta» de la tarjeta responde al primer toque? (sí/no)
6. ¿Ocurre igual si esperas 3 s quieto en Following antes de tocar «For you»? (sí/no)
7. ¿Safari o la app instalada en la pantalla de inicio? ¿Modelo de iPhone y versión de iOS?

Lectura: 1=no → C-D (o el borde superior de Safari reexpandiéndose; ver el párrafo tras la tabla). 1=sí y 2=no y 4=sí → C-A (Tarea 1 lo cubre). 1=sí y 2=no y 4=no (y 5=no, 6=sí) → C-B (abrir plan aparte; Tarea 1 y 3 se hacen igual). 2=sí → C-C (activar Tarea 2).

- [ ] **Step 3: Captura con Web Inspector (con cable, opcional pero concluyente)**

En el iPhone: Ajustes → Safari → Avanzado → Inspector web: activar. Conectar por USB al Mac. En Safari del Mac: menú Desarrollo → *nombre del iPhone* → la pestaña de papertok.app. En la consola, pegar y ejecutar:

```js
(() => {
  const ev = []; const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const desc = (el) => el && el.tagName ? el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ').slice(0, 2).join('.') + '[' + (el.textContent || '').trim().slice(0, 12) + ']' : String(el);
  ['touchstart', 'touchend', 'touchcancel', 'pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click'].forEach((type) => {
    document.addEventListener(type, (e) => { const p = e.changedTouches ? e.changedTouches[0] : e; ev.push({ t: now(), type, on: desc(e.target), x: Math.round(p?.clientX ?? -1), y: Math.round(p?.clientY ?? -1) }); }, true);
  });
  const ps = history.pushState.bind(history); history.pushState = (s, t, u) => { ev.push({ t: now(), type: 'pushState', url: String(u) }); return ps(s, t, u); };
  window.addEventListener('hashchange', () => ev.push({ t: now(), type: 'hashchange', hash: location.hash }));
  const fr = []; let last = '';
  const tick = () => {
    const pages = [...document.querySelectorAll('#main-content > div')].map((p) => Number(getComputedStyle(p).opacity).toFixed(2) + '/' + p.getAttribute('data-nav-direction')).join('|');
    const s = { hash: location.hash, tab: (document.querySelector('.navbar-link.active')?.textContent || '').trim(), pages, cards: document.querySelectorAll('.feed-snap-item').length, title: (document.querySelector('.pc-title')?.textContent || '').trim().slice(0, 20), veil: !!document.querySelector('.feed-empty--veil'), empty: !!document.querySelector('.ff-empty') };
    const k = JSON.stringify(s); if (k !== last) { last = k; fr.push({ t: now(), ...s }); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__tapReport = () => JSON.stringify({ ua: navigator.userAgent, standalone: !!navigator.standalone, build: (document.querySelector('script[src*="/assets/index-"]')?.src || '').split('/').pop(), events: ev, frames: fr });
  return 'listo: haz el gesto y luego escribe __tapReport()';
})();
```

Hacer el gesto en el iPhone (Following → varios toques en «For you» hasta que cambie), volver a la consola, escribir `__tapReport()` y pegar el resultado en el hilo. Lectura: cada toque debe producir `touchstart, touchend, click on a.navbar-link[For you], pushState #/` (un ANCLA desde la Tarea 1; si sale `button.…`, el móvil sigue con el build viejo — cerrar la pestaña del todo y reabrir). Un toque cuyo `touchstart` cae con `on` distinto de la pestaña, o que no aparece, es C-D: el dedo no tocó el enlace. Un `touchstart`/`touchend` sobre la pestaña y sin `click` detrás es C-B. `click` + `pushState` y un `frames` donde `cards`/`title` de For you tardan más de un segundo es C-C.

---

### Task 1: «For you» es un enlace como sus hermanas, y las tres acusan la presión

**Files:**
- Modify: `src/components/Layout/Navbar.jsx:145-157`
- Modify: `src/components/Layout/Navbar.css:198-233`
- Create: `src/components/Layout/navbarTabs.test.js`

**Interfaces:**
- Consumes: `NavLink` de `react-router-dom` (ya importado en `Navbar.jsx`), `setFeedMode` de `useFeed()` (ya desestructurado), `isHomeActive`/`feedMode`/`isEnglish` (ya en el componente).
- Produces: en la fila `.navbar-links`, tres `<NavLink>` con `to="/"` (+`end`), `to="/research"`, `to="/following"`; regla `.navbar-link:active`; `opacity 0.12s ease-out` en la `transition` de `.navbar-link`.

- [ ] **Step 1: Escribir el test de fuente, que falla**

Crear `src/components/Layout/navbarTabs.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripJsComments = (source) => source.replace(/\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
const stripCssComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * SOURCE tests: the bar is JSX, which node cannot mount.
 *
 * On the phone, going from Following to For you took several taps (2026-09-05)
 * while the other way took one. The only asymmetry in the bar was the
 * element: Research and Following were NavLinks — an <a href="#/…"> — and
 * For you was a <button> calling navigate('/'). When React's click does not
 * run, an anchor still navigates (the browser follows the href and the
 * HashRouter hears the hash); a button does nothing. The three tabs are the
 * same element now, so the fallback is the same for all of them.
 */
function linksRow(jsx) {
  const start = jsx.indexOf('className="navbar-links"');
  const end = jsx.indexOf('className="navbar-right"');
  assert.ok(start > 0 && end > start, 'the links row and the right-hand actions must both be in Navbar.jsx');
  return jsx.slice(start, end);
}

test('SOURCE: the three tabs are NavLinks, For you included, so a lost click still navigates through the href', async () => {
  const row = linksRow(stripJsComments(await read('./Navbar.jsx')));
  const navLinks = row.match(/<NavLink\b/g) || [];
  assert.equal(navLinks.length, 3, 'exactly three NavLinks in the links row');
  assert.match(row, /<NavLink\s+to="\/"\s+end\b/, 'For you must be a NavLink to "/" with `end`, or it would match every route');
  assert.match(row, /<NavLink\s+to="\/research"/, 'Research stays a NavLink');
  assert.match(row, /<NavLink\s+to="\/following"/, 'Following stays a NavLink');
  assert.doesNotMatch(row, /<button\b/, 'no <button> in the links row: a button has no href to fall back on');
  assert.doesNotMatch(row, /navigate\(/, 'the tabs must not navigate by hand: the NavLink does, and the href is the fallback');
});

test('SOURCE: For you still keeps the feed in its default mode when tapped', async () => {
  const row = linksRow(stripJsComments(await read('./Navbar.jsx')));
  const forYou = row.match(/<NavLink\s+to="\/"[\s\S]*?<\/NavLink>/);
  assert.ok(forYou, 'the For you NavLink is present');
  assert.match(forYou[0], /onClick=\{\(\) => setFeedMode\('top'\)\}/, 'the mode reset rides on the NavLink onClick (React Router runs it before its own)');
});

/**
 * A press is answered by the element itself. On a phone there is no hover
 * and the underline waits for the router; the dip is the same recipe the
 * card's author name uses (paperCardPress.test.js), and it needs `opacity`
 * in the transition list or the dip snaps.
 */
test('SOURCE: a tab dips while pressed, on the compositor, without React', async () => {
  const css = stripCssComments(await read('./Navbar.css'));
  assert.match(css, /\.navbar-link:active \{\s*opacity: 0\.55;\s*\}/, 'the press dip is missing');
  const base = css.match(/^\.navbar-link \{([\s\S]*?)\n\}/m);
  assert.ok(base, 'the .navbar-link base rule exists');
  const transition = base[1].match(/transition:([^;]*);/);
  assert.ok(transition, '.navbar-link declares a transition');
  assert.match(transition[1], /opacity 0\.12s ease-out/, 'opacity must be in the transition list');
  assert.match(transition[1], /background var\(--transition-fast\)/, 'the background fade must survive (transition is a shorthand)');
  assert.match(transition[1], /color var\(--transition-fast\)/, 'the colour fade must survive (transition is a shorthand)');
});
```

- [ ] **Step 2: Comprobar que falla**

Run: `node --test src/components/Layout/navbarTabs.test.js`
Expected: FAIL en los tres tests («exactly three NavLinks» cuenta 2; «press dip is missing»).

- [ ] **Step 3: El botón pasa a NavLink**

En `src/components/Layout/Navbar.jsx`, sustituir el bloque:

```jsx
          <button
            type="button"
            className={`navbar-link ${isHomeActive && feedMode === 'top' ? 'active' : ''}`}
            aria-current={isHomeActive && feedMode === 'top' ? 'page' : undefined}
            onClick={() => {
              if (location.pathname !== '/') navigate('/');
              setFeedMode('top');
            }}
          >
            <Layers size={15} aria-hidden="true" />
            {isEnglish ? 'For you' : 'Para ti'}
          </button>
```

por

```jsx
          {/* A NavLink like its two siblings, not a <button> that calls
              navigate('/'). On the phone (2026-09-05) the tap from Following
              to here needed several tries while the other way took one, and
              the element was the only asymmetry in the bar: an anchor still
              navigates when React's click never runs — the browser follows
              the href and the HashRouter hears the hash — a button does
              nothing. `end`, or "/" would match every route. React Router
              runs this onClick before its own and navigates unless it was
              defaultPrevented, so the mode reset rides along unchanged. */}
          <NavLink
            to="/"
            end
            className={`navbar-link ${isHomeActive && feedMode === 'top' ? 'active' : ''}`}
            onClick={() => setFeedMode('top')}
          >
            <Layers size={15} aria-hidden="true" />
            {isEnglish ? 'For you' : 'Para ti'}
          </NavLink>
```

`navigate` y `location` siguen en uso (marca y avatar): no tocar los imports.

- [ ] **Step 4: La presión en CSS**

En `src/components/Layout/Navbar.css`, en la regla base `.navbar-link`, sustituir

```css
  transition: background var(--transition-fast), color var(--transition-fast);
}
```

por

```css
  transition: background var(--transition-fast), color var(--transition-fast), opacity 0.12s ease-out;
}
```

y añadir, justo después del bloque `.navbar-link.active { … }` (antes del comentario «The travelling rule»):

```css
/* The press, answered by the element before React runs. On a phone the hover
   above never fires — it sits behind (hover: hover) — and the underline only
   moves once the router has committed, which on the Following → For you tap
   was 93–220 ms after touchend even in Chromium (2026-09-05, mobile
   emulation, CPU ×4 on the slow end). The dip is the card's own recipe
   (.pc-author-link:active); `opacity` in the transition list above is what
   keeps it from snapping. */
.navbar-link:active {
  opacity: 0.55;
}
```

- [ ] **Step 5: Comprobar que pasa, con los tests vecinos**

Run: `node --test src/components/Layout/navbarTabs.test.js src/components/Layout/navbarChrome.test.js src/accessibilityStructure.test.js`
Expected: todos `ok`. (`navbarChrome` comprueba la `line-height` compartida de `.navbar-link`, que no cambia; `accessibilityStructure` lee la barra.)

Run: `npm run lint`
Expected: sin errores (`navigate` sigue usado por la marca y el avatar; si ESLint marcase `location` sin usar, es que el `if (location.pathname !== '/')` de la marca también se tocó — no debe).

- [ ] **Step 6: Comprobación en el navegador (Chromium, toques reales)**

Con el build de producción del worktree servido en 5174 (`npm run build` en el worktree y la entrada `papertok-tabs-preview-5174`), y tras la Tarea 3 si ya está hecha:

Run: `ORIGIN=http://localhost:5174 node scripts/diagnostics/explorer-loading-probe.mjs tap '#/' demo,mobile,slow=4,follows=many,cycles=2`
Expected: en cada «Following -> For you» la lista de eventos lleva `click` sobre `a.navbar-link[For you]` (ya no `button.…`) seguido de `pushState #/` en el mismo milisegundo; `elementFromPoint` = el propio enlace; salida antes de los 300 ms. Si la Tarea 3 aún no existe, usar la sonda de la sesión de auditoría (`scratchpad/touch-tabs-probe.mjs`) con los mismos flags.

Además, con la sonda o el pane a 390 px: tocar «For you» y comprobar `getComputedStyle(link).opacity` durante la presión — con `Input.dispatchTouchEvent touchStart` sin `touchEnd`, leer la opacidad: `0.55`.

- [ ] **Step 7: Commit**

```bash
git status --short
git checkout HEAD -- src/services/firebase.js
git add src/components/Layout/Navbar.jsx src/components/Layout/Navbar.css src/components/Layout/navbarTabs.test.js
git commit -m "fix(nav): «Para ti» es un enlace como sus hermanas, y las tres acusan la presión

En el móvil, de Following a Para ti hacían falta varios toques y al revés
uno. La única asimetría de la barra era el elemento: Research y Following
son NavLink (un <a href>) y Para ti era un <button> con navigate('/').
Cuando el click de React no llega, un <a> navega igual porque el navegador
sigue el href y el HashRouter escucha el hash; un <button> no hace nada.
Las tres pestañas son ahora el mismo elemento, y acusan la presión con
:active sin pasar por React, que en el móvil es lo único que responde
antes de que el router confirme.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2 (condicional: solo si la Tarea 0 da C-C): la página que sale deja de rankear mientras se va

**Condición de entrada:** en el móvil, al primer toque el filete se mueve y la URL cambia, y el feed de For you tarda más de ~1 s en aparecer. Si la Tarea 0 da C-A o C-B, **saltar esta tarea** y anotarlo en el hilo.

**Files:**
- Modify: `src/components/Following/FollowingFeedPage.jsx:63-76`
- Create: `src/components/Following/followingFeedPageExit.test.js`

**Interfaces:**
- Consumes: `useIsPresent` de `framer-motion` (la página vive dentro del `PageTransition` que `AnimatePresence` mantiene montado mientras sale; `PresenceContext` llega a todo el subárbol).
- Produces: `FollowingFeedPage` ignora nuevas entregas de `items` cuando `useIsPresent()` es `false`.

- [ ] **Step 1: Escribir el test de fuente, que falla**

Crear `src/components/Following/followingFeedPageExit.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

/**
 * SOURCE test: the page is JSX and node cannot mount it.
 *
 * AnimatePresence keeps the leaving page mounted through its exit, and the
 * page stays subscribed to FollowingUpdatesContext — so a delivery from the
 * refresh chain that lands during the 140 ms exit re-ranks and re-renders
 * the cards that are fading out. On a phone that render is what the next
 * page waits behind. A page that is no longer present keeps the order it
 * left with; the next mount resumes it anyway (`resumeOrderedPapers`).
 */
test('SOURCE: a FollowingFeedPage on its way out ignores new deliveries', async () => {
  const code = stripComments(await read('./FollowingFeedPage.jsx'));
  assert.match(code, /import \{[^}]*\buseIsPresent\b[^}]*\} from 'framer-motion'/, 'useIsPresent must come from framer-motion');
  assert.match(code, /const isPresent = useIsPresent\(\);/, 'the page reads its own presence');
  const effect = code.match(/useEffect\(\(\) => \{\s*if \(!isPresent\) return;\s*if \(lastItemsRef\.current === items\) return;[\s\S]*?\}, \[isPresent, items, seenIds\]\);/);
  assert.ok(effect, 'the items effect bails out first when the page is leaving, and lists isPresent in its deps');
});
```

- [ ] **Step 2: Comprobar que falla**

Run: `node --test src/components/Following/followingFeedPageExit.test.js`
Expected: FAIL («useIsPresent must come from framer-motion»).

- [ ] **Step 3: Implementar**

En `src/components/Following/FollowingFeedPage.jsx`, añadir el import:

```js
import { useIsPresent } from 'framer-motion';
```

y sustituir

```jsx
  const [orderedPapers, setOrderedPapers] = useState(() => resumeOrderedPapers(lastOrder, items, seenIds));
  const lastItemsRef = useRef(items);
  useEffect(() => {
    if (lastItemsRef.current === items) return;
    lastItemsRef.current = items;
    setOrderedPapers(current => mergeOrderedPapers(current, orderFollowingFeedPapers(items, seenIds)));
  }, [items, seenIds]);
```

por

```jsx
  const [orderedPapers, setOrderedPapers] = useState(() => resumeOrderedPapers(lastOrder, items, seenIds));
  const lastItemsRef = useRef(items);
  // Whether this page is still the one on screen. AnimatePresence keeps a
  // leaving page mounted through its exit, and this page stays subscribed to
  // the refresh chain — a delivery landing during the 140 ms exit re-ranked
  // and re-rendered the cards that were fading out, and on a phone that
  // render is what the next page waits behind (2026-09-05). A page on its
  // way out keeps the order it leaves with; the next mount resumes it.
  const isPresent = useIsPresent();
  useEffect(() => {
    if (!isPresent) return;
    if (lastItemsRef.current === items) return;
    lastItemsRef.current = items;
    setOrderedPapers(current => mergeOrderedPapers(current, orderFollowingFeedPapers(items, seenIds)));
  }, [isPresent, items, seenIds]);
```

- [ ] **Step 4: Comprobar que pasa, con los tests de Following**

Run: `node --test src/components/Following/followingFeedPageExit.test.js src/context/followingProgress.test.js src/utils/followingFeed.test.js`
Expected: todos `ok`.

Run: `npm run lint`
Expected: sin errores.

- [ ] **Step 5: Medir**

Run: `ORIGIN=http://localhost:5174 node scripts/diagnostics/explorer-loading-probe.mjs tap '#/' demo,mobile,slow=4,follows=many,at=2500,cycles=2`
Expected: en «Following -> For you», ninguna tarea larga entre la salida (opacidad de la página vieja bajando) y el montaje de For you atribuible a un re-render de Following; el montaje de For you (`cards` cambia y `title` deja de ser el de Following) por debajo de 400 ms tras el toque a CPU ×4 (antes de esta tarea: comparar con el run previo, misma máquina, mismos flags).

- [ ] **Step 6: Commit**

```bash
git status --short
git checkout HEAD -- src/services/firebase.js
git add src/components/Following/FollowingFeedPage.jsx src/components/Following/followingFeedPageExit.test.js
git commit -m "fix(following): la página que sale ya no vuelve a rankear mientras se va

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: La sonda toca con el dedo — modo `tap`, y la misma secuencia en WebKit de escritorio

**Files:**
- Modify: `scripts/diagnostics/explorer-loading-probe.mjs` (añadir el modo después del bloque `if (mode === 'tabswitch') { … }`, y la línea de uso en la cabecera)
- Create: `scripts/diagnostics/safari-tabs-probe.mjs`
- Modify: `scripts/diagnostics/README.md`

**Interfaces:**
- Consumes: `cdp`, `pollUntil`, `sleep`, `url`, `extra` del propio script (ya definidos arriba del bloque de modos).
- Produces: `node scripts/diagnostics/explorer-loading-probe.mjs tap '#/' demo,mobile[,slow=<rate>][,follows=many][,at=<ms>][,until=<cards>][,cycles=<n>][,mouse]`; sale con código 1 si un toque no cambia el hash o la salida no arranca en 400 ms.

- [ ] **Step 1: La línea de uso**

En la cabecera de `scripts/diagnostics/explorer-loading-probe.mjs`, tras la línea `//        node probe.mjs swipe '#/' [mobile,slow,n=<swipes>]`, añadir:

```js
//        node probe.mjs tap '#/' demo,mobile[,slow=<rate>,follows=many,at=<ms>,until=<cards>,cycles=<n>,mouse]
```

- [ ] **Step 2: El modo**

Justo después del cierre del bloque `if (mode === 'tabswitch') { … }`, añadir:

```js
  if (mode === 'tap') {
    // The tab bar under a REAL tap: `Input.dispatchTouchEvent`, so the gesture
    // recogniser, hit-testing and click synthesis all run as on a phone —
    // `element.click()` (the `tabswitch` mode) skips all three and can never
    // see a tap that another layer eats or a click React never receives.
    // Every touch/pointer/mouse/click event that reaches the document is
    // logged in the capture phase, with pushState and hashchange, and the
    // pages are sampled per frame through the handover. Both directions,
    // `cycles` times. `follows=many` seeds fourteen follows so Following has
    // cards and a chain still landing; `at=<ms>` taps For you that soon after
    // Following; `until=<cards>` waits for that many cards first; `slow=<rate>`
    // throttles the CPU; `mouse` is the desktop control. Exit code 1 when a
    // tap does not change the hash, or the outgoing page has not started to
    // leave 400 ms after touchend.
    const flags = new Set((extra || '').split(',').filter(Boolean));
    const num = (name, dflt) => { const f = [...flags].find((x) => x.startsWith(name + '=')); return f ? Number(f.slice(name.length + 1)) : dflt; };
    const cycles = num('cycles', 2);
    const atMs = num('at', 0);
    const untilCards = num('until', 0);
    const slowRate = num('slow', flags.has('slow') ? 4 : 0);
    const useMouse = flags.has('mouse');
    const manyFollows = [
      ['A5056895519', 'Markus Göker'], ['A5089245822', 'Joshua Adkins'], ['A5006191066', 'Scott Baker'], ['A5005196385', 'Matthew Monroe'], ['A5023982706', 'Richard Smith'],
      ['A5085384361', 'Mary Lipton'], ['A5075235007', 'Weijun Qian'], ['A5022928420', 'Samuel Purvine'], ['A5050316172', 'William R Schafer'], ['A5058699536', 'Sebastian Funk'],
    ].map(([id, name]) => ({ type: 'author', id, canonicalId: id, name, source: 'openalex' })).concat([
      { type: 'institution', id: 'I4210108322', canonicalId: 'I4210108322', name: 'National Institute for Fusion Science', source: 'openalex' },
      { type: 'institution', id: 'I1294671590', canonicalId: 'I1294671590', name: 'CNRS', source: 'openalex' },
      { type: 'institution', id: 'I142606810', canonicalId: 'I142606810', name: 'Pacific Northwest National Laboratory', source: 'openalex' },
      { type: 'topic', id: 'cs.AI', canonicalId: 'cs.AI', name: 'Artificial Intelligence', source: 'arxiv' },
    ]);
    const follows = JSON.stringify(flags.has('follows=many') ? manyFollows : [{ type: 'author', id: 'A5006398227', name: 'Probe author', source: 'openalex' }]);
    if (flags.has('demo')) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { try { localStorage.setItem('papertok_user', JSON.stringify({ uid: 'probe-demo', email: 'probe@example.com', displayName: 'Probe' })); localStorage.setItem('papertok_onboardingComplete', 'true'); localStorage.setItem('papertok_selectedCategories', JSON.stringify(['quant-ph', 'cond-mat.mtrl-sci', 'cs.AI'])); localStorage.setItem('papertok_following_probe-demo', ${JSON.stringify(follows)}); } catch {} })();` });
    }
    if (flags.has('mobile')) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    if (slowRate > 0) await cdp.send('Emulation.setCPUThrottlingRate', { rate: slowRate });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      window.__ev = [];
      const desc = (el) => { if (!el || !el.tagName) return String(el && el.nodeName); const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : ''; const txt = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 16); return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (txt ? '[' + txt + ']' : ''); };
      const push = (o) => window.__ev.push({ t: Math.round(performance.now()), ...o });
      for (const type of ['touchstart', 'touchend', 'touchcancel', 'pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click']) {
        document.addEventListener(type, (e) => { const p = e.changedTouches ? e.changedTouches[0] : e; push({ type, target: desc(e.target), x: Math.round(p?.clientX ?? -1), y: Math.round(p?.clientY ?? -1), dp: e.defaultPrevented }); }, true);
      }
      window.addEventListener('hashchange', () => push({ type: 'hashchange', hash: location.hash }));
      const ps = history.pushState.bind(history); history.pushState = (s, t, u) => { push({ type: 'pushState', url: String(u) }); return ps(s, t, u); };
      window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true }); } catch {}
      window.__fr = []; window.__frOn = false;
      const op = (el) => el ? Number(getComputedStyle(el).opacity).toFixed(2) : null;
      const tf = (el) => el ? getComputedStyle(el).transform.replace('matrix(1, 0, 0, 1, ', 't(') : null;
      const tick = () => {
        if (window.__frOn) {
          const pages = [...document.querySelectorAll('#main-content > div')];
          const rule = document.querySelector('.navbar-link-rule');
          window.__fr.push({ t: Math.round(performance.now()), hash: location.hash, pages: pages.map((p) => op(p) + '@' + tf(p) + ' d=' + p.getAttribute('data-nav-direction')).join(' | '), active: (document.querySelector('.navbar-link.active')?.textContent || '').trim(), rule: rule ? tf(rule) : null, cards: document.querySelectorAll('.feed-snap-item').length, title: (document.querySelector('.pc-title')?.textContent || '').trim().slice(0, 28), veil: !!document.querySelector('.feed-empty--veil'), empty: !!document.querySelector('.ff-empty'), sk: document.querySelectorAll('.sk').length });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })();` });
    await cdp.send('Page.navigate', { url });
    console.log('feed ready:', await pollUntil(cdp, "document.querySelectorAll('.pc-sheet').length > 0", 40000, 100));
    await sleep(flags.has('late') ? 6000 : 1500);
    const FOR_YOU = "[...document.querySelectorAll('.navbar-link')].find((l) => /For you|Para ti/.test(l.textContent))";
    const FOLLOWING = "document.querySelector('.navbar-link[href=\"#/following\"]')";
    let failures = 0;
    const tap = async (label, expr) => {
      const box = await cdp.eval(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const h = document.elementFromPoint(x, y); return { x, y, w: Math.round(r.width), h: Math.round(r.height), hit: h ? h.tagName.toLowerCase() + '.' + String(h.className).split(' ').slice(0, 2).join('.') : null, hitIsTarget: h === el || (h && el.contains(h)) }; })()`);
      if (!box) { console.log(`\n## ${label}: TARGET NOT FOUND`); failures += 1; return null; }
      const evStart = await cdp.eval('window.__ev.length');
      await cdp.eval('window.__fr = []; window.__frOn = true; true');
      const t0 = await cdp.eval('Math.round(performance.now())');
      if (useMouse) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        await sleep(40);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      } else {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y, radiusX: 4, radiusY: 4, force: 1 }] });
        await sleep(60);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      return { label, box, evStart, t0 };
    };
    const report = async (info, waitMs, expectHash) => {
      if (!info) return;
      await sleep(waitMs);
      const r = await cdp.eval(`(() => { window.__frOn = false; const t0 = ${info.t0}; const ev = window.__ev.slice(${info.evStart}).map((e) => ({ ...e, t: e.t - t0 })); const fr = window.__fr; const changes = []; let last = ''; for (const x of fr) { const k = JSON.stringify([x.hash, x.pages, x.active, x.rule, x.cards > 0, x.title, x.veil, x.empty, x.sk]); if (k !== last) { last = k; changes.push({ ...x, t: x.t - t0 }); } } const longTasks = window.__lt.filter((e) => e.t >= t0 - 50 && e.t <= t0 + ${waitMs}).map((e) => ({ at: e.t - t0, d: e.d })); return { hash: location.hash, events: ev, longTasks, changes: changes.slice(0, 30) }; })()`);
      const touchEnd = r.events.find((e) => e.type === (useMouse ? 'mouseup' : 'touchend'));
      const click = r.events.find((e) => e.type === 'click');
      const push = r.events.find((e) => e.type === 'pushState' || e.type === 'hashchange');
      const first = r.changes.find((c) => c.hash === expectHash);
      const exit = r.changes.find((c) => c.hash === expectHash && /^0\.9[0-8]|^0\.[0-8]/.test(c.pages));
      const verdict = { hash: r.hash, clickOn: click?.target ?? null, clickAt: click?.t ?? null, pushAt: push?.t ?? null, firstNewFrameAt: first?.t ?? null, exitStartAt: exit?.t ?? null, longTasks: r.longTasks };
      const ok = r.hash === expectHash && exit && touchEnd && exit.t - touchEnd.t <= 400;
      if (!ok) failures += 1;
      console.log(`\n## ${info.label}  tap@(${Math.round(info.box.x)},${Math.round(info.box.y)}) target ${info.box.w}x${info.box.h} elementFromPoint=${info.box.hit} hitIsTarget=${info.box.hitIsTarget}  ${ok ? 'OK' : 'FAIL'}`);
      console.log('verdict:', JSON.stringify(verdict));
      console.log('events:', JSON.stringify(r.events));
      console.log('frames:', JSON.stringify(r.changes, null, 0).replace(/\},\{/g, '},\n{'));
    };
    for (let cycle = 1; cycle <= cycles; cycle++) {
      const a = await tap(`cycle ${cycle}: For you -> Following`, FOLLOWING);
      if (untilCards > 0) {
        await pollUntil(cdp, `document.querySelectorAll('.feed-snap-item').length >= ${untilCards}`, 25000, 50);
        await report(a, 0, '#/following');
      } else if (atMs > 0) {
        await sleep(atMs);
        await report(a, 0, '#/following');
      } else {
        await report(a, 2500, '#/following');
      }
      const b = await tap(`cycle ${cycle}: Following -> For you`, FOR_YOU);
      await report(b, 3500, '#/');
    }
    console.log(`\n${failures === 0 ? 'ALL TAPS OK' : failures + ' TAP(S) FAILED'}`);
    process.exitCode = failures === 0 ? 0 : 1;
  }
```

- [ ] **Step 3: Correr el modo contra el build de producción del worktree**

Con `papertok-tabs-preview-5174` arriba (`npm run build` antes, en el worktree):

Run: `ORIGIN=http://localhost:5174 node scripts/diagnostics/explorer-loading-probe.mjs tap '#/' demo,mobile,slow=4,follows=many,at=2500,cycles=2`
Expected: `ALL TAPS OK`, código de salida 0; en cada «Following -> For you», `clickOn` = `a.navbar-link[For you]` (tras la Tarea 1) y `pushAt` = `clickAt`.

Run: `ORIGIN=http://localhost:5174 node scripts/diagnostics/explorer-loading-probe.mjs tap '#/' demo,mobile,mouse,cycles=1`
Expected: `ALL TAPS OK` (el control de escritorio).

- [ ] **Step 4: La secuencia en WebKit de escritorio**

Crear `scripts/diagnostics/safari-tabs-probe.mjs`:

```js
// The tab-bar sequence in desktop Safari (WebKit) through safaridriver's
// WebDriver endpoint: seed the demo session, For you -> Following -> For you
// with real WebDriver clicks, and the per-frame samples of the handover.
// Needs Safari → Settings → Advanced → "Allow remote automation" (once).
// usage: ORIGIN=http://localhost:5174 node scripts/diagnostics/safari-tabs-probe.mjs
import { spawn } from 'node:child_process';

const ORIGIN = process.env.ORIGIN || 'http://localhost:5174';
const PORT = Number(process.env.SD_PORT || 4445);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const driver = spawn('/System/Cryptexes/App/usr/bin/safaridriver', ['-p', String(PORT)], { stdio: 'ignore' });
process.on('exit', () => { try { driver.kill(); } catch {} });
await sleep(1200);

const base = `http://127.0.0.1:${PORT}`;
async function wd(method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${j.value.error}: ${j.value.message}`);
  return j.value;
}

let session;
try {
  session = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
} catch (e) {
  console.log('safaridriver session failed:', e.message);
  process.exit(2);
}
const sid = session.sessionId;
const S = (p) => `/session/${sid}${p}`;
const exec = (script, args = []) => wd('POST', S('/execute/sync'), { script, args });

const FOLLOWS = JSON.stringify([
  ['A5056895519', 'Markus Göker'], ['A5089245822', 'Joshua Adkins'], ['A5006191066', 'Scott Baker'], ['A5005196385', 'Matthew Monroe'], ['A5023982706', 'Richard Smith'],
].map(([id, name]) => ({ type: 'author', id, canonicalId: id, name, source: 'openalex' })));

await wd('POST', S('/url'), { url: `${ORIGIN}/blank-for-seed.html` });
await sleep(500);
await exec(`try { localStorage.setItem('papertok_user', JSON.stringify({ uid: 'probe-demo', email: 'probe@example.com', displayName: 'Probe' })); localStorage.setItem('papertok_onboardingComplete', 'true'); localStorage.setItem('papertok_selectedCategories', JSON.stringify(['quant-ph', 'cond-mat.mtrl-sci', 'cs.AI'])); localStorage.setItem('papertok_following_probe-demo', ${JSON.stringify(FOLLOWS)}); } catch (e) { return String(e); } return 'seeded';`);
await wd('POST', S('/url'), { url: `${ORIGIN}/#/` });

const INSTRUMENT = `
  window.__ev = [];
  const desc = (el) => { if (!el || !el.tagName) return String(el && el.nodeName); const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : ''; const txt = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 16); return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (txt ? '[' + txt + ']' : ''); };
  const push = (o) => window.__ev.push({ t: Math.round(performance.now()), ...o });
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
    document.addEventListener(type, (e) => { push({ type, target: desc(e.target), dp: e.defaultPrevented }); }, true);
  }
  const ps = history.pushState.bind(history); history.pushState = (s, t, u) => { push({ type: 'pushState', url: String(u) }); return ps(s, t, u); };
  window.__fr = []; window.__frOn = false;
  const op = (el) => el ? Number(getComputedStyle(el).opacity).toFixed(2) : null;
  const tick = () => { if (window.__frOn) { const pages = [...document.querySelectorAll('#main-content > div')]; window.__fr.push({ t: Math.round(performance.now()), hash: location.hash, pages: pages.map((p) => op(p) + ' d=' + p.getAttribute('data-nav-direction')).join(' | '), active: (document.querySelector('.navbar-link.active')?.textContent || '').trim(), cards: document.querySelectorAll('.feed-snap-item').length, title: (document.querySelector('.pc-title')?.textContent || '').trim().slice(0, 28) }); } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return 'instrumented';`;

const poll = async (expr, timeoutMs) => { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { if (await exec(`return ${expr};`)) return true; await sleep(150); } return false; };
console.log('feed ready:', await poll("document.querySelectorAll('.pc-sheet').length > 0", 40000), 'ua:', (await exec('return navigator.userAgent;')).slice(0, 80));
await exec(INSTRUMENT);
await sleep(1500);

async function clickAndReport(label, selectorScript, waitMs = 3000) {
  const el = await exec(`return ${selectorScript};`);
  const ref = el && (el['element-6066-11e4-a52e-4f735466cecf'] || el.ELEMENT);
  if (!ref) { console.log(`\n## ${label}: element not found`); return; }
  const evStart = await exec('return window.__ev.length;');
  await exec('window.__fr = []; window.__frOn = true; return true;');
  const t0 = await exec('return Math.round(performance.now());');
  await wd('POST', S(`/element/${ref}/click`));
  await sleep(waitMs);
  const r = await exec(`window.__frOn = false; const t0 = arguments[0]; const ev = window.__ev.slice(arguments[1]).map((e) => ({ ...e, t: e.t - t0 })); const fr = window.__fr; const changes = []; let last = ''; for (const x of fr) { const k = JSON.stringify([x.hash, x.pages, x.active, x.cards > 0, x.title]); if (k !== last) { last = k; changes.push({ ...x, t: x.t - t0 }); } } return { hash: location.hash, active: (document.querySelector('.navbar-link.active')?.textContent || '').trim(), title: (document.querySelector('.pc-title')?.textContent || '').trim().slice(0, 40), events: ev, changes: changes.slice(0, 12) };`, [t0, evStart]);
  console.log(`\n## ${label}`);
  console.log('events:', JSON.stringify(r.events));
  console.log('after:', JSON.stringify({ hash: r.hash, active: r.active, title: r.title }));
  console.log('frames:', JSON.stringify(r.changes, null, 0).replace(/\},\{/g, '},\n{'));
}

for (let cycle = 1; cycle <= 2; cycle++) {
  await clickAndReport(`cycle ${cycle}: For you -> Following (Safari click)`, "document.querySelector('.navbar-link[href=\"#/following\"]')");
  await clickAndReport(`cycle ${cycle}: Following -> For you (Safari click)`, "[...document.querySelectorAll('.navbar-link')].find((l) => /For you|Para ti/.test(l.textContent))");
}
await wd('DELETE', S(''));
process.exit(0);
```

Run: `node --check scripts/diagnostics/safari-tabs-probe.mjs`
Expected: sin salida (sintaxis válida). Si el usuario activa «Permitir automatización remota», `ORIGIN=http://localhost:5174 node scripts/diagnostics/safari-tabs-probe.mjs` debe imprimir `feed ready: true` y, en cada «Following -> For you», `click` sobre `a.navbar-link[For you]` seguido de `pushState #/`. Sin la opción, sale con código 2 y el mensaje de safaridriver: no es un fallo del script.

- [ ] **Step 5: README**

En `scripts/diagnostics/README.md`, al final de la sección de `explorer-loading-probe.mjs`, añadir:

```markdown
```bash
node scripts/diagnostics/explorer-loading-probe.mjs tap '#/' demo,mobile,slow=4,follows=many,at=2500,cycles=2
node scripts/diagnostics/explorer-loading-probe.mjs tap '#/' demo,mobile,mouse
```

`tap` (2026-09-05) presses the tab bar with `Input.dispatchTouchEvent` — the
gesture recogniser, hit-testing and click synthesis run as on a phone, which
`tabswitch`'s `element.click()` skips — For you → Following → For you,
`cycles` times, and logs every touch/pointer/mouse/click event that reaches the
document, `pushState`, and the pages per frame. `follows=many` seeds fourteen
follows so Following has cards and a chain still landing; `at=<ms>` taps For
you that soon after entering Following; `until=<cards>` waits for that many
cards first; `slow=<rate>` throttles the CPU; `mouse` is the desktop control.
Exit code 1 when a tap leaves the hash unchanged or the outgoing page has not
started to leave 400 ms after touchend. Needs `IS_DEMO = true` flipped locally
(never committed) and a server on a Worker-allowed origin (5173/5174/5175).

`safari-tabs-probe.mjs` runs the same sequence in desktop Safari through
`safaridriver` (WebKit, mouse clicks): enable Safari → Settings → Advanced →
"Allow remote automation" once, then `ORIGIN=http://localhost:5174 node
scripts/diagnostics/safari-tabs-probe.mjs`. It seeds the demo session through
`localStorage` on a first load and reads the same event log.
```

- [ ] **Step 6: Lint y commit**

Run: `npm run lint`
Expected: sin errores (los scripts de `scripts/diagnostics` no entran en ESLint; comprobar con `node --check` ambos ficheros).

```bash
git status --short
git checkout HEAD -- src/services/firebase.js
git add scripts/diagnostics/explorer-loading-probe.mjs scripts/diagnostics/safari-tabs-probe.mjs scripts/diagnostics/README.md
git commit -m "chore(diagnostics): la sonda toca la barra con el dedo, y la misma secuencia en WebKit de escritorio

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Comprobación completa, entrega y verificación en el móvil

**Files:** ninguno nuevo. Produce evidencia y el despliegue.

- [ ] **Step 1: Suite y comprobación de entrega**

Run: `git checkout HEAD -- src/services/firebase.js` y después `npm run check`
Expected: secretos, lint, tests (todos `ok`, ninguno `cancelled`), build y dry-run del Worker en verde. Volver a voltear `IS_DEMO` solo si hace falta medir más.

- [ ] **Step 2: Entrega**

Presentar al usuario las opciones de cierre de rama (fusionar en `main`, PR, o dejarla). El push publica en Vercel: solo con su confirmación. Borrar las entradas `papertok-tabs-5174` y `papertok-tabs-preview-5174` de `.claude/launch.json` del árbol principal.

- [ ] **Step 3: En el móvil, tras el despliegue**

Cerrar del todo la pestaña (o la app instalada), esperar 10 s, abrir `https://papertok.app`. Cinco ciclos For you → Following → (esperar a ver Following pintado) → For you.

Expected: 5/5 ciclos, un solo toque en «For you» cambia el feed; la pestaña se oscurece al presionarla (`:active`) en cada toque. Si un ciclo falla: pegar el cuestionario de la Tarea 0 (o `__tapReport()`), que ahora distingue C-B de C-C sin ambigüedad porque C-A ya no existe.

---

## Plan de verificación (qué protege cada pieza, y contra qué)

| Pieza | Protege | Cómo se ejecuta | Umbral |
|---|---|---|---|
| `navbarTabs.test.js` (Tarea 1) | Que una pestaña vuelva a ser un `<button>` sin `href`, o que `navigate(` vuelva a la fila; que la presión pierda su transición | `npm test` (CI, Node 22) | Falla el test |
| `followingFeedPageExit.test.js` (Tarea 2, si se hace) | Que la página saliente vuelva a suscribirse a las entregas | `npm test` | Falla el test |
| `tap` (Tarea 3) | Un toque real que no navega, o una salida que no arranca | Manual, antes de cada cambio en la barra, el router o `PageTransition`: `tap '#/' demo,mobile,slow=4,follows=many,at=2500,cycles=2` y `tap '#/' demo,mobile,mouse` | Código de salida 0; `pushAt` = `clickAt`; `exitStartAt − touchend ≤ 400 ms` |
| `tabswitch` (ya existe) | El relevo medido fotograma a fotograma (salida, montaje, entrada) | `tabswitch '#/' demo,mobile,slow,late` | Salida < 40 ms a ×4; monta < 350 ms (tabla del plan del 05-09) |
| `safari-tabs-probe.mjs` (Tarea 3) | El mismo relevo en WebKit de escritorio | Manual, con «Permitir automatización remota» | `click` en `a.navbar-link[For you]` + `pushState #/` |
| Cuestionario / `__tapReport()` (Tarea 0 y 4) | Lo que ningún Chromium puede ver: la tubería táctil de iOS | El usuario, antes (diagnóstico) y después (5/5) del despliegue | 5/5 ciclos con un toque |
| `routerTransitions.test.js` (ya existe) | Que la navegación vuelva a ser una transición | `npm test` | Falla el test |

Cuándo repetir el `tap`: cualquier cambio en `Navbar.jsx`, `Navbar.css`, `App.jsx` (Routes/AnimatePresence), `PageTransition.jsx`, `main.jsx` (router) o `FeedContainer.jsx` (capas). Cuándo repetir el móvil: cualquier despliegue que toque la barra.

## Autorevisión

- **Cobertura del diagnóstico:** la asimetría (Verificado 2) la quita la Tarea 1; el mecanismo no probado lo mide la Tarea 0 y lo cubre la Tarea 2 (C-C) o un plan aparte (C-B); la sonda que no veía toques reales (Verificado 6) la sustituye la Tarea 3.
- **Sin marcadores vacíos:** cada paso lleva el código, el comando y lo esperado; la Tarea 2 lleva su condición de entrada escrita.
- **Consistencia:** el test de la Tarea 1 y el JSX de la Tarea 1 usan el mismo `onClick={() => setFeedMode('top')}`; el test de la Tarea 2 y su efecto usan `[isPresent, items, seenIds]`; el modo `tap` y el README usan los mismos flags (`demo,mobile,slow=<rate>,follows=many,at=<ms>,until=<cards>,cycles=<n>,mouse`).
