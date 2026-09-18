# Rediseño de la landing — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que `papertok.app/` sea la landing B («Highlighter», once tramos, sin snap) para quien no tiene sesión, y que quien la tiene —o llega por un enlace profundo `#/…`— vaya a la app en `/feed` sin ver nada por medio; accesible en móvil según WCAG 2.2 AA.

**Architecture:** la landing es `index.html` en la raíz, prerenderizada por el plugin `papertok-landing-prerender` desde plantillas de cadena (`src/landing/page.js`, sin JSX) y con un único script de movimiento (`src/landing/motion.js`, IIFE sin imports). La app pasa a `app.html` y se sirve en `/feed` (rewrite de Vercel; middleware en dev y preview) conservando la clave `index` del input de Rollup, de la que depende el precache del service worker. Un script en línea en la cabeza de la landing decide **antes de pintar**: hash `#/…` → `/feed` + hash; marca `papertok_signed_in` en localStorage (la escribe `AuthContext` al iniciar sesión y la borra al cerrarla) → `/feed`. La barra, los botones y el pie se comparten con la página de privacidad por `src/legal/static-page.css`.

**Tech Stack:** Vite 7 multi-entrada (`build.rollupOptions.input`), `vite-plugin-pwa`/workbox (sin tocar sus reglas), JS de navegador sin dependencias, CSS plano con los tokens de `src/styles/variables.css`, `node --test`, Chrome headless por CDP para sondas y capturas, `axe-core` como devDependency para la auditoría automática.

**Spec:** `docs/superpowers/specs/2026-09-17-landing-rediseno-design.md` (léela entera antes de la tarea 5). Lienzo con los tableros y los prototipos de movimiento: https://claude.ai/artifact/LMHhtB46VtsUy8t66eZiye

## Global Constraints

- La clave del input de Rollup para la app **debe seguir siendo `index`** (el SW precachea `assets/index-*.js` y `assets/index-*.css` por nombre; `vite.config.js:103-111`).
- Ningún fichero de `src/landing/` importa `global.css` (arrastra Tailwind y la capa base).
- `page.js` es JavaScript plano con plantillas de cadena; **no JSX**. `motion.js` es una IIFE sin `import`.
- Nada en la landing carga de hosts externos (fuentes por Fontsource, ya en el build).
- Curva única para todo movimiento: `--ease-out-cubic` = `cubic-bezier(0.33, 1, 0.68, 1)` (`variables.css:272`). Duraciones: mazo 400 ms; mapa 320 ms + escalonado 70 ms; subrayado 480 ms; hover 150 ms.
- Amarillo `--brand-yellow` solo como fondo de `.lp-hero` y del botón del cierre; `.lp-hl` exactamente tres veces; `text-transform: uppercase` solo dentro de `.lp-paper`, `.lp-plate`, `.lp-research`.
- Sin `scroll-snap`, sin `preventDefault` sobre `wheel`, sin `<img>`/`<figure class="lp-figure">`.
- Todo control alcanzable con teclado, foco visible (`outline: 2px solid var(--focus-ring); outline-offset: 2px`), objetivos táctiles ≥ 44×44 px en pantallas < 700 px, `lang="en"` en el documento y `lang="es"` en los nombres en español.
- Cada tarea termina con `node --test <sus tests>` en verde, `npm run build` sin errores (con `VITE_PAPER_API_BASE_URL=https://papertok-report-api.papertok-mugar123.workers.dev VITE_REPORT_API_URL=https://papertok-report-api.papertok-mugar123.workers.dev` delante, como en la tarea 2) y un commit.
- Fuente de copia del worktree viejo: `OLD=/Users/nicolasmunozgarcia/Developer/papertok/.claude/worktrees/landing-papertok` (rama `worktree-landing-papertok`, sin commitear: **cópialo con `cp`, no con git**).
- Fuera de alcance: analítica en la landing, el vídeo, figuras, cambiar el HashRouter.

---

## Mapa de ficheros

| Fichero | Responsabilidad |
|---|---|
| `index.html` (raíz, **nuevo contenido**: era `landing.html` en el worktree viejo) | la landing: cabeza (puerta de sesión, espejo de tema, puerta de movimiento), `<!--landing-html-->`, `motion.js` |
| `app.html` (renombrado desde `index.html`) | la app, intacta salvo canónica |
| `src/legal/static-page.css` (nuevo) | fuentes + tokens + barra + botones + pie compartidos por privacidad y landing |
| `src/legal/privacy.css` (modificado) | importa `static-page.css` en vez de las fuentes/tokens |
| `src/landing/page.js` (nuevo) | `buildLandingHtml()`: once tramos como funciones de plantilla |
| `src/landing/papers.js` (copiado + ampliado) | datos congelados: papers, rueda, rewrite, research, mapa, señales, entidades, listas |
| `src/landing/landing.css` (nuevo) | sistema visual y los once tramos; importa `static-page.css` y `motion.css` |
| `src/landing/motion.css` (copiado y podado + nuevo) | lector (secuencia, niveles, invitación), mazo, mapa, subrayado, *reduced motion* |
| `src/landing/motion.js` (copiado y podado + nuevo) | `armLevels`, `armRewrite`, `makeWheel`+`armPile` por IntersectionObserver, `armDeck`, `armReveals` |
| `src/landing/deck.js` (nuevo) | `createDeck({ count })`: el índice del mazo con vuelta, puro |
| `src/landing/graphMap.js` (nuevo, sustituye al viejo) | `citationPlate(neighbours, { compact })`: la plancha SVG |
| `src/utils/sessionMark.js` (nuevo) | la marca `papertok_signed_in` |
| `src/context/AuthContext.jsx` (modificado) | escribe/borra la marca en `onAuthStateChanged` |
| `vite.config.js` (modificado) | input `index: app.html` + `landing: index.html`; plugin de prerender; middleware `/feed`; el transform lee `dist/app.html` |
| `vercel.json`, `public/manifest.webmanifest`, `public/sw-html-warm.js` (modificados) | `/feed` → `app.html`; `start_url`; calentar `/feed` |
| `scripts/diagnostics/landing-shots.mjs`, `landing-axe.mjs`, `landing-wheel-audit.mjs`, `landing-invite-contrast.mjs` | sondas por CDP |
| Tests: `src/legal/staticPage.test.js`, `src/landing/entry.test.js`, `src/utils/sessionMark.test.js`, `src/landing/landingHead.test.js`, `src/landing/papers.test.js`, `src/landing/page.test.js`, `src/landing/deck.test.js`, `src/landing/graphMap.test.js`, `src/landing/rewriteMotion.test.js`, `src/landing/keyframeContrast.test.js`, `src/landing/highlightContrast.test.js`, `src/landing/a11y.test.js` | |

---

### Task 1: La hoja compartida de página estática

**Files:**
- Create: `src/legal/static-page.css`
- Modify: `src/legal/privacy.css` (cabecera de imports)
- Modify: `src/legal/privacy.test.js:56-64` (el test «shares the app tokens…»)
- Test: `src/legal/staticPage.test.js`

**Interfaces:**
- Produces: `static-page.css` exporta las clases `.lp-bar`, `.lp-wordmark`, `.lp-bar__right`, `.lp-bar__link`, `.lp-btn`, `.lp-btn--lg`, `.lp-btn--yellow`, `.lp-footer`, `.lp-footer__links`, `.lp-visually-hidden`, `.lp-skip` y la regla `:focus-visible`. Las tareas 5–11 las consumen tal cual.

- [ ] **Step 1: Escribe el test que falla**

```js
// src/legal/staticPage.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('static-page.css owns the faces, the tokens and the shared chrome', () => {
  const css = read('./static-page.css');
  for (const imp of [
    "@import '@fontsource-variable/newsreader/opsz.css'",
    "@import '@fontsource/inter/400.css'",
    "@import '@fontsource/ibm-plex-mono/400.css'",
    "@import '../styles/variables.css'",
  ]) assert.ok(css.includes(imp), imp);
  for (const cls of ['.lp-bar', '.lp-wordmark span', '.lp-btn', '.lp-footer', '.lp-visually-hidden', '.lp-skip', ':focus-visible']) {
    assert.ok(css.includes(cls), cls);
  }
  assert.doesNotMatch(css, /prefers-color-scheme/);
  assert.doesNotMatch(css, /https?:\/\//);
});

test('privacy.css imports the shared sheet instead of repeating it', () => {
  const css = read('./privacy.css');
  assert.ok(css.includes("@import './static-page.css'"));
  assert.doesNotMatch(css, /@fontsource|variables\.css|\.lp-bar\s*\{|\.lp-btn\s*\{|\.lp-footer\s*\{/);
});

test('the skip link is invisible until focused and then sits over everything', () => {
  const css = read('./static-page.css');
  const rule = css.match(/\.lp-skip\s*\{[^}]*\}/)?.[0] || '';
  assert.match(rule, /position:\s*absolute/);
  assert.match(rule, /top:\s*-100px|transform:\s*translateY\(-200%\)/);
  const focused = css.match(/\.lp-skip:focus(-visible)?\s*\{[^}]*\}/)?.[0] || '';
  assert.match(focused, /top:\s*8px|transform:\s*none/);
  assert.match(focused, /z-index:\s*1100/);
});
```

- [ ] **Step 2: Comprueba que falla**

Run: `node --test --test-reporter=tap src/legal/staticPage.test.js src/legal/privacy.test.js`
Expected: `not ok` en los tres nuevos (ENOENT de `static-page.css`); los de `privacy.test.js` aún pasan.

- [ ] **Step 3: Crea `static-page.css`** moviendo desde `privacy.css` los bloques de imports, `*`, `body`, «The bar», `.lp-btn`, «The foot» y el `@media (prefers-reduced-motion: no-preference)`, y añadiendo lo que la landing necesita:

```css
/* src/legal/static-page.css
 * Everything a static page of the site shares: the self-hosted faces, the
 * app's tokens, the bar, the buttons, the foot, focus, and two utilities.
 * Imported by privacy.css and landing.css; imports nothing from global.css. */
@import '@fontsource-variable/newsreader/opsz.css';
@import '@fontsource/inter/400.css';
@import '@fontsource/inter/500.css';
@import '@fontsource/inter/600.css';
@import '@fontsource/inter/700.css';
@import '@fontsource/ibm-plex-mono/400.css';
@import '@fontsource/ibm-plex-mono/500.css';
@import '@fontsource/ibm-plex-mono/600.css';
@import '../styles/variables.css';

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg-primary); color: var(--text-primary); font-family: var(--font-body); -webkit-font-smoothing: antialiased; }

/* Focus: ink, the app's own ring (variables.css --focus-ring), never hidden. */
:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

/* First in the DOM, invisible until it has focus, above every fixed bar. */
.lp-skip { position: absolute; top: -100px; left: 16px; z-index: 1100; padding: 10px 14px; border-radius: var(--radius-md); background: var(--accent-primary); color: var(--text-inverse); font: var(--fw-medium) 0.9375rem/1 var(--font-body); text-decoration: none; }
.lp-skip:focus-visible { top: 8px; z-index: 1100; }

.lp-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

.lp-bar { position: sticky; top: 0; z-index: var(--z-nav); height: var(--nav-height); display: flex; align-items: center; justify-content: space-between; padding: 0 40px; background: var(--bg-primary); border-bottom: 1px solid var(--border-subtle); }
.lp-bar--yellow { background: var(--brand-yellow); border-bottom-color: transparent; }
.lp-wordmark { font: var(--fw-bold) 0.9375rem/1 var(--font-heading); letter-spacing: -0.02em; color: var(--text-primary); text-decoration: none; }
.lp-wordmark span { box-shadow: inset 0 -0.32em 0 var(--brand-yellow); }
.lp-bar--yellow .lp-wordmark { color: var(--text-on-brand); }
.lp-bar__right { display: flex; align-items: center; gap: 24px; }
.lp-bar__link { font: var(--fw-medium) 0.875rem/1 var(--font-body); color: var(--text-secondary); text-decoration: none; min-height: 44px; display: inline-flex; align-items: center; }
.lp-bar--yellow .lp-bar__link { color: var(--text-on-brand); opacity: 0.8; }
.lp-bar__link:hover { color: var(--text-primary); opacity: 1; }

.lp-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 34px; padding: 0 16px; border: 1px solid var(--accent-primary); background: var(--accent-primary); color: var(--text-inverse); font: var(--fw-medium) 0.875rem/1 var(--font-body); border-radius: var(--radius-md); text-decoration: none; white-space: nowrap; cursor: pointer; }
.lp-btn:hover { background: var(--accent-primary-hover); border-color: var(--accent-primary-hover); }
.lp-btn--lg { min-height: 52px; padding: 0 28px; font-size: 1rem; border-radius: var(--radius-lg); }
.lp-btn--yellow { background: var(--brand-yellow); border-color: var(--brand-yellow); color: var(--text-on-brand); }
.lp-btn--yellow:hover { background: var(--brand-orange); border-color: var(--brand-orange); }

.lp-footer { width: min(1200px, calc(100% - 40px)); margin: 0 auto; padding: 24px 0 48px; border-top: 1px solid var(--border-subtle); display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap; font-size: 0.8125rem; color: var(--text-tertiary); }
.lp-footer__links { display: flex; gap: 24px; flex-wrap: wrap; }
.lp-footer a { color: inherit; text-decoration: none; min-height: 44px; display: inline-flex; align-items: center; }
.lp-footer a:hover { color: var(--text-primary); }
.lp-footer .lp-wordmark { color: var(--text-primary); }

@media (max-width: 640px) { .lp-bar { padding: 0 20px; } .lp-bar__right { gap: 16px; } }
@media (prefers-reduced-motion: no-preference) {
  .lp-bar__link, .lp-btn, a { transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease, text-decoration-color 150ms ease, opacity 150ms ease; }
}
```

En `privacy.css` sustituye las diez líneas de `@import` y los bloques movidos por una sola línea `@import './static-page.css';` (deja `.lp-doc`, `h1`, `h2`, `p`, `ul`, `a`, `code`, `.lp-short`, `.lp-hl`, la tabla y el `@media (max-width: 640px)` de la página). El pie de privacidad usa `width: min(62ch, …)`: conserva esa anulación en `privacy.css` como `.lp-doc + .lp-footer { width: min(62ch, calc(100% - 40px)); }`.

En `privacy.test.js` cambia el test «the stylesheet shares the app tokens…» para que compruebe `@import './static-page.css'` en `privacy.css` y las cuatro importaciones de fuentes/tokens en `static-page.css` (mismas aserciones, otro fichero); deja las de `#7c5cff` y `text-transform` sobre la concatenación de los dos ficheros.

- [ ] **Step 4: Comprueba que pasa**

Run: `node --test --test-reporter=tap src/legal/staticPage.test.js src/legal/privacy.test.js`
Expected: todo `ok`.

- [ ] **Step 5: Build y captura de la página de privacidad para confirmar que no cambió**

Run: `VITE_PAPER_API_BASE_URL=https://papertok-report-api.papertok-mugar123.workers.dev VITE_REPORT_API_URL=https://papertok-report-api.papertok-mugar123.workers.dev npm run build 2>&1 | grep -E 'privacy|error' ` → `dist/privacy.html` y `assets/privacy-*.css` emitidos, sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/legal/static-page.css src/legal/privacy.css src/legal/privacy.test.js src/legal/staticPage.test.js
git commit -m "refactor(legal): la barra, los botones y el pie pasan a static-page.css para que la landing los comparta"
```

---

### Task 2: `/` es la landing y la app vive en `/feed`

**Files:**
- Rename: `index.html` → `app.html` (`git mv`), luego crear `index.html` nuevo
- Modify: `app.html:37,42` (canónica y `og:url` → `https://papertok.app/feed`)
- Modify: `vite.config.js` (plugin de prerender + middleware; `build.rollupOptions.input`; `bootSetManifestTransform` lee `app.html`)
- Modify: `vercel.json`, `public/manifest.webmanifest:5`, `public/sw-html-warm.js`
- Modify: `src/utils/spaDeploy.test.js:11,44` (`/index.html` → `/app.html`)
- Create: `src/landing/page.js` (mínimo: `export function buildLandingHtml() { return '<main id="main-content"></main>'; }` — la tarea 5 lo llena)
- Test: `src/landing/entry.test.js`

**Interfaces:**
- Produces: `buildLandingHtml(): string` (lo consume el plugin); el placeholder `<!--landing-html-->`; la ruta `/feed` como URL de la app en producción, dev y preview.

- [ ] **Step 1: Escribe el test que falla**

```js
// src/landing/entry.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const path = (rel) => fileURLToPath(new URL(rel, ROOT));
const read = (rel) => readFileSync(path(rel), 'utf8');
const noComments = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('the app is app.html and the landing is index.html', () => {
  assert.ok(existsSync(path('app.html')));
  assert.match(read('app.html'), /<div id="root"/);
  assert.match(read('index.html'), /<!--landing-html-->/);
  assert.doesNotMatch(read('index.html'), /<div id="root"/);
});

test('the Rollup input keeps the key `index` for the app and adds the landing', () => {
  const input = noComments(read('vite.config.js')).match(/input:\s*\{([\s\S]*?)\}/)?.[1] || '';
  assert.match(input, /\bindex:\s*fileURLToPath\(new URL\('\.\/app\.html'/);
  assert.match(input, /\blanding:\s*fileURLToPath\(new URL\('\.\/index\.html'/);
});

test('the boot-set transform reads the built app page, not the landing', () => {
  const config = noComments(read('vite.config.js'));
  assert.match(config, /readFileSync\(join\(distDir, 'app\.html'\)/);
});

test('the prerender plugin targets index.html and serves /feed from app.html in dev and preview', () => {
  const config = noComments(read('vite.config.js'));
  assert.match(config, /ctx\.filename\.endsWith\('index\.html'\)/);
  assert.match(config, /configureServer/);
  assert.match(config, /configurePreviewServer/);
  assert.match(config, /req\.url = '\/app\.html'/);
});

test('Vercel sends /feed and every SPA path to app.html, and never caches it', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const feed = vercel.rewrites.find((r) => r.source === '/feed');
  assert.equal(feed?.destination, '/app.html');
  const spa = vercel.rewrites.find((r) => r.source.startsWith('/:path('));
  assert.equal(spa?.destination, '/app.html');
  assert.ok(vercel.rewrites.indexOf(feed) < vercel.rewrites.indexOf(spa));
  const header = vercel.headers.find((h) => h.source === '/app.html');
  assert.equal(header?.headers[0].value, 'public, max-age=0, must-revalidate');
});

test('the PWA starts in the app and the service worker warms /feed, not the landing', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(manifest.start_url, './feed#/');
  const warm = noComments(read('public/sw-html-warm.js'));
  assert.match(warm, /new URL\('feed', self\.registration\.scope\)/);
  assert.doesNotMatch(warm, /cache\.add\(self\.registration\.scope\)/);
});

test('the app page is canonical at /feed', () => {
  const app = read('app.html');
  assert.match(app, /<link rel="canonical" href="https:\/\/papertok\.app\/feed" \/>/);
  assert.match(app, /<meta property="og:url" content="https:\/\/papertok\.app\/feed" \/>/);
});
```

- [ ] **Step 2: Comprueba que falla**

Run: `node --test --test-reporter=tap src/landing/entry.test.js src/utils/spaDeploy.test.js`
Expected: los siete nuevos `not ok`; `spaDeploy` aún `ok`.

- [ ] **Step 3: Renombra y crea**

```bash
git mv index.html app.html
```

Crea `index.html` (la landing) con la cabeza del worktree viejo más la **puerta de sesión** como primer script:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <!--
      Who this page is for, decided before anything else runs: a signed-in
      reader (AuthContext writes `papertok_signed_in` on sign-in and clears it
      on sign-out) goes straight to the app, and so does anyone arriving on a
      deep link — `papertok.app/#/paper/…` has always meant the app, and the
      hash never reaches the server, so only this page can honour it. Both are
      `replace`, so the landing never sits in the history of a visit that
      never meant to see it. Mirror of src/utils/sessionMark.js.
    -->
    <script>
      (function () {
        try {
          var hash = window.location.hash;
          if (hash.indexOf('#/') === 0) { window.location.replace('/feed' + hash); return; }
          if (window.localStorage.getItem('papertok_signed_in') === '1') { window.location.replace('/feed'); }
        } catch (error) { /* a browser that refuses storage sees the landing */ }
      })();
    </script>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
    <title>PaperTok — Research you weren't looking for</title>
    <meta name="description" content="A feed of scientific papers from open, public sources. Open source, built by two people, free to read without an account." />
    <link rel="canonical" href="https://papertok.app/" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="PaperTok" />
    <meta property="og:title" content="PaperTok — Research you weren't looking for" />
    <meta property="og:description" content="A feed of scientific papers from open, public sources. Open source, built by two people, free to read without an account." />
    <meta property="og:url" content="https://papertok.app/" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:image" content="https://papertok.app/og/papertok-share-0.2.png" />
    <meta property="og:image:width" content="2400" />
    <meta property="og:image:height" content="1260" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="PaperTok — Research you weren't looking for" />
    <meta name="twitter:description" content="A feed of scientific papers from open, public sources." />
    <meta name="twitter:image" content="https://papertok.app/og/papertok-share-0.2.png" />
    <meta name="theme-color" content="#ffd21e" />
    <!-- The theme, resolved before the first paint: mirror of src/utils/theme.js and app.html. -->
    <script>
      (function () {
        try {
          var stored = window.localStorage.getItem('papertok_theme');
          var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
          var theme = stored === 'light' || stored === 'dark' ? stored : (prefersDark ? 'dark' : 'light');
          document.documentElement.setAttribute('data-theme', theme);
        } catch (error) { document.documentElement.setAttribute('data-theme', 'light'); }
      })();
    </script>
    <!--
      Whether this visit animates, decided before the first paint. The page is
      prerendered, so anything hidden by a start state must be hidden before it
      paints or it flickers. Mirror of shouldAnimate() in src/landing/motion.js.
      Failing closed is the safe side: no attribute, no motion, nothing hidden.
    -->
    <script>
      (function () {
        try {
          if (!('IntersectionObserver' in window) || !window.matchMedia) return;
          if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
          if (!window.matchMedia('(min-width: 768px) and (hover: hover) and (pointer: fine)').matches) return;
          document.documentElement.setAttribute('data-motion', 'on');
        } catch (error) { /* stays at rest */ }
      })();
    </script>
    <link rel="stylesheet" href="/src/landing/landing.css" />
  </head>
  <body>
    <!--landing-html-->
    <script type="module" src="/src/landing/motion.js"></script>
  </body>
</html>
```

`src/landing/page.js` mínimo para que el plugin tenga qué insertar (la tarea 5 lo reescribe):

```js
export function buildLandingHtml() {
  return '<main id="main-content" class="lp-main"></main>';
}
```

`src/landing/landing.css` mínimo: `@import '../legal/static-page.css';` (la tarea 5 lo completa).

En `app.html` cambia la canónica y `og:url` a `https://papertok.app/feed`.

- [ ] **Step 4: `vite.config.js`** — copia el plugin del worktree viejo (`$OLD/vite.config.js` líneas 178-205) y amplíalo con el middleware; añade el input; cambia el transform:

```js
// Encima de `export default defineConfig`:
const LANDING_PLACEHOLDER = '<!--landing-html-->'
const LANDING_PAGE_MODULE = '/src/landing/page.js'

// `/feed` has no file of its own: in production vercel.json rewrites it to
// app.html, and this middleware does the same for `vite dev` and `vite
// preview`, whose own SPA fallback would otherwise hand the LANDING to every
// unknown path. Query strings and the hash never reach the server, so only
// the pathname is looked at.
function feedToApp(req, res, next) {
  const pathname = (req.url || '').split('?')[0]
  if (pathname === '/feed' || pathname.startsWith('/feed/')) req.url = '/app.html'
  next()
}

function landingPrerender() {
  return {
    name: 'papertok-landing-prerender',
    configureServer(server) { server.middlewares.use(feedToApp) },
    configurePreviewServer(server) { server.middlewares.use(feedToApp) },
    async transformIndexHtml(html, ctx) {
      // The landing is index.html; app.html must pass through untouched.
      if (!ctx.filename.endsWith('index.html')) return html
      if (!html.includes(LANDING_PLACEHOLDER)) {
        throw new Error(`index.html is missing ${LANDING_PLACEHOLDER}`)
      }
      const module = ctx.server
        ? await ctx.server.ssrLoadModule(LANDING_PAGE_MODULE)
        : await import(new URL(`.${LANDING_PAGE_MODULE}`, import.meta.url).href)
      return html.replace(LANDING_PLACEHOLDER, module.buildLandingHtml())
    },
  }
}
```

En `plugins: [ … ]` pon `landingPrerender()` el primero. En `bootSetManifestTransform` cambia `readFileSync(join(distDir, 'index.html'), 'utf8')` por `readFileSync(join(distDir, 'app.html'), 'utf8')` y el mensaje de error que nombra `dist/index.html`. Añade dentro del objeto devuelto por `defineConfig`, antes de `resolve`:

```js
    build: {
      rollupOptions: {
        // Two pages, one build. The app's key MUST stay `index`: Rollup names
        // the entry chunk after it, and PRECACHE_GLOB_PATTERNS asks the
        // service worker for `assets/index-*.js` by name. The FILE is now
        // app.html because `/` belongs to the landing, which is what the
        // filesystem serves for index.html without any rewrite.
        input: {
          index: fileURLToPath(new URL('./app.html', import.meta.url)),
          landing: fileURLToPath(new URL('./index.html', import.meta.url)),
        },
      },
    },
```

`vercel.json` — rewrites en este orden y la cabecera nueva:

```json
"rewrites": [
  { "source": "/feed", "destination": "/app.html" },
  { "source": "/__/auth/:path*", "destination": "https://papertok-168df.firebaseapp.com/__/auth/:path*" },
  { "source": "/:path((?!_vercel/|assets/|__/auth/).*)", "destination": "/app.html" }
],
```

y en `headers` añade `{ "source": "/app.html", "headers": [{ "key": "Cache-Control", "value": "public, max-age=0, must-revalidate" }] }` junto al de `/index.html` (que se queda: ahora protege a la landing).

`public/manifest.webmanifest`: `"start_url": "./feed#/"`.

`public/sw-html-warm.js`: `.then((cache) => cache.add(new URL('feed', self.registration.scope).href))` y actualiza el comentario («the app now lives at /feed; the scope root is the landing»).

`src/utils/spaDeploy.test.js`: las dos búsquedas de `'/index.html'` pasan a `'/app.html'`.

- [ ] **Step 5: Comprueba que pasa y que el build emite las dos páginas**

Run: `node --test --test-reporter=tap src/landing/entry.test.js src/utils/spaDeploy.test.js` → todo `ok`.
Run: `VITE_PAPER_API_BASE_URL=… VITE_REPORT_API_URL=… npm run build 2>&1 | grep -E 'app\.html|index\.html|index-.*\.js|error'` → `dist/app.html`, `dist/index.html`, `dist/assets/index-*.js` presentes; `grep -c 'assets/index-' dist/sw.js` ≥ 1.
Run: `npx vite preview --port 4173 &` y `curl -s localhost:4173/feed | grep -c 'id="root"'` → `1`; `curl -s localhost:4173/ | grep -c 'main-content'` → `1`. Mata el preview.

- [ ] **Step 6: Commit**

```bash
git add index.html app.html vite.config.js vercel.json public/manifest.webmanifest public/sw-html-warm.js src/landing/page.js src/landing/landing.css src/landing/entry.test.js src/utils/spaDeploy.test.js
git commit -m "feat(landing): / es la landing y la app vive en /feed; la clave index del input no se mueve"
```

---

### Task 3: La marca de sesión

**Files:**
- Create: `src/utils/sessionMark.js`
- Modify: `src/context/AuthContext.jsx:80-95` (dentro del callback de `onAuthStateChanged`)
- Test: `src/utils/sessionMark.test.js`, `src/landing/landingHead.test.js`

**Interfaces:**
- Produces: `SESSION_MARK_KEY = 'papertok_signed_in'`, `markSignedIn(storage = localStorage)`, `clearSignedIn(storage)`, `hasSignedIn(storage): boolean`.

- [ ] **Step 1: Tests que fallan**

```js
// src/utils/sessionMark.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_MARK_KEY, markSignedIn, clearSignedIn, hasSignedIn } from './sessionMark.js';

const fakeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('the key is the one the landing head reads', () => { assert.equal(SESSION_MARK_KEY, 'papertok_signed_in'); });
test('marking and clearing round-trip through the given storage', () => {
  const s = fakeStorage();
  assert.equal(hasSignedIn(s), false);
  markSignedIn(s); assert.equal(s.getItem(SESSION_MARK_KEY), '1'); assert.equal(hasSignedIn(s), true);
  clearSignedIn(s); assert.equal(hasSignedIn(s), false);
});
test('a storage that throws is treated as absent, never as an error', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(hasSignedIn(broken), false);
  assert.doesNotThrow(() => markSignedIn(broken));
  assert.doesNotThrow(() => clearSignedIn(broken));
});
```

```js
// src/landing/landingHead.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('the session gate is the first script in the head, before any stylesheet', () => {
  assert.match(scripts[0], /localStorage\.getItem\('papertok_signed_in'\) === '1'/);
  assert.match(scripts[0], /location\.replace\('\/feed'\)/);
  assert.ok(html.indexOf('<script>') < html.indexOf('<link rel="stylesheet"'));
});
test('a deep link keeps its hash on the way to the app', () => {
  assert.match(scripts[0], /hash\.indexOf\('#\/'\) === 0/);
  assert.match(scripts[0], /location\.replace\('\/feed' \+ hash\)/);
});
test('the theme and motion gates are still there after the session gate', () => {
  assert.match(scripts[1], /papertok_theme/);
  assert.match(scripts[2], /data-motion/);
});
test('AuthContext writes the mark on sign-in and clears it on sign-out', () => {
  const ctx = readFileSync(fileURLToPath(new URL('../context/AuthContext.jsx', import.meta.url)), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(ctx, /import \{ markSignedIn, clearSignedIn \} from '\.\.\/utils\/sessionMark\.js'/);
  assert.match(ctx, /currentUser \? markSignedIn\(\) : clearSignedIn\(\)/);
});
```

- [ ] **Step 2: Comprueba que fallan** — `node --test --test-reporter=tap src/utils/sessionMark.test.js src/landing/landingHead.test.js` → `sessionMark` ENOENT; en `landingHead` fallan «AuthContext…» (los otros tres pasan ya, porque la tarea 2 escribió la puerta: eso está bien, son la regresión de esa puerta).

- [ ] **Step 3: Implementa**

```js
// src/utils/sessionMark.js
/**
 * The one thing the landing can know about you before the app boots.
 *
 * Firebase keeps its session in IndexedDB, which nothing can read
 * synchronously before the first paint; so the app leaves this mark in
 * localStorage when a session exists and takes it away when it ends, and the
 * inline gate at the top of index.html reads it. Only the app writes it — a
 * visitor who has never signed in on this browser gets the landing however
 * many times they come back. Mirror of the gate in index.html.
 */
export const SESSION_MARK_KEY = 'papertok_signed_in';

const storageOf = (storage) => storage || (typeof window !== 'undefined' ? window.localStorage : null);

export function markSignedIn(storage) {
  try { storageOf(storage)?.setItem(SESSION_MARK_KEY, '1'); } catch { /* storage denied: the landing shows */ }
}
export function clearSignedIn(storage) {
  try { storageOf(storage)?.removeItem(SESSION_MARK_KEY); } catch { /* same */ }
}
export function hasSignedIn(storage) {
  try { return storageOf(storage)?.getItem(SESSION_MARK_KEY) === '1'; } catch { return false; }
}
```

En `AuthContext.jsx`: añade `import { markSignedIn, clearSignedIn } from '../utils/sessionMark.js';` y, como primera línea del callback `onAuthStateChanged(auth, async (currentUser) => {`, `currentUser ? markSignedIn() : clearSignedIn();`.

- [ ] **Step 4: Comprueba que pasan** — mismo comando → todo `ok`. Después `node --test 'src/context/**/*.test.js'` sigue en verde.

- [ ] **Step 5: Commit**

```bash
git add src/utils/sessionMark.js src/utils/sessionMark.test.js src/context/AuthContext.jsx src/landing/landingHead.test.js
git commit -m "feat(landing): la app marca el navegador al iniciar sesión y la landing lo lee antes de pintar"
```

---

### Task 4: Los datos congelados

**Files:**
- Create: `src/landing/papers.js` — copia de `$OLD/src/landing/papers.js` más cuatro exports nuevos y dos correcciones
- Test: `src/landing/papers.test.js`

**Interfaces:**
- Produces (además de lo copiado: `HERO_PAPERS`, `FEED_PAPERS`, `PILE`, `WHEEL`, `LEVELS`, `DEFAULT_LEVEL`, `REWRITE`, `RESEARCH`, `REPO`, `SOURCES`, `PEOPLE`):
  - `SIGNALS: Array<[name, what]>` (seis)
  - `FOLLOW_ROWS: Array<{ kind: 'person'|'tag'|'building', name, sub, lang? }>` (tres)
  - `LISTS: Array<{ color, icon, name, count, isPublic, titles: string[] }>` (cuatro)
  - `MAP: { centre: { label, year }, above: Array<{ name, citations, y, order }>, below: Array<…>, totals: { cited: 99, citing: 14536 } }`
  - `RESEARCH.topics[i].pct` derivado de `works/previous`.

- [ ] **Step 1: Test que falla**

```js
// src/landing/papers.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HERO_PAPERS, SIGNALS, FOLLOW_ROWS, LISTS, MAP, RESEARCH, SOURCES } from './papers.js';

test('the deck opens with LIGO and closes with the paper that is not open access', () => {
  assert.equal(HERO_PAPERS.length, 3);
  assert.match(HERO_PAPERS[0].title, /Gravitational Waves/);
  assert.ok(!HERO_PAPERS[2].chips.some((c) => c.label === 'Open access'));
  assert.ok(HERO_PAPERS[2].chips.some((c) => c.label === 'Subscription'));
});
test('six signals, three entities, four lists', () => {
  assert.equal(SIGNALS.length, 6);
  assert.deepEqual(FOLLOW_ROWS.map((r) => r.kind), ['person', 'tag', 'building']);
  assert.equal(FOLLOW_ROWS[2].lang, 'es');
  assert.equal(LISTS.length, 4);
  assert.equal(LISTS.filter((l) => l.isPublic).length, 1);
});
test('the map has five cited and two citing neighbours, all inside the plate', () => {
  assert.equal(MAP.above.length, 5);
  assert.equal(MAP.below.length, 2);
  const x = (c) => Math.min(1150, 300 + Math.log10(Math.max(c, 1)) * 220);
  for (const n of [...MAP.above, ...MAP.below]) assert.ok(x(n.citations) <= 1150, n.name);
  const orders = [...MAP.above, ...MAP.below].map((n) => n.order).sort((a, b) => a - b);
  assert.deepEqual(orders, [1, 2, 3, 4, 5, 6, 7]);
});
test('growing-topic percentages are the ones their own counts give', () => {
  for (const t of RESEARCH.topics) {
    assert.equal(t.pct, Math.round((t.works / t.previous - 1) * 100), t.name);
  }
  assert.equal(RESEARCH.topics[0].pct, 69);
  assert.equal(RESEARCH.topics[1].pct, 47);
});
test('six core sources, and no claim that they are the only ones', () => {
  assert.equal(SOURCES.length, 6);
});
```

- [ ] **Step 2: Falla** — `node --test src/landing/papers.test.js` → ENOENT.

- [ ] **Step 3: Copia y amplía**

```bash
cp "$OLD/src/landing/papers.js" src/landing/papers.js
```

Cambios en la copia:
1. `RESEARCH.topics`: sustituye cada `{ name, pct, works: '882 works; previously 523' }` por `{ name, works: 882, previous: 523 }` y `{ name, works: 641, previous: 436 }` y exporta el cálculo: tras el objeto, `RESEARCH.topics = RESEARCH.topics.map((t) => ({ ...t, pct: Math.round((t.works / t.previous - 1) * 100), worksLabel: `${t.works} works; previously ${t.previous}` }));`.
2. Añade al final:

```js
export const SIGNALS = [
  ['What you picked', 'The fields and categories you chose when you started.'],
  ['What you did', 'The papers you liked, saved, opened and skipped.'],
  ['Who you follow', 'Authors, topics, institutions and projects.'],
  ['How recent it is', 'Newer work gets a push; nothing is buried for being old.'],
  ['Its record', 'Citation counts and the concepts the paper carries.'],
  ['A detour', 'Once in a while, something outside your usual interests, on purpose.'],
];

export const FOLLOW_ROWS = [
  { kind: 'person', name: 'David Card', sub: 'Author · University of California, Berkeley' },
  { kind: 'tag', name: 'Gravitational waves', sub: 'Topic · 41,180 works' },
  { kind: 'building', name: 'Universidad de Salamanca', sub: 'Institution · Salamanca, Spain', lang: 'es' },
];

/* The lists as the app paints them: the rule colour is the list's own, not a field ink. */
export const LISTS = [
  { color: 'var(--accent-like)', icon: 'heart', name: 'Favorites', count: '50 papers', isPublic: false, titles: ['On String Theory Duals of Lifshitz-like…', 'Integrating Post-Newtonian Equations…'] },
  { color: 'var(--border-strong)', icon: 'book', name: 'Read later', count: '0 papers', isPublic: false, titles: [] },
  { color: 'var(--list-ochre)', icon: 'eye', name: 'Reading history', count: '1 paper', isPublic: false, titles: ['Structural complexity of an SU(3) Ferm…'] },
  { color: 'var(--list-indigo)', icon: 'folder', name: 'Papers de sugar', count: '14 papers', isPublic: true, titles: ['State–Generator Geometry of Open…', 'Observation of perfect absorption in…'] },
];

/* Real neighbours of the LIGO paper, read off OpenAlex/OpenCitations on
   2026-09-17 and frozen here; citation counts are OpenAlex's that day.
   `order` is the draw-on order: the paper itself is 0. */
export const MAP = {
  centre: { label: 'THIS PAPER · 2016' },
  totals: { cited: 99, citing: 14536 },
  above: [
    { name: 'Einstein ’16', citations: 14200, y: 64, order: 1 },
    { name: 'Hulse & Taylor ’75', citations: 2100, y: 124, order: 2 },
    { name: 'Thorne ’87', citations: 1900, y: 176, order: 3 },
    { name: 'Pretorius ’05', citations: 1650, y: 104, order: 4 },
    { name: 'Blanchet ’14', citations: 1500, y: 228, order: 5 },
  ],
  below: [
    { name: 'Abbott ’17 · GW170817', citations: 6500, y: 360, order: 6 },
    { name: 'GWTC-1 ’19', citations: 2400, y: 440, order: 7 },
  ],
};
```

- [ ] **Step 4: Pasa** — `node --test src/landing/papers.test.js` → `ok`.
- [ ] **Step 5: Commit** — `git add src/landing/papers.js src/landing/papers.test.js && git commit -m "feat(landing): los datos congelados, con los porcentajes de Research salidos de sus recuentos"`

---

### Task 5: La página — sistema, barra, hero, franja, cierre

**Files:**
- Modify: `src/landing/page.js` (reescritura), `src/landing/landing.css`
- Test: `src/landing/page.test.js`

**Interfaces:**
- Produces: `buildLandingHtml()` devuelve barra + `<main id="main-content">` con `<section>` por tramo + pie; helpers internos `paper(p, { size, tags })`, `chip`, `hl(text)`, `hlRule(text)`, `icon(name)`; los marcadores `data-deck`, `data-deck-skip`, `data-deck-count`. Las tareas 6–9 añaden secciones **entre** `hero()` y `strip()` en el array `screens`.

- [ ] **Step 1: Test que falla** (la mitad de estos criterios vienen del §10 de la spec)

```js
// src/landing/page.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLandingHtml } from './page.js';

const html = buildLandingHtml();
const css = readFileSync(fileURLToPath(new URL('./landing.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const sections = [...html.matchAll(/<section class="([^"]*)"/g)].map((m) => m[1].split(' ')[0]);

test('the skip link is the first thing in the document and points at main', () => {
  assert.ok(html.trimStart().startsWith('<a class="lp-skip" href="#main-content">'));
  assert.match(html, /<main id="main-content"/);
});
test('landmarks: one header with a labelled nav, one main, one footer', () => {
  assert.equal((html.match(/<header /g) || []).length, 1);
  assert.match(html, /<nav class="lp-bar__right" aria-label="Site">/);
  assert.equal((html.match(/<main /g) || []).length, 1);
  assert.equal((html.match(/<footer /g) || []).length, 1);
});
test('one h1, and every section is labelled by its own h2', () => {
  assert.equal((html.match(/<h1/g) || []).length, 1);
  for (const m of html.matchAll(/<section class="[^"]*" aria-labelledby="([^"]+)"/g)) {
    assert.match(html, new RegExp(`<h2[^>]*id="${m[1]}"`), m[1]);
  }
});
test('the hero deck ships three slides, the first visible, the others inert, and Skip hidden without JS', () => {
  assert.equal((html.match(/class="lp-hero__slide"/g) || []).length, 3);
  assert.equal((html.match(/aria-hidden="true" inert/g) || []).length, 2);
  assert.match(html, /<button class="lp-deck__skip" type="button" data-deck-skip hidden aria-label="Skip to the next paper">/);
  assert.match(html, /<span class="lp-deck__count" data-deck-count aria-live="polite">1 \/ 3<\/span>/);
});
test('yellow is a ground only in the hero and the closing button', () => {
  const grounds = [...css.matchAll(/([^{}]+)\{[^}]*background:\s*var\(--brand-yellow\)[^}]*\}/g)].map((m) => m[1].trim());
  assert.deepEqual(grounds.sort(), ['.lp-close .lp-btn--yellow', '.lp-hero']);
});
test('no snap, no wheel capture, no figures, no eyebrows outside the card', () => {
  assert.doesNotMatch(css, /scroll-snap/);
  assert.doesNotMatch(html, /<img|<figure class="lp-figure"|pc-figure/);
  const upper = [...css.matchAll(/([^{}]+)\{[^}]*text-transform:\s*uppercase[^}]*\}/g)].map((m) => m[1].trim());
  for (const sel of upper) assert.match(sel, /^\.lp-(paper|plate|research|chip)/, sel);
});
test('the highlight appears exactly three times, and never as a band on ink', () => {
  assert.equal((html.match(/class="lp-hl"/g) || []).length, 3);
  assert.match(css, /\[data-theme="dark"\] \.lp-hl \{[^}]*text-decoration: underline/);
  assert.match(css, /\.lp-close \.lp-hl \{[^}]*text-decoration: underline/);
});
test('the order of the tramos is the spec’s', () => {
  assert.deepEqual(sections, ['lp-hero', 'lp-problem', 'lp-signals', 'lp-reader', 'lp-labels', 'lp-follow', 'lp-library', 'lp-map', 'lp-research', 'lp-strip', 'lp-close']);
});
```

(El test del orden falla hasta la tarea 9; los demás pasan al final de esta tarea. Ejecuta el fichero entero cada vez y cuenta cuántos quedan.)

- [ ] **Step 2: Falla** — `node --test src/landing/page.test.js` → todos `not ok`.

- [ ] **Step 3: `page.js`** — reescríbelo. Helpers al principio:

```js
import {
  HERO_PAPERS, PILE, WHEEL, LEVELS, DEFAULT_LEVEL, REWRITE, RESEARCH, REPO, SOURCES, PEOPLE,
  SIGNALS, FOLLOW_ROWS, LISTS, MAP,
} from './papers.js';
import { citationPlate } from './graphMap.js';

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* lucide's paths, byte for byte, so the landing's marks are the app's. */
const ICON_PATHS = {
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  sparkles: '<path class="lp-spark lp-spark--star" d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><g class="lp-spark lp-spark--cross"><path d="M20 2v4"/><path d="M22 4h-4"/></g><circle class="lp-spark lp-spark--dot" cx="4" cy="20" r="2"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/>',
  graph: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  person: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  building: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  octocat: null,
};
const icon = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;

const chip = ({ label, tone }) => `<span class="lp-chip lp-chip--${tone}">${esc(label)}</span>`;
const chips = (list = []) => list.length ? `<div class="lp-chips">${list.map(chip).join('')}</div>` : '';
const dot = '<span class="lp-paper__dot" aria-hidden="true">·</span>';
const avatars = (initials = []) => initials.length ? `<span class="lp-avatars" aria-hidden="true">${initials.map((i) => `<span class="lp-avatar">${esc(i)}</span>`).join('')}</span>` : '';

/* The band on paper; the rule on ink (see landing.css) — same class, the
   theme decides. */
const hl = (text) => `<span class="lp-hl">${text}</span>`;

/**
 * A paper, set the way PaperCard sets it. `heading` is the level of its
 * title: h2 inside the hero (the sheet is the section's content) and h3
 * inside a section that already has an h2.
 */
function paper(p, { size = 'md', heading = 'h3', tags = false } = {}) {
  const accent = p.fieldVar || '--gradient-physics';
  return `<article class="lp-paper lp-paper--${size}" style="--lp-accent: var(${accent})">
    <span class="lp-paper__accent" aria-hidden="true"></span>
    <p class="lp-paper__meta"><span class="lp-paper__field">${esc(p.field)}</span>${p.category ? `${dot}<span>${esc(p.category)}</span>` : ''}${dot}<span>${esc(p.year)}</span></p>
    ${chips(p.chips)}
    <${heading} class="lp-paper__title">${esc(p.title)}</${heading}>
    ${p.authors ? `<p class="lp-paper__authors">${avatars(p.initials)}<span>${esc(p.authors)}</span></p>` : ''}
    ${p.abstract ? `<p class="lp-paper__abstract">${esc(p.abstract)}</p>` : ''}
    <div class="lp-paper__actions" aria-hidden="true">
      <span class="lp-btn lp-btn--md">${icon('file')}Read article</span>
      <span class="lp-btn lp-btn--md lp-btn--ai">${icon('sparkles')}Read in plain words</span>
      <span class="lp-paper__spacer"></span>
      <span class="lp-iconbtn">${icon('share')}</span><span class="lp-iconbtn lp-iconbtn--graph">${icon('graph')}</span>
    </div>
  </article>`;
}
```

Barra, hero, franja, cierre y ensamblado:

```js
const skip = () => `<a class="lp-skip" href="#main-content">Skip to content</a>`;

const bar = () => `<header class="lp-bar lp-bar--yellow">
  <a class="lp-wordmark" href="/" aria-label="PaperTok">Paper<span>Tok</span></a>
  <nav class="lp-bar__right" aria-label="Site">
    <a class="lp-bar__link" href="https://github.com/${REPO.path}">Source</a>
    <a class="lp-btn" href="/feed">Open the feed</a>
  </nav>
</header>`;

/* The hero. Nothing arrives: the page is prerendered. The sheet is a deck the
   reader passes with Skip (the app's own action) or the arrow keys; the
   other two slides ship inert so that, without motion.js, the document holds
   exactly one readable paper and nothing a keyboard can reach and not see.
   WAI-ARIA carousel: group + roledescription, one slide visible at a time. */
const hero = () => `<section class="lp-hero" aria-labelledby="lp-h1">
  <div class="lp-wrap lp-hero__grid">
    <div class="lp-hero__claim">
      <h1 id="lp-h1" class="lp-h1">Research you weren't looking for.</h1>
      <p class="lp-lede">A feed of scientific papers from open, public sources. Scroll it the way you scroll anything else.</p>
      <p class="lp-hero__cta"><a class="lp-btn lp-btn--lg" href="/feed">Open the feed</a><span class="lp-hero__note">No account needed to look.</span></p>
    </div>
    <div class="lp-sheet" data-deck tabindex="0" role="group" aria-roledescription="carousel" aria-label="Three papers from the feed">
      <div class="lp-deck">
        <ol class="lp-deck__reel" data-deck-reel>
          ${HERO_PAPERS.map((p, i) => `<li class="lp-hero__slide" role="group" aria-roledescription="slide" aria-label="${i + 1} of ${HERO_PAPERS.length}"${i ? ' aria-hidden="true" inert' : ''}>${paper(p, { size: 'sheet', heading: 'h2' })}</li>`).join('\n')}
        </ol>
      </div>
      <div class="lp-deck__foot">
        <button class="lp-deck__skip" type="button" data-deck-skip hidden aria-label="Skip to the next paper">${icon('ban', 15)}Skip</button>
        <span class="lp-deck__count" data-deck-count aria-live="polite">1 / ${HERO_PAPERS.length}</span>
      </div>
    </div>
  </div>
</section>`;

const strip = () => `<section class="lp-strip" aria-labelledby="lp-strip-h">
  <h2 id="lp-strip-h" class="lp-visually-hidden">Where it comes from, and who makes it</h2>
  <div class="lp-wrap lp-strip__grid">
    <p>The papers come from <strong>${SOURCES.map(([n]) => esc(n)).join(', ').replace(/, ([^,]*)$/, ' and $1')}</strong>, with others filling in access links, funding and citations. PaperTok hosts nothing and is affiliated with none of them.</p>
    <p>The ranking is experimental, so it's readable: <a href="https://github.com/${REPO.path}">${esc(REPO.path)}</a>, ${esc(REPO.license)}. The weights, the worker and the argument behind every change are in the open.</p>
    <p>I started it in June 2026 as a physics student who kept missing the papers next door. <a href="https://github.com/${esc(PEOPLE[1].github)}">${esc(PEOPLE[1].name)}</a> joined in August and shaped how it looks.</p>
  </div>
</section>`;

const close = () => `<section class="lp-close" aria-labelledby="lp-close-h">
  <div class="lp-wrap lp-close__grid">
    <h2 id="lp-close-h" class="lp-close__line">Start with a paper ${hl("you didn't expect.")}</h2>
    <p class="lp-close__action"><a class="lp-btn lp-btn--lg lp-btn--yellow" href="/feed">Open the feed</a><span class="lp-close__note">No account needed to look.</span></p>
  </div>
</section>`;

const foot = () => `<footer class="lp-footer">
  <a class="lp-wordmark" href="/" aria-label="PaperTok">Paper<span>Tok</span></a>
  <span class="lp-footer__links"><a href="https://github.com/${REPO.path}">GitHub</a><a href="/privacy.html">Privacy</a><span>Español and English</span><span>Version 0.2</span></span>
</footer>`;

export function buildLandingHtml() {
  const screens = [hero(), strip(), close()]; // tasks 6–9 insert their sections before strip()
  return `${skip()}\n${bar()}\n<main id="main-content" class="lp-main">\n${screens.join('\n')}\n</main>\n${foot()}`;
}
```

- [ ] **Step 4: `landing.css`** — sistema y estos tramos (los valores son los de la spec §4):

```css
@import '../legal/static-page.css';
@import './motion.css';

.lp-wrap { width: min(1200px, calc(100% - 40px)); margin: 0 auto; }
.lp-main { display: block; }
.lp-h1 { font-family: var(--font-serif); font-size: clamp(2.75rem, 6.4vw, 5.75rem); font-weight: var(--fw-regular); line-height: 0.98; letter-spacing: -0.03em; margin: 0; color: var(--text-on-brand); text-wrap: balance; }
.lp-h2 { font-family: var(--font-serif); font-size: clamp(2rem, 3vw, 2.75rem); font-weight: var(--fw-regular); line-height: 1.08; letter-spacing: -0.02em; margin: 0; text-wrap: pretty; }
.lp-body { font: var(--fw-regular) 1.0625rem/1.6 var(--font-body); color: var(--text-secondary); margin: 0; max-width: 40ch; }
.lp-lede { font: var(--fw-regular) 1.1875rem/1.55 var(--font-body); color: var(--text-on-brand); margin: 0; max-width: 32ch; }

/* The highlight: a band on paper, a thin rule on ink. */
.lp-hl { box-shadow: inset 0 -0.42em 0 var(--brand-yellow); padding: 0 0.04em; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
[data-theme="dark"] .lp-hl, .lp-close .lp-hl { box-shadow: none; text-decoration: underline; text-decoration-color: var(--brand-yellow); text-decoration-thickness: 0.08em; text-underline-offset: 0.14em; text-decoration-skip-ink: auto; }

/* ── Sections ── */
.lp-sec { padding: 104px 0; }
.lp-cols { display: grid; grid-template-columns: 420px minmax(0, 1fr); gap: 96px; align-items: start; }
.lp-cols--centre { align-items: center; }
.lp-head { display: flex; flex-direction: column; gap: 20px; }

/* ── Hero ── */
.lp-hero { background: var(--brand-yellow); padding: 72px 0 96px; }
.lp-hero__grid { display: grid; grid-template-columns: 520px minmax(0, 1fr); gap: 72px; align-items: center; }
.lp-hero__claim { display: flex; flex-direction: column; gap: 36px; }
.lp-hero__cta { display: flex; align-items: center; gap: 18px; margin: 0; flex-wrap: wrap; }
.lp-hero__note { font: var(--fw-regular) 0.9375rem/1.4 var(--font-body); color: var(--text-on-brand); opacity: 0.8; }
.lp-sheet { background: var(--bg-figure-plate); color: var(--text-primary); padding: 44px 44px 28px; border-radius: 2px; box-shadow: 0 24px 60px rgba(17, 19, 24, 0.18), 0 2px 6px rgba(17, 19, 24, 0.08); display: flex; flex-direction: column; gap: 24px; width: min(560px, 100%); }
[data-theme="dark"] .lp-sheet { color: #111318; }
.lp-deck { position: relative; overflow: hidden; }
.lp-deck__reel { margin: 0; padding: 0; list-style: none; position: relative; }
.lp-hero__slide { }
.lp-deck__foot { display: flex; align-items: center; justify-content: space-between; padding-top: 16px; border-top: 1px solid var(--border-subtle); }
.lp-deck__skip { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 14px; border: 1px solid var(--border-default); border-radius: var(--radius-lg); background: #fff; color: #111318; font: var(--fw-medium) 0.875rem/1 var(--font-body); cursor: pointer; }
.lp-deck__skip:hover { background: var(--bg-secondary); }
.lp-deck__count { font: var(--fw-medium) 0.75rem/1 var(--font-mono); color: var(--text-tertiary); }

/* ── A paper, as PaperCard sets it ── */
.lp-paper { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.lp-paper__accent { width: 34px; height: 3px; background: var(--lp-accent); }
.lp-paper__meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0; font: var(--mono-label); letter-spacing: var(--mono-track); text-transform: uppercase; color: var(--text-secondary); }
.lp-paper__field { font-weight: var(--fw-semibold); color: var(--lp-accent); }
.lp-paper__dot { color: var(--border-strong); }
.lp-paper__title { font-family: var(--font-serif); font-weight: var(--fw-semibold); line-height: 1.16; letter-spacing: -0.015em; margin: 0; font-size: 1.875rem; text-wrap: pretty; }
.lp-paper--sheet .lp-paper__title { font-size: clamp(1.5rem, 2.4vw, 2.125rem); }
.lp-paper__authors { display: flex; align-items: center; gap: 12px; margin: 0; padding-bottom: 14px; border-bottom: 1px solid var(--border-subtle); font: var(--fw-medium) var(--fs-sm)/1.4 var(--font-body); color: var(--text-secondary); }
.lp-avatars { display: flex; flex: none; }
.lp-avatar { width: 24px; height: 24px; margin-right: -7px; border-radius: var(--radius-full); border: 1px solid #fff; background: var(--tint-neutral-bg); display: flex; align-items: center; justify-content: center; font: var(--fw-medium) 0.625rem/1 var(--font-mono); color: var(--text-tertiary); }
.lp-paper__abstract { font-family: var(--font-serif); font-size: 1.0625rem; line-height: 1.6; color: var(--text-secondary); margin: 0; }
.lp-paper__abstract::first-letter { float: left; margin: 0.06em 0.08em 0 0; font-size: 2.9em; line-height: 0.82; font-weight: var(--fw-semibold); color: var(--lp-accent); }
.lp-paper__actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.lp-paper__spacer { flex: 1; }
.lp-btn--md { min-height: 44px; padding: 0 18px; border-radius: var(--radius-lg); gap: 8px; }
.lp-btn--ai { background: var(--brand-yellow-soft); border-color: var(--tint-amber-line); color: var(--text-on-brand-soft); }
.lp-iconbtn { width: 40px; height: 40px; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); display: inline-flex; align-items: center; justify-content: center; color: var(--text-primary); }
.lp-iconbtn--graph { border-color: var(--tint-blue-line); background: var(--tint-blue-bg); color: var(--gradient-physics); }
.lp-chips { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.lp-chip { display: inline-flex; align-items: center; min-height: 22px; padding: 2px 6px; border: 1px solid var(--tint-neutral-line); border-radius: var(--radius-sm); background: var(--tint-neutral-bg); color: var(--tint-neutral-fg); font: var(--fw-medium) 0.6875rem/1.35 var(--font-mono); white-space: nowrap; }
.lp-chip--blue { border-color: var(--tint-blue-line); background: var(--tint-blue-bg); color: var(--tint-blue-fg); }
.lp-chip--green { border-color: var(--tint-green-line); background: var(--tint-green-bg); color: var(--tint-green-fg); }
.lp-chip--amber { border-color: var(--tint-amber-line); background: var(--tint-amber-bg); color: var(--tint-amber-fg); }
.lp-chip--plain { background: transparent; }

/* ── Strip and close ── */
.lp-strip { padding: 64px 0; }
.lp-strip__grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 64px; }
.lp-strip p { font-family: var(--font-serif); font-size: 1.1875rem; line-height: 1.5; margin: 0; }
.lp-strip a { color: inherit; text-decoration: underline; text-decoration-color: var(--border-strong); text-underline-offset: 3px; }
.lp-close { background: var(--accent-primary); color: var(--text-inverse); padding: 120px 0 72px; }
[data-theme="dark"] .lp-close { background: var(--bg-secondary); color: var(--text-primary); }
.lp-close__grid { display: flex; align-items: flex-end; justify-content: space-between; gap: 64px; }
.lp-close__line { font-family: var(--font-serif); font-size: clamp(2.5rem, 4.4vw, 4rem); font-weight: var(--fw-regular); line-height: 1.04; letter-spacing: -0.02em; margin: 0; max-width: 14ch; text-wrap: balance; }
.lp-close__action { display: flex; flex-direction: column; align-items: flex-end; gap: 12px; margin: 0; flex: none; }
.lp-close .lp-btn--yellow { background: var(--brand-yellow); }
.lp-close__note { font: var(--fw-regular) 0.875rem/1 var(--font-body); opacity: 0.75; }
.lp-close + .lp-footer { border-top: none; }

/* ── Phones (390) and narrow laptops ── */
@media (max-width: 1000px) {
  .lp-hero__grid, .lp-cols { grid-template-columns: minmax(0, 1fr); gap: 40px; }
  .lp-strip__grid { grid-template-columns: minmax(0, 1fr); gap: 28px; }
  .lp-close__grid { flex-direction: column; align-items: flex-start; }
  .lp-close__action { align-items: flex-start; }
}
@media (max-width: 640px) {
  .lp-sec { padding: 64px 0; }
  .lp-hero { padding: 40px 0 56px; }
  .lp-hero__cta .lp-btn { width: 100%; }
  .lp-sheet { padding: 24px 20px 16px; }
  .lp-paper__actions { flex-wrap: wrap; }
  .lp-paper__spacer { display: none; }
}
```

Crea `src/landing/motion.css` de momento con solo el bloque de *reduced motion* (la tarea 7 y la 10 lo llenan):

```css
@media (prefers-reduced-motion: reduce) {
  .lp-deck__reel { transition: none !important; }
}
```

Crea `src/landing/graphMap.js` **temporal** con `export const citationPlate = () => '';` (la tarea 9 lo escribe de verdad; el import de page.js debe resolver desde ya).

- [ ] **Step 5: Pasa lo que toca** — `node --test src/landing/page.test.js` → todo `ok` menos «the order of the tramos» (esperado hasta la tarea 9). Build OK. Captura: `node scripts/diagnostics/landing-shots.mjs http://localhost:4173/ /tmp/lp/t5 1000` (copia antes `shots.mjs` del scratchpad a `scripts/diagnostics/landing-shots.mjs` — tarea 12 lo deja definitivo; hacerlo ahora es lo que permite mirar) y abre `t5-00.png`: barra amarilla, titular, hoja con LIGO, Skip oculto.

- [ ] **Step 6: Commit** — `git add src/landing && git commit -m "feat(landing): sistema visual, barra, hero con la hoja, franja y cierre"`

---

### Task 6: «Search works when you already know…» con la rueda, y «One paper at a time»

**Files:**
- Modify: `src/landing/page.js` (añade `problem()`, `pile()`, `pileData()`, `signals()` y los inserta), `src/landing/landing.css` (bloque `.lp-pile*`, `.lp-problem`, `.lp-signals`), `src/landing/motion.js` (crear: copia podada + `armPile` por IO)
- Test: `src/landing/page.test.js` (añade tres tests), `src/landing/wheel.test.js`

**Interfaces:**
- Produces: `.lp-pile` con `.lp-pile__barrel > li.lp-pile__slot > span×2` y `<script type="application/json" id="lp-pile-data">` al final del documento; `motion.js` con `makeWheel(frame): flick` y `armPile()`.

- [ ] **Step 1: Tests que fallan** — añade a `page.test.js`:

```js
test('the wheel is thirteen slots the screen reader never hears, next to a list it does', () => {
  assert.equal((html.match(/class="lp-pile__slot"/g) || []).length, 13);
  assert.match(html, /<div class="lp-pile" aria-hidden="true"/);
  assert.match(html, /<ul class="lp-visually-hidden" id="lp-pile-list">/);
  assert.equal((html.match(/<ul class="lp-visually-hidden" id="lp-pile-list">[\s\S]*?<\/ul>/)[0].match(/<li>/g) || []).length, 25);
  assert.match(html, /<script type="application\/json" id="lp-pile-data">/);
  assert.ok(html.lastIndexOf('lp-pile-data') > html.lastIndexOf('</main>'), 'the data lives outside main');
});
test('the problem section carries the first of the three highlights', () => {
  const sec = html.match(/<section class="lp-problem"[\s\S]*?<\/section>/)[0];
  assert.equal((sec.match(/class="lp-hl"/g) || []).length, 1);
  assert.match(sec, /so I built one\./);
});
test('six signals, name and sentence each, no dl and no mono labels', () => {
  const sec = html.match(/<section class="lp-signals"[\s\S]*?<\/section>/)[0];
  assert.equal((sec.match(/class="lp-signal"/g) || []).length, 6);
  assert.doesNotMatch(sec, /<dl|lp-eyebrow/);
});
```

y `src/landing/wheel.test.js` (fuente, como los tests viejos):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const js = readFileSync(fileURLToPath(new URL('./motion.js', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
test('the wheel keeps its measured constants', () => {
  assert.match(js, /WHEEL_REACHES = \[14, 16, 18\]/);
  assert.match(js, /WHEEL_TAU = 380/);
  assert.match(js, /WHEEL_STOP_V = 0\.46/);
});
test('the wheel turns on arrival by IntersectionObserver and on click, and never captures the scroll', () => {
  assert.match(js, /new IntersectionObserver\([\s\S]*?threshold: 0\.5/);
  assert.match(js, /frame\.addEventListener\('click'/);
  assert.doesNotMatch(js, /preventDefault/);
  assert.doesNotMatch(js, /addEventListener\('wheel'/);
  assert.doesNotMatch(js, /lp-scroller/);
});
```

- [ ] **Step 2: Fallan** — `node --test src/landing/page.test.js src/landing/wheel.test.js`.

- [ ] **Step 3: Markup** — copia de `$OLD/src/landing/page.js` las funciones `pile()` (líneas 218-231) y `pileData()` (245-247) **tal cual**, con dos cambios: el `<div class="lp-pile"` lleva `aria-hidden="true"` y, justo después de él, la lista para lectores de pantalla. Y escribe:

```js
const problem = () => `<section class="lp-problem lp-sec" aria-labelledby="lp-problem-h">
  <div class="lp-wrap lp-cols lp-cols--centre">
    <div class="lp-head">
      <h2 id="lp-problem-h" class="lp-h2">Search works when you already know what you're looking for.</h2>
      <p class="lp-body">Most of the research worth reading is ${hl("the research you didn't know to search for")}. A field next to yours. A method you've never used. A question you didn't know was still open.</p>
      <p class="lp-body">More is published every day than anyone can get through, and none of it arrives unless you ask for it by name. There was no good way to run into any of it, so I built one.</p>
    </div>
    <div class="lp-pile-wrap">
      ${pile()}
      <ul class="lp-visually-hidden" id="lp-pile-list">${PILE.map((r) => `<li>${esc(r.title)} (${esc(r.venue)})</li>`).join('')}</ul>
    </div>
  </div>
</section>`;

const signals = () => `<section class="lp-signals lp-sec" aria-labelledby="lp-signals-h">
  <div class="lp-wrap lp-cols">
    <div class="lp-head">
      <h2 id="lp-signals-h" class="lp-h2">One paper at a time.</h2>
      <p class="lp-body">A paper arrives full screen. Skip it, save it, or open it, and the next one gets closer to what you care about. It is not trying to find the most popular paper. It is trying to leave room for the unexpected.</p>
    </div>
    <ul class="lp-signals__grid">${SIGNALS.map(([name, what]) => `<li class="lp-signal"><span class="lp-signal__name">${esc(name)}</span><span class="lp-signal__what">${esc(what)}</span></li>`).join('')}</ul>
  </div>
</section>`;
```

En `buildLandingHtml`: `const screens = [hero(), problem(), signals(), strip(), close()]` y devuelve `…</main>\n${foot()}\n${pileData()}`.

- [ ] **Step 4: CSS** — copia de `$OLD/src/landing/landing.css` el bloque de la rueda entero: desde la línea que empieza por `.lp-pile {` (busca con `grep -n 'lp-pile' $OLD/src/landing/landing.css`, ~395) hasta el último selector `.lp-pile__*` (~535), incluida la lente y la máscara; **quita** cualquier regla `@media` que la anule por `data-motion` si la hubiera (la rueda es estática sin JS de todos modos). Añade:

```css
.lp-pile-wrap { position: relative; }
.lp-signals__grid { list-style: none; margin: 0; padding: 8px 0 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 40px 32px; }
.lp-signal { display: flex; flex-direction: column; gap: 8px; padding-top: 14px; border-top: 1px solid var(--border-subtle); }
.lp-signal__name { font: var(--fw-medium) 0.9375rem/1.3 var(--font-body); color: var(--text-primary); }
.lp-signal__what { font-family: var(--font-serif); font-size: 1.125rem; line-height: 1.4; color: var(--text-secondary); }
@media (max-width: 1000px) { .lp-signals__grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
/* Phones: the barrel is a flat list of seven with the centre between two rules. */
@media (max-width: 767px) {
  .lp-pile { height: auto; perspective: none; -webkit-mask-image: none; mask-image: none; }
  .lp-pile__barrel { translate: none; transform-style: flat; position: static; }
  .lp-pile__slot { position: static; transform: none; margin: 0; height: auto; padding: 10px 0; }
  .lp-pile__slot:nth-child(-n+3), .lp-pile__slot:nth-child(n+11) { display: none; }
  .lp-pile__slot:nth-child(7) { border-top: 1px solid var(--border-ink); border-bottom: 1px solid var(--border-ink); }
}
```

- [ ] **Step 5: `motion.js`** — créalo copiando de `$OLD/src/landing/motion.js`: la cabecera de la IIFE y `shouldAnimate()` (líneas 1-44), `armLevels` (45-79), el bloque del rewrite (80-216), el bloque de la rueda **hasta el final de `makeWheel`** (218-437). **No copies** `armPile` viejo, `armScenes`, `armCitationMap`, `armResearchScreen`, `armHeroDeck` ni nada que nombre `.lp-scroller`. Escribe en su lugar:

```js
  /* The wheel turns once when its frame comes into view — half of it, which
     on a phone-tall laptop is the moment it is being looked at — and again
     whenever it is clicked. Nothing here listens to the scroll: the page
     scrolls, the wheel watches. */
  function armPile() {
    var frame = document.querySelector('.lp-pile');
    if (!frame) return;
    var flick = makeWheel(frame);
    if (!flick) return;
    var seen = false;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || seen) return;
        seen = true;
        flick();
        io.disconnect();
      });
    }, { threshold: 0.5 });
    io.observe(frame);
    frame.addEventListener('click', function () { flick(); });
  }

  function init() {
    [].slice.call(document.querySelectorAll('[data-levels]')).forEach(armLevels);
    if (document.documentElement.getAttribute('data-motion') !== 'on' || !shouldAnimate()) return;
    [].slice.call(document.querySelectorAll('[data-rewrite]')).forEach(armRewrite);
    armPile();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
```

- [ ] **Step 6: Pasan** — los dos ficheros de test en verde (salvo «the order of the tramos»). Build. Sonda de la rueda: copia `$OLD/scripts/diagnostics/landing-wheel-audit.mjs` a `scripts/diagnostics/` y adáptala para navegar a `http://localhost:4173/` y scrollear con `window.scrollTo(0, <top de .lp-problem>)` en vez de `.lp-scroller` (busca `lp-scroller` en ella y sustitúyelo por `document.documentElement`); ejecútala: pico ≤ 0,75 filas/fotograma, 0 fotogramas cruzando una fila.

- [ ] **Step 7: Commit** — `git add src/landing scripts/diagnostics/landing-wheel-audit.mjs && git commit -m "feat(landing): el problema con la rueda (gira al entrar, no captura el scroll) y las seis señales"`

---

### Task 7: «Read it in plain words» y «Every card says what it is»

**Files:**
- Modify: `src/landing/page.js` (`plainWords()`, `labels()`), `src/landing/landing.css`, `src/landing/motion.css` (bloques del lector copiados)
- Copy: `$OLD/src/landing/rewriteMotion.test.js`, `$OLD/src/landing/keyframeContrast.test.js` → `src/landing/`
- Test: `src/landing/page.test.js` (+2)

- [ ] **Step 1: Tests que fallan** — copia los dos tests viejos (leen `motion.js`/`motion.css`/`page.js` por ruta relativa: comprueba con `grep -n "new URL" src/landing/rewriteMotion.test.js` que las rutas siguen siendo `./motion.js` y `./page.js`) y añade a `page.test.js`:

```js
test('the reader ships at rest with the finished text, its tabs, a highlight and a note', () => {
  const sec = html.match(/<section class="lp-reader"[\s\S]*?<\/section>/)[0];
  assert.match(sec, /data-rewrite data-levels/);
  assert.match(sec, /role="tablist" aria-label="Rewrite level"/);
  assert.equal((sec.match(/role="tab"/g) || []).length, 3);
  assert.equal((sec.match(/class="lp-hl"/g) || []).length, 1);
  assert.match(sec, /<aside class="lp-note" aria-label="Your note">/);
  assert.match(sec, /data-rewrite-card hidden/);
});
test('five labels, each with its sentence, and no motion', () => {
  const sec = html.match(/<section class="lp-labels"[\s\S]*?<\/section>/)[0];
  assert.deepEqual([...sec.matchAll(/lp-chip lp-chip--\w+">([^<]+)</g)].map((m) => m[1]), ['Verified', 'Preprint', 'Open access', 'Open version', 'Subscription']);
});
```

- [ ] **Step 2: Fallan.**

- [ ] **Step 3: Markup** — copia `plainWords()` de `$OLD/src/landing/page.js` (líneas 271-331) **entera** como `plainWords()`, y cámbiale: la clase de la sección a `lp-reader lp-sec` con `aria-labelledby="lp-reader-h"` (y `id` en su h2); el `<h2 class="lp-h2">` pasa a `class="lp-h2" id="lp-reader-h"`; dentro de `lp-doc__levels`, en el párrafo `j === 0` del nivel `DEFAULT_LEVEL`, envuelve la frase «felt the same tiny stretch of space at the same moment» (que debe existir en `LEVELS[DEFAULT_LEVEL].paras[0]` de `papers.js`; si no, añádela a ese párrafo) con `hl(...)`: sustituye `esc(para)` por `esc(para).replace('felt the same tiny stretch of space at the same moment', hl('felt the same tiny stretch of space at the same moment'))`; y tras `.lp-doc__levels` añade:

```js
<aside class="lp-note" aria-label="Your note"><span class="lp-note__kicker">Your note</span><p>Why 200,000 years? That's the false-alarm rate — ask the model.</p></aside>
```

Escribe `labels()`:

```js
const LABEL_ROWS = [
  [{ label: 'Verified', tone: 'blue' }, 'Passed peer review, according to the record.'],
  [{ label: 'Preprint', tone: 'amber' }, 'Posted before review. Read it as such.'],
  [{ label: 'Open access', tone: 'green' }, 'You can read the whole thing right now.'],
  [{ label: 'Open version', tone: 'green' }, 'The journal charges; a free copy exists elsewhere.'],
  [{ label: 'Subscription', tone: 'amber' }, 'Only the abstract is free. It says so before you click.'],
];
const labels = () => `<section class="lp-labels lp-sec" aria-labelledby="lp-labels-h">
  <div class="lp-wrap lp-cols">
    <div class="lp-head">
      <h2 id="lp-labels-h" class="lp-h2">Every card says what it is.</h2>
      <p class="lp-body">Whether it passed peer review, and whether you can actually read it. When the record doesn't say, the card shows nothing rather than a guess.</p>
    </div>
    <dl class="lp-labels__list">${LABEL_ROWS.map(([c, why]) => `<div class="lp-labels__row"><dt>${chip(c)}</dt><dd>${esc(why)}</dd></div>`).join('')}</dl>
  </div>
</section>`;
```

`screens = [hero(), problem(), signals(), plainWords(), labels(), strip(), close()]`.

- [ ] **Step 4: CSS** — copia de `$OLD/src/landing/landing.css` los bloques `.lp-rewrite*`, `.lp-levels*`, `.lp-panel*`, `.lp-ghost*`, `.lp-doc*`, `.lp-uses*`, `.lp-note` si existe, `.lp-btn--ai` con su `transition` y `:hover` (líneas ~600-760; localízalos con `grep -n 'lp-rewrite\|lp-levels\|lp-ghost\|lp-doc\|lp-uses\|lp-btn--ai' $OLD/src/landing/landing.css`), y de `$OLD/src/landing/motion.css` los bloques «The rewrite levels, on a click» (231-287), «The rewrite, as a sequence» (288-404), las keyframes `lpChromeOut`…`lpShimmer` (406-421), «The invitation» (423-514) y el bloque «Reduced motion» (515-final) sustituyendo el mío de la tarea 5. Añade:

```css
.lp-note { display: flex; flex-direction: column; gap: 8px; margin: 18px 0 0; padding-left: 14px; border-left: 3px solid var(--brand-yellow); }
.lp-note__kicker { font: var(--fw-medium) 0.75rem/1 var(--font-body); color: var(--text-secondary); }
.lp-note p { font: var(--fw-regular) 0.875rem/1.5 var(--font-body); color: var(--text-primary); margin: 0; }
.lp-labels__list { margin: 0; }
.lp-labels__row { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 32px; align-items: center; padding: 18px 0; border-top: 1px solid var(--border-subtle); }
.lp-labels__row:last-child { border-bottom: 1px solid var(--border-subtle); }
.lp-labels__row dt, .lp-labels__row dd { margin: 0; }
.lp-labels__row dd { font-family: var(--font-serif); font-size: 1.25rem; line-height: 1.4; }
@media (max-width: 640px) { .lp-labels__row { grid-template-columns: minmax(0, 1fr); gap: 8px; } }
```

El CSS copiado del lector usa `.lp-eyebrow` (mono en mayúsculas) para el rótulo y el contador de usos: es UI de la app dentro de su ventana. Amplía en `page.test.js` la lista de prefijos permitidos a `/^\.lp-(paper|plate|research|chip|list-card|eyebrow)/` y añade en el mismo test la contrapartida en marcado, para que la excepción no se escape de la ventana:

```js
const outside = html.replace(/<section class="lp-reader"[\s\S]*?<\/section>/, '').replace(/<section class="lp-research"[\s\S]*?<\/section>/, '');
assert.doesNotMatch(outside, /lp-eyebrow/);
```

- [ ] **Step 5: Pasan** — `node --test src/landing/page.test.js src/landing/rewriteMotion.test.js src/landing/keyframeContrast.test.js`. Build. Copia `$OLD/scripts/diagnostics/landing-invite-contrast.mjs` a `scripts/diagnostics/`, cambia su URL a `http://localhost:4173/` y ejecútala en claro y oscuro: peor caso ≥ 4,5:1.

- [ ] **Step 6: Commit** — `git add src/landing scripts/diagnostics/landing-invite-contrast.mjs && git commit -m "feat(landing): el lector con su secuencia, un subrayado y una nota; los cinco chips con su frase"`

---

### Task 8: «Follow the thread» y «Keep what matters»

**Files:**
- Modify: `src/landing/page.js` (`follow()`, `library()`), `src/landing/landing.css`
- Test: `src/landing/page.test.js` (+2)

Estas dos secciones enseñan UI de la app que **no funciona** en la landing: van como `figure` con un resumen en `figcaption` para lectores de pantalla, y sus «botones» son `span`, nunca `<button>` (un control que no hace nada es peor que ninguno).

- [ ] **Step 1: Tests que fallan**

```js
test('the Explorer rows are a figure with a caption, not fake controls', () => {
  const sec = html.match(/<section class="lp-follow"[\s\S]*?<\/section>/)[0];
  assert.match(sec, /<figure class="lp-figure-ui">/);
  assert.match(sec, /<figcaption class="lp-visually-hidden">Three things you can follow: David Card, an author; Gravitational waves, a topic; Universidad de Salamanca, an institution\.<\/figcaption>/);
  assert.equal((sec.match(/<button/g) || []).length, 0);
  assert.match(sec, /<span lang="es">Universidad de Salamanca<\/span>/);
});
test('the four lists are a figure too, with the eight colours as a list of names', () => {
  const sec = html.match(/<section class="lp-library"[\s\S]*?<\/section>/)[0];
  assert.match(sec, /<figcaption class="lp-visually-hidden">Four lists as the app shows them: Favorites, Read later, Reading history and Papers de sugar, which is public\.<\/figcaption>/);
  assert.equal((sec.match(/class="lp-list-card"/g) || []).length, 4);
  assert.equal((sec.match(/class="lp-swatch"/g) || []).length, 8);
  assert.match(sec, /<ul class="lp-swatches" aria-label="The eight list colours">/);
});
```

- [ ] **Step 2: Fallan.**

- [ ] **Step 3: Markup**

```js
const follow = () => `<section class="lp-follow lp-sec" aria-labelledby="lp-follow-h">
  <div class="lp-wrap lp-cols lp-cols--centre">
    <div class="lp-head">
      <h2 id="lp-follow-h" class="lp-h2">Follow the thread.</h2>
      <p class="lp-body">Authors, topics, institutions and projects. Following any of them opens a second feed made only of what they publish, next to the one made for you.</p>
    </div>
    <figure class="lp-figure-ui">
      <figcaption class="lp-visually-hidden">Three things you can follow: David Card, an author; Gravitational waves, a topic; Universidad de Salamanca, an institution.</figcaption>
      <div class="lp-follow__rows" aria-hidden="true">${FOLLOW_ROWS.map((r) => `<div class="lp-follow__row"><span class="lp-follow__icon">${icon(r.kind, 22)}</span><span class="lp-follow__text"><span class="lp-follow__name">${r.lang ? `<span lang="${r.lang}">${esc(r.name)}</span>` : esc(r.name)}</span><span class="lp-follow__sub">${esc(r.sub)}</span></span><span class="lp-btn">Follow</span></div>`).join('')}</div>
    </figure>
  </div>
</section>`;

const SWATCHES = ['ochre', 'olive', 'green', 'teal', 'blue', 'indigo', 'violet', 'crimson'];
const library = () => `<section class="lp-library lp-sec" aria-labelledby="lp-library-h">
  <div class="lp-wrap lp-stack">
    <div class="lp-library__head">
      <div class="lp-head">
        <h2 id="lp-library-h" class="lp-h2">Keep what matters.</h2>
        <p class="lp-body">Save a paper into a list, and the list carries a colour: one of eight, built to sit next to each other and to stay legible as a rule, an icon or a name. Private by default; public if you say so, from your profile.</p>
      </div>
      <ul class="lp-swatches" aria-label="The eight list colours">${SWATCHES.map((s) => `<li class="lp-swatch" style="background: var(--list-${s})"><span class="lp-visually-hidden">${s}</span></li>`).join('')}</ul>
    </div>
    <figure class="lp-figure-ui">
      <figcaption class="lp-visually-hidden">Four lists as the app shows them: Favorites, Read later, Reading history and Papers de sugar, which is public.</figcaption>
      <div class="lp-lists" aria-hidden="true">${LISTS.map((l) => `<div class="lp-list-card" style="--lp-list: ${l.color}"><span class="lp-list-card__icon">${icon(l.icon, 18)}</span><span class="lp-list-card__name">${esc(l.name)}</span><span class="lp-list-card__count">${esc(l.count)}${l.isPublic ? chip({ label: 'Public', tone: 'green' }) : ''}</span><span class="lp-list-card__titles">${l.titles.length ? l.titles.map((t) => `<span>${esc(t)}</span>`).join('') : '<span class="lp-list-card__empty">Nothing saved yet.</span>'}</span></div>`).join('')}</div>
    </figure>
  </div>
</section>`;
```

`screens = [hero(), problem(), signals(), plainWords(), labels(), follow(), library(), strip(), close()]`.

- [ ] **Step 4: CSS**

```css
.lp-figure-ui { margin: 0; }
.lp-follow__rows { display: flex; flex-direction: column; }
.lp-follow__row { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; gap: 20px; align-items: center; padding: 22px 0; border-top: 1px solid var(--border-subtle); }
.lp-follow__row:last-child { border-bottom: 1px solid var(--border-subtle); }
.lp-follow__icon { width: 56px; height: 56px; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--bg-sunken); display: flex; align-items: center; justify-content: center; }
.lp-follow__text { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.lp-follow__name { font-family: var(--font-serif); font-size: 1.5rem; font-weight: var(--fw-semibold); line-height: 1.15; }
.lp-follow__sub { font: var(--fw-regular) 0.75rem/1.3 var(--font-mono); color: var(--text-secondary); }
.lp-stack { display: flex; flex-direction: column; gap: 48px; }
.lp-library__head { display: grid; grid-template-columns: 420px minmax(0, 1fr); gap: 96px; align-items: end; }
.lp-swatches { list-style: none; margin: 0; padding: 0; display: flex; gap: 10px; justify-content: flex-end; }
.lp-swatch { width: 28px; height: 28px; border-radius: var(--radius-lg); }
.lp-lists { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px; }
.lp-list-card { border: 1px solid var(--border-subtle); border-left: 3px solid var(--lp-list); border-radius: var(--radius-lg); background: var(--bg-card); padding: 24px 22px 22px; display: flex; flex-direction: column; gap: 14px; min-height: 220px; }
.lp-list-card__icon { width: 40px; height: 40px; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--bg-sunken); display: flex; align-items: center; justify-content: center; color: var(--lp-list); }
.lp-list-card__name { font-family: var(--font-serif); font-size: 1.25rem; font-weight: var(--fw-semibold); line-height: 1.2; }
.lp-list-card__count { display: flex; align-items: center; gap: 10px; font: var(--fw-medium) 0.6875rem/1 var(--font-mono); letter-spacing: var(--mono-track); text-transform: uppercase; color: var(--text-secondary); }
.lp-list-card__titles { border-top: 1px solid var(--border-subtle); padding-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.lp-list-card__titles span { font-family: var(--font-serif); font-size: 0.9375rem; line-height: 1.35; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lp-list-card__empty { font-family: var(--font-body) !important; color: var(--text-tertiary) !important; }
@media (max-width: 1000px) { .lp-library__head { grid-template-columns: minmax(0, 1fr); gap: 24px; } .lp-swatches { justify-content: flex-start; } .lp-lists { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .lp-follow__row { grid-template-columns: 44px minmax(0, 1fr); } .lp-follow__row .lp-btn { grid-column: 2; justify-self: start; } .lp-follow__icon { width: 44px; height: 44px; } }
```

Ojo: `.lp-list-card__count` usa `text-transform: uppercase` y el test de la tarea 5 solo lo permite en `.lp-paper|plate|research|chip`: **es UI de la app**, así que añade `list-card` a esa expresión regular del test (`/^\.lp-(paper|plate|research|chip|list-card)/`) en este mismo commit, con un comentario de por qué.

- [ ] **Step 5: Pasan.** Build. Captura y mira las dos secciones a 1440 y 390.
- [ ] **Step 6: Commit** — `git commit -am "feat(landing): Siguiendo y la biblioteca como ventanas de la app, con su resumen para lectores de pantalla"`

---

### Task 9: El mapa, la edición de Research

**Files:**
- Create: `src/landing/graphMap.js` (sustituye al temporal), `src/landing/graphMap.test.js`
- Modify: `src/landing/page.js` (`citationMap()`, `research()`), `src/landing/landing.css`, `src/landing/motion.css` (dibujado del mapa)
- Test: `src/landing/page.test.js` (el test del orden pasa al final de esta tarea)

**Interfaces:**
- Produces: `citationPlate(map, { compact = false } = {}): string` — SVG con clases `mp-spoke`, `mp-node`, `mp-label` y `style="--i: n"` por elemento; `compact` da la plancha de móvil (3 + 1 nodos, tres marcas).

- [ ] **Step 1: Tests que fallan**

```js
// src/landing/graphMap.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citationPlate } from './graphMap.js';
import { MAP } from './papers.js';

const svg = citationPlate(MAP);
test('every node sits inside the plate and the centre label sits left of the dot with the rule cut around it', () => {
  for (const m of svg.matchAll(/<circle class="mp-node[^"]*"[^>]*cx="([\d.]+)"/g)) assert.ok(Number(m[1]) <= 1150, m[1]);
  assert.match(svg, /<text class="mp-label"[^>]*text-anchor="end"[^>]*>THIS PAPER · 2016<\/text>/);
  const rules = [...svg.matchAll(/<line class="mp-rule"[^>]*x1="([\d.]+)"[^>]*x2="([\d.]+)"/g)];
  assert.equal(rules.length, 2, 'the rule is two segments');
});
test('the draw-on order starts at the centre and runs oldest to newest', () => {
  const orders = [...svg.matchAll(/class="mp-node[^"]*" style="--i: (\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(orders.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
});
test('the svg is one image for assistive tech, with its own title', () => {
  assert.match(svg, /<svg[^>]*role="img"[^>]*aria-labelledby="lp-map-title"/);
  assert.match(svg, /<title id="lp-map-title">/);
});
test('the compact plate has fewer nodes and three axis marks', () => {
  const c = citationPlate(MAP, { compact: true });
  assert.equal((c.match(/class="mp-node"/g) || []).length, 4);
  assert.deepEqual([...c.matchAll(/class="mp-tick">([^<]+)</g)].map((m) => m[1]), ['1', '100', '10K']);
});
```

y en `page.test.js`:

```js
test('the map is an svg with a text alternative list beside it', () => {
  const sec = html.match(/<section class="lp-map"[\s\S]*?<\/section>/)[0];
  assert.equal((sec.match(/<svg/g) || []).length, 2, 'the wide and the compact plate');
  assert.match(sec, /<ul class="lp-visually-hidden" id="lp-map-list">/);
  assert.equal((sec.match(/<ul class="lp-visually-hidden" id="lp-map-list">[\s\S]*?<\/ul>/)[0].match(/<li>/g) || []).length, 7);
});
test('the edition is a window with a caption, cut with a fade, its percentages the real ones', () => {
  const sec = html.match(/<section class="lp-research"[\s\S]*?<\/section>/)[0];
  assert.match(sec, /<figure class="lp-window">/);
  assert.match(sec, /\+69%/); assert.match(sec, /\+47%/);
  assert.doesNotMatch(sec, /\+115%|\+87%/);
  assert.doesNotMatch(sec, /data-research-anchor|lp-pin/);
});
```

- [ ] **Step 2: Fallan.**

- [ ] **Step 3: `graphMap.js`**

```js
/**
 * The citation map as one SVG: what the paper cites above the rule, what
 * cites it below, citations received on a log axis. Built from frozen data
 * (papers.js MAP). Every node, spoke and label carries `--i`, its draw-on
 * order, so motion.css can stagger them without a script.
 */
const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

export function citationPlate(map, { compact = false } = {}) {
  const W = compact ? 360 : 1200, H = compact ? 380 : 520, R = compact ? 190 : 276;
  const CX = compact ? 40 : 220, GAP = 16, LABEL_W = compact ? 0 : 126;
  const perDecade = compact ? 75 : 220, x0 = compact ? 40 : 300;
  const lx = (c) => Math.min(compact ? 340 : 1150, x0 + Math.log10(Math.max(c, 1)) * perDecade);
  const ticks = compact ? [['1', 0], ['100', 2], ['10K', 4]] : [['1', 0], ['10', 1], ['100', 2], ['1K', 3], ['10K', 4]];
  const above = compact ? map.above.slice(0, 3) : map.above;
  const below = compact ? map.below.slice(0, 1) : map.below;
  const yScale = compact ? H / 520 : 1;
  const node = (n, filled) => `<line class="mp-spoke" style="--i: ${n.order}" pathLength="1" x1="${CX}" y1="${R}" x2="${lx(n.citations)}" y2="${n.y * yScale}" stroke="var(--border-subtle)" stroke-width="1"></line><circle class="mp-node" style="--i: ${n.order}" cx="${lx(n.citations)}" cy="${n.y * yScale}" r="6" fill="${filled ? 'var(--gradient-physics)' : 'var(--bg-primary)'}" stroke="var(--gradient-physics)" stroke-width="2"></circle>${compact ? '' : `<text class="mp-label" style="--i: ${n.order}" x="${lx(n.citations) - 12}" y="${n.y + 4}" text-anchor="end" font-family="${MONO}" font-size="12" fill="var(--text-primary)">${n.name}</text>`}`;
  const corner = (x, y, anchor, text) => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${MONO}" font-size="11" letter-spacing="0.06em" fill="var(--text-secondary)">${text}</text>`;
  return `<svg class="lp-plate${compact ? ' lp-plate--compact' : ''}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="lp-map-title${compact ? '-compact' : ''}" xmlns="http://www.w3.org/2000/svg">
    <title id="lp-map-title${compact ? '-compact' : ''}">The citation map of the LIGO paper: five works it cites above the line, two that cite it below, placed by how many citations each received.</title>
    ${ticks.map(([, d]) => `<line x1="${x0 + d * perDecade}" y1="36" x2="${x0 + d * perDecade}" y2="${H - 44}" stroke="var(--border-subtle)"></line>`).join('')}
    ${compact ? '' : corner(0, 24, 'start', 'BEFORE · WHAT IT CITES') + corner(W, 24, 'end', `${map.above.length} MOST CITED OF ${map.totals.cited}`)}
    <line class="mp-rule" x1="0" y1="${R}" x2="${Math.max(0, CX - 9 - GAP - LABEL_W - GAP)}" y2="${R}" stroke="var(--text-primary)" stroke-width="1.2"></line>
    <line class="mp-rule" x1="${CX + 9 + GAP}" y1="${R}" x2="${W}" y2="${R}" stroke="var(--text-primary)" stroke-width="1.2"></line>
    ${above.map((n) => node(n, false)).join('')}
    ${below.map((n) => node(n, true)).join('')}
    <circle class="mp-node mp-node--centre" style="--i: 0" cx="${CX}" cy="${R}" r="9" fill="var(--text-primary)"></circle>
    ${compact ? '' : `<text class="mp-label" style="--i: 0" x="${CX - 9 - GAP}" y="${R + 4}" text-anchor="end" font-family="${MONO}" font-size="12" font-weight="600" fill="var(--text-primary)">${map.centre.label}</text>`}
    ${compact ? '' : corner(0, H - 22, 'start', 'AFTER · WHAT CITES IT') + corner(W, H - 22, 'end', `${map.below.length} MOST RECENT OF ${map.totals.citing.toLocaleString('en-US')}`)}
    ${ticks.map(([label, d]) => `<text class="mp-tick" x="${x0 + d * perDecade}" y="${H - 4}" text-anchor="middle" font-family="${MONO}" font-size="11" fill="var(--text-tertiary)">${label}</text>`).join('')}
    ${compact ? '' : `<text x="${W / 2}" y="${H - 22}" text-anchor="middle" font-family="${MONO}" font-size="11" fill="var(--text-tertiary)">citations received, log scale</text>`}
  </svg>`;
}
```

- [ ] **Step 4: Markup** — `citationMap()` y `research()`:

```js
const citationMap = () => `<section class="lp-map lp-sec" aria-labelledby="lp-map-h">
  <div class="lp-wrap lp-stack">
    <div class="lp-map__head">
      <h2 id="lp-map-h" class="lp-h2">Every paper, on the map of what it came from.</h2>
      <p class="lp-body lp-body--wide">What it cites above the line, what cites it below, and how far each one travelled. Walk the graph node by node; a work with unknown data is counted as such, not invented into a position.</p>
    </div>
    <div class="lp-map__plate" data-map>${citationPlate(MAP)}${citationPlate(MAP, { compact: true })}</div>
    <ul class="lp-visually-hidden" id="lp-map-list">${[...MAP.above.map((n) => `<li>Cites ${esc(n.name)}, ${n.citations.toLocaleString('en-US')} citations</li>`), ...MAP.below.map((n) => `<li>Cited by ${esc(n.name)}, ${n.citations.toLocaleString('en-US')} citations</li>`)].join('')}</ul>
  </div>
</section>`;
```

Para `research()`: copia de `$OLD/src/landing/page.js` la función `brief()` (344-350) y `research()` (358-433) **quitando** `lp-screen--free`, el `<div class="lp-pin" data-research-anchor><div class="lp-pin__stage">` y sus cierres, y envolviendo `<div class="lp-research">…</div>` en `<figure class="lp-window"><figcaption class="lp-visually-hidden">The Research edition for the last seven days: a lead story, eleven selected papers, and the topics growing fastest.</figcaption><div class="lp-window__inner" aria-hidden="true">…</div></figure>`; la sección pasa a `class="lp-research lp-sec" aria-labelledby="lp-research-h"` y su h2 lleva ese id. En el carril, `t.pct` y `t.worksLabel` (tarea 4) sustituyen a `t.pct`/`t.works` viejos. Quita el bloque `.lp-turn` (`RESEARCH.turn`) del marcado: la ventana se corta antes.

`screens = [hero(), problem(), signals(), plainWords(), labels(), follow(), library(), citationMap(), research(), strip(), close()]`.

- [ ] **Step 5: CSS** — copia de `$OLD/src/landing/landing.css` los bloques `.lp-research*`, `.lp-brief*`, `.lp-stat*`, `.lp-topic*`, `.lp-topics__head`, `.lp-forme*`, `.lp-runhead*`, `.lp-period*` (~880-1100; `grep -n` para localizarlos) y **no** `.lp-pin*` ni `.lp-screen--free`. Varios de esos selectores llevan `text-transform: uppercase` (son la UI de la edición): amplía la lista de prefijos permitidos de `page.test.js` a `/^\.lp-(paper|plate|research|chip|list-card|eyebrow|brief|stat|topic|runhead|forme|period)/` — la aserción de marcado de la tarea 7 sigue garantizando que nada de eso aparece fuera de las dos ventanas. Añade:

```css
.lp-map__head { display: grid; grid-template-columns: 560px minmax(0, 1fr); gap: 96px; align-items: end; }
.lp-body--wide { max-width: 46ch; }
.lp-plate { display: block; width: 100%; height: auto; }
.lp-plate--compact { display: none; }
.lp-window { margin: 0; position: relative; height: 880px; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 78%, rgba(0,0,0,0)); mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 78%, rgba(0,0,0,0)); }
.lp-window__inner { border: 1px solid var(--border-subtle); border-bottom: none; border-radius: var(--radius-lg) var(--radius-lg) 0 0; background: var(--bg-card); padding: 36px 40px 0; }
@media (max-width: 1000px) { .lp-map__head { grid-template-columns: minmax(0, 1fr); gap: 20px; } }
@media (max-width: 700px) { .lp-plate { display: none; } .lp-plate--compact { display: block; } .lp-window { height: 720px; } .lp-window__inner { padding: 24px 20px 0; } }
```

En `motion.css` (el dibujado; solo con la puerta abierta, y una vez):

```css
/* The map draws itself once, when `is-in` lands (motion.js, IntersectionObserver).
   Spokes from the centre out, nodes popping in behind them, labels last;
   the order is chronological and `--i` is set on each element itself. */
[data-motion="on"] .mp-spoke { stroke-dasharray: 1; stroke-dashoffset: 1; }
[data-motion="on"] .mp-node { opacity: 0; transform: scale(0.6); transform-box: fill-box; transform-origin: center; }
[data-motion="on"] .mp-label { opacity: 0; }
[data-motion="on"] .is-in .mp-spoke { animation: lpMapDraw 320ms var(--ease-out-cubic) both; animation-delay: calc(var(--i) * 70ms); }
[data-motion="on"] .is-in .mp-node { animation: lpMapPop 320ms var(--ease-out-cubic) both; animation-delay: calc(var(--i) * 70ms + 120ms); }
[data-motion="on"] .is-in .mp-node--centre { animation-delay: 0ms; }
[data-motion="on"] .is-in .mp-label { animation: lpMapFade 240ms linear both; animation-delay: calc(var(--i) * 70ms + 200ms); }
@keyframes lpMapDraw { to { stroke-dashoffset: 0; } }
@keyframes lpMapPop { to { opacity: 1; transform: scale(1); } }
@keyframes lpMapFade { to { opacity: 1; } }
```

y en `motion.js`, en `init()` tras `armPile();`: `armMap();` con

```js
  function armMap() {
    var plate = document.querySelector('[data-map]');
    if (!plate) return;
    var io = new IntersectionObserver(function (entries) {
      if (!entries.some(function (e) { return e.isIntersecting; })) return;
      plate.classList.add('is-in');
      io.disconnect();
    }, { threshold: 0.4 });
    io.observe(plate);
  }
```

- [ ] **Step 6: Pasan** — `node --test src/landing/*.test.js` → todo `ok`, incluido «the order of the tramos». Build. Capturas a 1440 y 390.
- [ ] **Step 7: Commit** — `git add src/landing && git commit -m "feat(landing): el mapa de citas (cinco y dos, se dibuja al entrar) y Research como ventana"`

---

### Task 10: El mazo y el subrayado en movimiento

**Files:**
- Create: `src/landing/deck.js`, `src/landing/deck.test.js`, `src/landing/highlightContrast.test.js`
- Modify: `src/landing/motion.js` (`armDeck`, `armReveals`), `src/landing/motion.css`, `src/landing/landing.css` (`.lp-deck` altura)

**Interfaces:**
- Produces: `createDeck({ count, index = 0 })` → `{ index(), next(), prev(), atClone() }` donde `next()` devuelve el índice nuevo (0…count, siendo `count` el clon) y `prev()` desde 0 salta primero al clon. `armDeck()` en `motion.js` consume `[data-deck]`, `[data-deck-reel]`, `[data-deck-skip]`, `[data-deck-count]`.

- [ ] **Step 1: Tests que fallan**

```js
// src/landing/deck.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeck } from './deck.js';

test('next walks the three papers and then onto the clone, which is the first again', () => {
  const d = createDeck({ count: 3 });
  assert.deepEqual([d.next(), d.next(), d.next()], [1, 2, 3]);
  assert.equal(d.atClone(), true);
  assert.equal(d.settle(), 0, 'landing on the clone settles to 0 without travel');
  assert.equal(d.index(), 0);
});
test('next while the clone is still travelling does nothing', () => {
  const d = createDeck({ count: 3 });
  d.next(); d.next(); d.next();
  assert.equal(d.next(), 3);
});
test('prev from the first paper goes through the clone to the last', () => {
  const d = createDeck({ count: 3 });
  assert.deepEqual(d.prev(), { jumpTo: 3, index: 2 });
  assert.equal(d.index(), 2);
});
test('the counter never says 4 of 3', () => {
  const d = createDeck({ count: 3 });
  d.next(); d.next(); d.next();
  assert.equal(d.label(), '1 / 3');
});
```

```js
// src/landing/highlightContrast.test.js — the highlight, both themes, both forms
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const vars = readFileSync(fileURLToPath(new URL('../styles/variables.css', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('./landing.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const token = (block, name) => block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const light = vars.split('[data-theme')[0];
const dark = vars.slice(vars.indexOf('[data-theme="dark"]'));

test('on paper the band sits under ink: ink on yellow clears 4.5:1 by a mile', () => {
  assert.ok(ratio(token(light, '--text-primary'), token(light, '--brand-yellow')) >= 4.5);
  assert.match(css, /\.lp-hl \{[^}]*box-shadow: inset 0 -0\.42em 0 var\(--brand-yellow\)/);
});
test('on ink the highlight is a rule below the baseline, not a band: the glyphs keep their own contrast', () => {
  const rule = css.match(/\[data-theme="dark"\] \.lp-hl, \.lp-close \.lp-hl \{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /box-shadow: none/);
  assert.match(rule, /text-decoration: underline/);
  assert.match(rule, /text-decoration-thickness: 0\.08em/);
  assert.match(rule, /text-decoration-skip-ink: auto/);
  assert.ok(ratio(token(dark, '--text-primary'), token(dark, '--bg-primary')) >= 4.5);
});
```

- [ ] **Step 2: Fallan.**

- [ ] **Step 3: `deck.js`**

```js
/**
 * The deck's index, and nothing else: which paper is on the sheet, what Skip
 * does at the end (goes on to the clone of the first, which the DOM driver
 * then swaps for the real first without travel), and what the counter says.
 * Pure, so it is tested without a DOM; the driver in motion.js owns the
 * transition, the keys and the focus.
 */
export function createDeck({ count, index = 0 } = {}) {
  let i = index;
  const label = () => `${(i % count) + 1} / ${count}`;
  return {
    index: () => i,
    label,
    atClone: () => i === count,
    /* Forward, or nothing while the clone is still travelling. */
    next() { if (i < count) i += 1; return i; },
    /* Backward; from the first, the driver jumps to the clone first (no
       travel) and then travels back to the last. */
    prev() { if (i === 0) { i = count - 1; return { jumpTo: count, index: i }; } i -= 1; return { jumpTo: null, index: i }; },
    /* Once the clone has arrived, the real first takes its place. */
    settle() { if (i === count) i = 0; return i; },
  };
}
```

- [ ] **Step 4: `motion.js`** — `motion.js` es una IIFE sin imports, así que **inserta `createDeck` en ella** copiando la función de `deck.js` (mismo texto; `deck.test.js` prueba el módulo y `page.test.js`/la sonda prueban el driver). Añade el driver y llámalo en `init()` **antes** de la puerta de `data-motion` (el mazo responde al usuario y funciona también en táctil):

```js
  /* The deck. The reel is a stack of four slides — three papers and a clone
     of the first — laid out by translateY; Skip and the arrow keys move it
     one slide, the transition (motion.css) carries it, and when the clone
     lands the reel jumps back to the first without a frame of travel. Slides
     not on the sheet are inert and aria-hidden so a keyboard cannot reach
     what a sighted reader cannot see. */
  function armDeck() {
    var sheet = document.querySelector('[data-deck]');
    var reel = sheet && sheet.querySelector('[data-deck-reel]');
    var skip = sheet && sheet.querySelector('[data-deck-skip]');
    var count = sheet && sheet.querySelector('[data-deck-count]');
    if (!sheet || !reel || !skip || !count) return;
    var slides = [].slice.call(reel.children);
    var deck = createDeck({ count: slides.length });
    var clone = slides[0].cloneNode(true);
    clone.setAttribute('aria-hidden', 'true'); clone.inert = true; clone.classList.add('lp-hero__slide--clone');
    reel.appendChild(clone);
    var all = slides.concat([clone]);
    var h = 0;
    function measure() {
      h = 0;
      all.forEach(function (s) { h = Math.max(h, s.offsetHeight); });
      reel.style.height = h + 'px';
      all.forEach(function (s, k) { s.style.transform = 'translateY(' + (k * 100) + '%)'; });
    }
    function show(k) {
      all.forEach(function (s, j) {
        var on = j === k;
        s.inert = !on; if (on) s.removeAttribute('aria-hidden'); else s.setAttribute('aria-hidden', 'true');
      });
      count.textContent = deck.label();
    }
    function paint() { reel.style.transform = 'translateY(' + (-deck.index() * h) + 'px)'; }
    function jump(k) {
      reel.classList.add('is-jumping');
      reel.style.transform = 'translateY(' + (-k * h) + 'px)';
      void reel.offsetHeight;
      reel.classList.remove('is-jumping');
    }
    reel.addEventListener('transitionend', function (e) {
      if (e.target !== reel || !deck.atClone()) return;
      deck.settle(); jump(0); show(0);
    });
    function next() {
      var k = deck.next(); paint();
      if (deck.atClone()) { show(slides.length); if (reduced()) { deck.settle(); jump(0); show(0); } } else show(k);
    }
    function prev() {
      var r = deck.prev();
      if (r.jumpTo !== null) jump(r.jumpTo);
      paint(); show(r.index);
    }
    function reduced() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    skip.hidden = false;
    skip.addEventListener('click', function () { next(); sheet.focus({ preventScroll: true }); });
    sheet.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); next(); }
      if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); prev(); }
    });
    window.addEventListener('resize', function () { measure(); jump(deck.index()); });
    measure(); show(0); paint();
    sheet.classList.add('is-armed');
  }
```

y `armReveals()` para los subrayados, tras `armMap()` dentro de la puerta:

```js
  function armReveals() {
    var marks = [].slice.call(document.querySelectorAll('.lp-hl'));
    if (!marks.length) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
    }, { threshold: 1 });
    marks.forEach(function (m) { io.observe(m); });
  }
```

- [ ] **Step 5: CSS** — en `landing.css`: `.lp-hero__slide { position: absolute; inset: 0 0 auto 0; }` y `.lp-sheet.is-armed .lp-deck__reel { transition: transform 400ms var(--ease-out-cubic); will-change: transform; }`, `.lp-deck__reel.is-jumping { transition: none; }`. En `motion.css`:

```css
/* The highlight draws on, left to right, once its sentence is fully in view.
   background-size is paint, not layout, and — unlike a pseudo-element —
   survives a span broken across two lines (box-decoration-break: clone). */
[data-motion="on"] .lp-hl:not(.lp-close .lp-hl) { box-shadow: none; background-image: linear-gradient(var(--brand-yellow), var(--brand-yellow)); background-repeat: no-repeat; background-position: 0 100%; background-size: 0% 42%; transition: background-size 480ms var(--ease-out-cubic); }
[data-motion="on"] .lp-hl.is-in:not(.lp-close .lp-hl) { background-size: 100% 42%; }
[data-motion="on"][data-theme="dark"] .lp-hl { background-image: none; transition: none; }
@media (prefers-reduced-motion: reduce) {
  .lp-deck__reel { transition: none !important; }
  [data-motion="on"] .lp-hl { transition: none; background-size: 100% 42%; }
}
```

- [ ] **Step 6: Pasan** — `node --test src/landing/*.test.js`. Build. Sonda: adapta `probe-motion.mjs` del scratchpad (`/private/tmp/claude-501/-Users-nicolasmunozgarcia-Developer-papertok/c38254f4-664d-4801-8b85-4a0cae02dfe0/scratchpad/landing-directions/probe-motion.mjs`) como `scripts/diagnostics/landing-deck-probe.mjs`: navega a `http://localhost:4173/`, pulsa `[data-deck-skip]` tres veces con 600 ms entre pulsaciones y comprueba que `[data-deck-count]` dice `2 / 3`, `3 / 3`, `1 / 3`, que el `transform` del carrete vuelve a `translateY(0px)` y que `document.activeElement` es la hoja; y con `Emulation.setEmulatedMedia({ features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })` que el cambio es inmediato. Ejecútala.

- [ ] **Step 7: Commit** — `git add src/landing scripts/diagnostics/landing-deck-probe.mjs && git commit -m "feat(landing): el mazo se pasa con Skip y las flechas, y el subrayado se traza al entrar"`

---

### Task 11: Accesibilidad en móvil — auditoría automática y manual

**Files:**
- Create: `scripts/diagnostics/landing-axe.mjs`, `src/landing/a11y.test.js`
- Modify: `package.json` (`axe-core` en `devDependencies`), `src/landing/landing.css` (lo que la auditoría saque)
- Docs: `docs/ACCESIBILIDAD-EVIDENCIA.md` (una sección nueva «Landing 2026-09»)

- [ ] **Step 1: Tests que fallan** (estructura, lo que la fuente puede garantizar)

```js
// src/landing/a11y.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLandingHtml } from './page.js';

const html = buildLandingHtml();
const doc = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('./landing.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const shared = readFileSync(fileURLToPath(new URL('../legal/static-page.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('language is declared on the document and on the Spanish name', () => {
  assert.match(doc, /<html lang="en">/);
  assert.match(html, /<span lang="es">Universidad de Salamanca<\/span>/);
});
test('every interactive element has an accessible name and no icon-only control goes unnamed', () => {
  for (const m of html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const attrs = m[2], inner = m[3].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
    assert.ok(inner.length > 0 || /aria-label="[^"]+"/.test(attrs), m[0].slice(0, 80));
  }
});
test('every svg is either decorative (aria-hidden) or an image with a title', () => {
  for (const m of html.matchAll(/<svg\b([^>]*)>/g)) {
    assert.ok(/aria-hidden="true"/.test(m[1]) || /role="img"/.test(m[1]), m[0]);
  }
});
test('no focus outline is ever removed', () => {
  assert.doesNotMatch(css + shared, /outline:\s*(none|0)\b/);
});
test('touch targets are 44px on phones: Skip, bar links, footer links, the two CTAs', () => {
  assert.match(shared, /\.lp-bar__link \{[^}]*min-height: 44px/);
  assert.match(shared, /\.lp-footer a \{[^}]*min-height: 44px/);
  assert.match(css, /\.lp-deck__skip \{[^}]*min-height: 44px/);
  assert.match(shared, /\.lp-btn--lg \{[^}]*min-height: 52px/);
});
test('the UI figures hide their fake controls from assistive tech and describe themselves', () => {
  assert.equal((html.match(/<figure class="lp-figure-ui">/g) || []).length, 2);
  assert.equal((html.match(/<figcaption class="lp-visually-hidden">/g) || []).length, 3);
  for (const m of html.matchAll(/<figure class="lp-(figure-ui|window)">[\s\S]*?<\/figure>/g)) {
    assert.match(m[0], /aria-hidden="true"/);
    assert.doesNotMatch(m[0], /<button|<a /);
  }
});
test('heading levels never skip: h1, then h2 per section, h3 only under an h2', () => {
  const levels = [...html.matchAll(/<h([1-3])\b/g)].map((m) => Number(m[1]));
  let last = 0;
  for (const l of levels) { assert.ok(l <= last + 1, `h${l} after h${last}`); last = l; }
});
```

- [ ] **Step 2: Corre y arregla** — `node --test src/landing/a11y.test.js`; lo que falle se arregla en `page.js`/CSS (no en el test) salvo que el test esté mal escrito.

- [ ] **Step 3: axe en Chrome headless** — `npm install --save-dev axe-core@4` y escribe `scripts/diagnostics/landing-axe.mjs` sobre el mismo esqueleto CDP de `landing-shots.mjs` (spawn de Chrome, `Emulation.setDeviceMetricsOverride`, `Page.navigate`): tras cargar, `Runtime.evaluate` con el texto de `node_modules/axe-core/axe.min.js` seguido de `axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] })` con `awaitPromise`, en **tres** configuraciones: 390×844 con `mobile: true` y `Emulation.setTouchEmulationEnabled`, 390 con `prefers-color-scheme: dark`, y 1440×900; imprime `violations` con `id`, `impact`, `nodes.length` y el primer `target`; sal con código 1 si hay alguna. Añade a `package.json` el script `"a11y:landing": "node scripts/diagnostics/landing-axe.mjs http://localhost:4173/"`. Ejecútalo contra `vite preview` y deja cero violaciones (los falsos positivos, si los hay, se justifican en el fichero de evidencia, nunca se silencian con `disableRules`).

- [ ] **Step 4: Reflow y zoom** — en la misma sonda, a 320×568 y a 390, comprueba `document.documentElement.scrollWidth <= window.innerWidth` (sin scroll horizontal) y que ningún texto de cuerpo baja de 16 px (`getComputedStyle(p).fontSize` sobre todos los `p.lp-body, .lp-strip p`); a 1440 con `Emulation.setDeviceMetricsOverride({ deviceScaleFactor: 2, width: 720 })` (equivalente a zoom 200 %) que tampoco hay scroll horizontal.

- [ ] **Step 5: Comprobación manual, y anótala** — con el teclado en Chrome de escritorio (Tab desde el principio): el enlace de salto aparece y lleva a `main`; la hoja recibe foco con anillo visible; ↓/↑ mueven el mazo y no la página; Tab sale de la hoja al Skip y de ahí a las pestañas del lector cuando está `done`; ningún foco cae en las figuras. Con VoiceOver en iOS (o el simulador) sobre `http://<ip-local>:4173/`: el rotor de encabezados lista h1 + once h2; la rueda no se lee, la lista sí; el mapa se anuncia como imagen con su título; el contador del mazo se anuncia al pulsar Skip. Escribe la sección «Landing (2026-09)» en `docs/ACCESIBILIDAD-EVIDENCIA.md` con lo comprobado, con qué y qué no (misma estructura que las secciones existentes).

- [ ] **Step 6: Commit** — `git add package.json package-lock.json scripts/diagnostics/landing-axe.mjs src/landing docs/ACCESIBILIDAD-EVIDENCIA.md && git commit -m "a11y(landing): auditoría con axe a 390 y 1440, reflow a 320, y la evidencia manual"`

---

### Task 12: Verificación final, presupuesto y entrega

**Files:**
- Create: `scripts/diagnostics/landing-shots.mjs` (definitivo: el `shots.mjs` del scratchpad con `WIDTH`/`THEME`)
- Modify: `docs/superpowers/specs/2026-09-17-landing-rediseno-design.md` (§9: `createDeck` es nuevo y puro, no el viejo; §2: la migración de `/` **sí** entra)
- Modify: `README.md` (el enlace «Open PaperTok» pasa a `https://papertok.app/feed`)

- [ ] **Step 1: Suite completa** — `node --test 'src/**/*.test.js'` → 0 fallos. `npm run build` (con las variables) → sin errores; `gzip -c dist/index.html | wc -c` + el CSS y el JS de la landing (`dist/assets/landing-*.css`, `dist/assets/landing-*.js`) suman ≤ 30 720 bytes; anota los tres números.
- [ ] **Step 2: Capturas** — `vite preview` y `node scripts/diagnostics/landing-shots.mjs http://localhost:4173/ /tmp/lp/final 1000` a 1440, `WIDTH=1280`, `WIDTH=390`, cada una también con `THEME=dark`. Míralas todas. Cualquier defecto se arregla y se vuelve a capturar; no se da nada por bueno sin mirar.
- [ ] **Step 3: Las tres puertas de entrada, en preview** — con CDP: (a) `localStorage.papertok_signed_in = '1'` y navegar a `/` → la URL final es `/feed`; (b) navegar a `/#/public/paper/abc` → `/feed#/public/paper/abc`; (c) sin marca ni hash → se queda en `/` y `document.title` es el de la landing. (d) `/feed` sirve la app (`#root`). (e) `/privacy.html` sigue sirviendo la política.
- [ ] **Step 4: Sondas de movimiento** — `landing-wheel-audit.mjs`, `landing-invite-contrast.mjs`, `landing-deck-probe.mjs` en verde.
- [ ] **Step 5: Spec y README** — corrige los dos puntos de la spec y el enlace del README; commit `docs(landing): la spec refleja el mazo puro y la migración de /`.
- [ ] **Step 6: PR** — `git push -u origin HEAD` y `gh pr create` con título «La landing: dirección B, once tramos, solo para quien no tiene sesión» y un cuerpo que liste: qué ve quien no tiene sesión, qué hace la marca, las tres puertas de entrada comprobadas, el presupuesto medido, la auditoría axe (0 violaciones a 390/1440), la evidencia manual, y las capturas adjuntas (súbelas con `gh pr comment --body-file` o pégalas). Terminar con la línea de atribución.

**Tras fusionar (no antes):** vigilar el primer despliegue en Vercel con `curl -sI https://papertok.app/feed` (200, `content-type: text/html`), `curl -s https://papertok.app/ | grep -c main-content` (1) y abrir `papertok.app/#/` desde un navegador sin sesión para ver la redirección; el service worker de los visitantes con sesión se actualiza solo (`skipWaiting`) y su `start_url` nuevo se aplica al reinstalar el PWA.

---

## Self-review (hecho al escribir el plan)

- **Cobertura de la spec:** §3 tramos → tareas 5–9; §4 sistema → 5; §5 contratos → 6 (rueda), 7 (lector), 9 (mapa, Research), 10 (mazo); §6 movimiento → 6, 9, 10; §7 móvil → CSS de cada tarea + 11; §8 tema oscuro → 5 (`.lp-hl`, `.lp-close`), 10 (test de contraste), 11 (axe en oscuro); §9 construcción → 1–3, 12; §10 criterios → `page.test.js` (1, 2, 3, 8), `deck.test.js`/sonda (4), `wheel.test.js` (5), `graphMap.test.js` (6), `highlightContrast.test.js` + `keyframeContrast.test.js` (7), tarea 12 (9, 10). **Lo que la spec decía y el plan cambia:** `createDeck` viejo no se reutiliza (era gestos de rueda); la migración de `/` entra (tareas 2–3); el subrayado en oscuro dentro del lector también es filete (spec §4 ya lo decía para «todo el tema oscuro»).
- **Placeholders:** ninguno; los «copia las líneas N–M» llevan el `grep -n` con el que localizarlas.
- **Consistencia de nombres:** `data-deck`, `data-deck-reel`, `data-deck-skip`, `data-deck-count` (5 y 10); `.lp-hl` (5, 7, 10); `mp-spoke/mp-node/mp-label/mp-rule/mp-tick` (9); `armPile/armMap/armReveals/armDeck` (6, 9, 10); `SIGNALS/FOLLOW_ROWS/LISTS/MAP` (4, 6, 8, 9); `papertok_signed_in` (2, 3).

---

# Añadido (2026-09-18): las rutas de la app dejan de vivir en el fragmento

**Pedido por Nicolás a mitad de ejecución:** que el feed pase de `papertok.app/#/` a
`papertok.app/feed`, y que Siguiendo y Research vivan en `papertok.app/following` y
`papertok.app/research`. Y: «el landing ponlo donde consideres».

**Dónde va la landing — decidido:** se queda en `papertok.app/`. Todo el rediseño parte de que un
desconocido escribe papertok.app y ve la landing; quien tiene sesión ya sale rebotado a `/feed` por
la puerta de `index.html`. Mover la landing a `/about` daría al visitante nuevo la app en frío, que
es exactamente lo que el rediseño existe para evitar.

**Esto NO es un retoque.** La app es un `HashRouter` desde su primer commit, y esa elección está
horneada en sitios que no se parecen a rutas: el service worker declara `navigateFallback: null`
razonando por escrito que «HashRouter nunca pide al servidor otra ruta que la base»; la analítica
deriva la ruta del fragmento; los enlaces para compartir se construyen con `#/`; y hay enlaces
`papertok.app/#/public/paper/…` ya repartidos por ahí que no pueden romperse. Diez ficheros de test
dan el hash por supuesto.

**La pieza de más riesgo, y va primero en la cabeza de quien lo ejecute:** `sanitizeAnalyticsEventUrl`
(`src/services/analyticsService.js`) existe porque bajo HashRouter el identificador real del paper
viaja en `location.href`, y la **política de privacidad publicada** promete que leer un paper se
registra como `/public/paper/:id` y que «cuál nunca viaja». La función ya cae a `parsed.pathname`
cuando no hay fragmento, así que probablemente sigue siendo correcta — pero eso hay que
**demostrarlo**, no suponerlo. Si se rompe, la página contradice su propia política de privacidad.

## Restricciones globales del añadido

- **Ninguna URL que exista hoy puede morir.** `papertok.app/#/public/paper/x` sigue llevando al
  mismo sitio, con una redirección, para siempre.
- La analítica sigue enviando rutas despojadas. Se demuestra con un test y con una captura de la
  petición real, no con un razonamiento.
- La clave `index` del input de Rollup no se mueve (el SW precachea `assets/index-*` por nombre).
- La landing se queda en `/`; `app.html` sigue sirviendo la app.
- Cada tarea acaba con la suite en verde, `npm run build` sin errores y un commit.

---

### Task 13: El router deja de usar el fragmento

**Files:**
- Modify: `src/main.jsx` (`HashRouter` → `BrowserRouter`)
- Modify: `src/App.jsx` (`path="/"` → `path="/feed"`; el catch-all apunta a `/feed`)
- Modify: `src/utils/publicNavigation.js` (los enlaces públicos se construyen sin `#`)
- Modify: los tests que dan el hash por supuesto — `routerTransitions.test.js`,
  `utils/routeDirection.test.js`, `utils/publicNavigation.test.js`, `utils/shareLink.test.js`,
  `components/Layout/navbarTabs.test.js`, `hooks/overlayHistory.test.js`,
  `components/Feed/feedAtomVeil.test.js`, `accessibilityStructure.test.js`
- Test: `src/utils/publicNavigation.test.js`, `src/routerTransitions.test.js`

**Interfaces:**
- Produces: toda ruta de la app es una ruta real. `/feed` es el feed; `/following`, `/research`,
  `/lists`, `/settings…`, `/explorer/:type/:id`, `/public/…` dejan de llevar `#`.
- Consume: el rewrite de Vercel que ya manda todo lo que no es fichero a `app.html`.

- [ ] **Step 1: Escribe los tests que fallan.** En `publicNavigation.test.js`, que
  `getPublicPaperUrl` devuelva `https://papertok.app/public/paper/<id>` sin `#`. En
  `routerTransitions.test.js`, que el router montado sea `BrowserRouter`. Que el catch-all de
  `App.jsx` navegue a `/feed` y no a `/`.
- [ ] **Step 2: Córrelos.** Deben fallar. Cita cuáles y por qué.
- [ ] **Step 3: Implementa.** `BrowserRouter` sin `basename` (las rutas son absolutas). La ruta del
  feed pasa de `/` a `/feed`. **Lee antes `src/utils/routeDirection.js`, `src/hooks/useOverlayHistory.js`
  y `src/utils/appReload.js`**: el signo de la barra y la memoria de superposiciones dependen de
  `history.state.idx`, no del hash, así que deberían sobrevivir — pero compruébalo y di qué encontraste.
- [ ] **Step 4: Recorre cada test del listado** y adáptalo a rutas reales. Ninguno se borra: si uno
  ya no tiene sentido, explica por qué en su lugar.
- [ ] **Step 5: Suite completa y build.** `node --test --test-reporter=tap 'src/**/*.test.js' 2>&1 | tail -5`.
- [ ] **Step 6: Commit** — `feat(router): las rutas de la app dejan de vivir en el fragmento`

---

### Task 14: La analítica sigue sin ver qué paper lees

**Files:**
- Modify: `src/services/analyticsService.js` (el comentario que explica el fragmento; la lógica solo si hace falta)
- Test: `src/services/analyticsService.test.js`
- Create: `scripts/diagnostics/landing-analytics-probe.mjs`

**Interfaces:**
- Produces: la garantía, demostrada, de que la petición que sale hacia Vercel lleva
  `/public/paper/:id` y no el identificador.

- [ ] **Step 1: Test primero.** Que `sanitizeAnalyticsEventUrl('https://papertok.app/public/paper/W123')`
  devuelva la ruta con `:id`, sin el identificador, **sin** que haya fragmento. Añade el caso simétrico
  para `/explorer/author/A456`. Córrelo: si ya pasa, dilo — significa que el fallback a `pathname`
  ya era correcto, y el trabajo es demostrarlo y arreglar el comentario, no cambiar la lógica.
- [ ] **Step 2: Demuéstralo en el navegador, no en el test.** `landing-analytics-probe.mjs`, sobre el
  arnés CDP de `scripts/diagnostics/landing-shots.mjs`: carga `/public/paper/<un id real>` con
  `Network.enable`, captura la petición que sale hacia el endpoint de Vercel Analytics, e imprime su
  cuerpo. **El identificador no puede aparecer en él.** Si la analítica está desactivada en el build
  local, actívala por el camino que use la app y dilo.
- [ ] **Step 3: Arregla el comentario** de `sanitizeAnalyticsEventUrl`, que hoy explica el fragmento
  como si fuera el caso vivo.
- [ ] **Step 4: Suite, build, commit** — `fix(analytics): la ruta se despoja del pathname, y se demuestra`

---

### Task 15: El servidor, el service worker y el PWA siguen al router

**Files:**
- Modify: `vite.config.js` (`navigateFallback` y el comentario largo que razona sobre HashRouter)
- Modify: `public/manifest.webmanifest` (`start_url`)
- Modify: `vercel.json` si el catch-all no cubre ya todas las rutas nuevas
- Test: `src/utils/spaDeploy.test.js`, `src/landing/entry.test.js`

- [ ] **Step 1: Tests primero.** Que `navigateFallback` sea `/app.html` y que su denylist excluya
  `/`, `/privacy.html`, `/assets/`, `/__/auth/` y `/sw.js`. Que `start_url` sea `./feed`. Que el
  catch-all de `vercel.json` lleve `/following` y `/research` a `app.html` y **no** `/`.
- [ ] **Step 1b: La cabecera del HTML de la app cuelga de una ruta que ya nadie pide.**
  `vercel.json` pone `Cache-Control: public, max-age=0, must-revalidate` en `/app.html` y en
  `/index.html`, y las cabeceras de Vercel casan con la ruta que ENTRA, no con el destino de la
  reescritura: ninguna navegación real pide esos dos caminos: se piden `/`, `/feed`, y ahora
  `/following` y `/research`. Hoy es inocuo, porque el valor por defecto de Vercel para HTML
  estático es exactamente ese, pero la garantía explícita se ha quedado sin efecto, y es la que
  impide que una pestaña reciba un HTML cacheado que apunta a hashes de assets ya borrados (el
  404 de chunk que el listener de `vite:preloadError` de `main.jsx` tapa recargando). Añade a
  `headers` las fuentes que se piden de verdad (`/`, `/feed` y el mismo
  `/:path((?!_vercel/|assets/|__/auth/).*)` del catch-all) y un test que compruebe que **una
  petición a `/feed` y otra a `/` casan con alguna regla de `headers` con `must-revalidate`**, no
  que exista la regla de `/app.html`. Viene de un minor aplazado de la tarea 2.
- [ ] **Step 2: Fallan; impleméntalo.** El comentario de `navigateFallback: null` argumenta por
  escrito que «HashRouter nunca pide al servidor otra ruta que la base». Eso ha dejado de ser cierto:
  reescríbelo diciendo lo que ahora pasa — sin fallback, un lector sin red que abra `/research`
  directamente recibe el error del navegador en vez de la app.
- [ ] **Step 3: Compruébalo offline.** Con CDP: carga la app, ponla `Network.emulateNetworkConditions`
  offline, navega a `/research` y confirma que sale la app y no el error del navegador. Y que `/` y
  `/privacy.html` siguen siendo sus propias páginas y no se las traga el fallback.
- [ ] **Step 4: Suite, build, commit** — `fix(pwa): el fallback de navegación cubre las rutas reales`

---

### Task 16: Los enlaces viejos no mueren

**Files:**
- Modify: `index.html` (la puerta de sesión traduce el fragmento)
- Modify: `src/main.jsx` o un módulo propio (la app traduce un fragmento residual en cualquier ruta)
- Modify: `public/sitemap.xml`
- Test: `src/landing/landingHead.test.js`, más un test nuevo para la traducción

- [ ] **Step 1: Tests primero.** Que la puerta de `index.html` mande `#/` a `/feed`, `#/research` a
  `/research`, `#/public/paper/x` a `/public/paper/x`, y que lo haga con `location.replace` para no
  dejar la landing en el historial. Que la app, cargada en cualquier ruta con un `#/loquesea`
  residual, navegue a la ruta real una sola vez y limpie el fragmento.
- [ ] **Step 2: Fallan; impleméntalo.** Cuidado con `#main-content`: el enlace de salto usa un
  fragmento que NO es una ruta, y la traducción no debe tocarlo. Solo un fragmento que empiece por
  `#/` es una ruta vieja.
- [ ] **Step 3: El sitemap** lista `/`, `/feed`, `/following`, `/research`. Las canónicas y `og:url`
  de `app.html` siguen apuntando a `/feed`.
- [ ] **Step 3b: Deja de acuñar enlaces viejos.** Traducir el fragmento entrante arregla los
  enlaces que ya están ahí fuera; esto arregla los que seguimos emitiendo. `publicNavigation.js`
  y `worker/email-notifications.js:12` componen `papertok.app/#/…` para lo que se comparte y
  para lo que se manda por correo: desde la migración cada uno de esos enlaces cuesta un salto
  por la página de marketing antes de llegar al sitio, y cuando el fragmento deje de ser la ruta
  serán enlaces a traducir en vez de enlaces correctos. Que emitan la ruta real, y un test que
  compruebe que **ningún módulo de la app compone una URL pública con `#/`** — no que estos dos
  ficheros concretos no lo hagan. Cuidado: el correo lo manda el Worker, que despliega aparte,
  así que sus enlaces tienen que seguir funcionando durante la ventana en la que el Worker viejo
  sigue vivo (la puerta del Step 2 es justo lo que lo garantiza).
- [ ] **Step 4: Compruébalo por CDP** — las cinco puertas: `/` sin marca (landing), `/` con marca
  (`/feed`), `/#/research` (→ `/research`), `/research` directo, `/privacy.html`. Y que `#main-content`
  sigue funcionando.
- [ ] **Step 5: Suite, build, commit** — `feat(rutas): los enlaces con fragmento siguen llevando al mismo sitio`

---

### Task 17: Verificación del añadido

- [ ] Suite completa; `npm run build`; presupuesto de la landing sin cambios (≤ 30 KB gz).
- [ ] Las cinco puertas de la tarea 16, otra vez, sobre el build.
- [ ] La sonda de analítica de la tarea 14, otra vez: el identificador no sale.
- [ ] Offline en una ruta profunda (tarea 15).
- [ ] `axe` sobre `/feed`, `/following` y `/research` — la auditoría de la tarea 11 solo cubrió la
  landing, y estas rutas ahora son URLs de primera clase.
- [ ] Capturas de las tres rutas a 1440 y 390 en ambos temas; mirarlas.
- [ ] Actualizar `docs/ACCESIBILIDAD-EVIDENCIA.md` con lo que cubra esta pasada.
- [ ] Actualizar la spec: el §2 decía que la migración de `/` quedaba fuera de alcance; ya no.
