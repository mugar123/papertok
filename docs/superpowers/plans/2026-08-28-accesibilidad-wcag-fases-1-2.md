# Accesibilidad WCAG 2.2 — Fases 1-2 (cimientos + flujos operables) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un usuario ciego o de solo teclado pueda recorrer y operar los tres flujos principales de PaperTok (feed, listas, research), con foco visible, navegación anunciada y contraste conforme.

**Architecture:** Retrofit, no reescritura: los patrones accesibles ya existen en el repo (`useDialogFocus`, helpers de activación de Search/Explorer, `.visually-hidden`, reset global de `button`) y este plan los aplica a los sitios que los ignoraron. Fase 1 arregla lo global (tokens de color, cascada del foco, skip link, títulos/anuncio de ruta, `lang`); fase 2 convierte los `div` clicables de los flujos principales en controles nativos.

**Tech Stack:** React 19, react-router-dom 7, CSS plano con tokens en `src/styles/variables.css`, tests con `node --test` (sin DOM: tests de lógica pura junto al módulo, `*.test.js`).

**Spec:** Auditoría WCAG 2.2 del 2026-08-28 (artifact «Auditoría WCAG de PaperTok», hallazgos C1-C10, A1-A12) + `docs/ACCESIBILIDAD.md` (reglas permanentes). Este plan cubre las fases 1-2 del plan de corrección de la auditoría: C1, C3, C4, C5 (parcial), A1, A2, A3, A12, M10, M11, M20, M23 y el saneo de `outline: none`. C2, C6-C10 y el resto van en planes posteriores (fases 3-5).

## Global Constraints

- Todo texto de UI nuevo es bilingüe (español e inglés) vía `LanguageContext` / prop `isEnglish`, nunca inferido dentro del componente.
- Comentarios de código en inglés; mensajes de commit en español siguiendo el historial (`tipo(ámbito): frase`).
- No usar `tabIndex` positivo. No sustituir semántica nativa por ARIA.
- Tests junto al módulo (`*.test.js`), deterministas, ejecutables con `npm test` (Node 22 en CI: no APIs de Node 25).
- `npm run check` debe pasar antes del último commit del plan.
- No tocar `dist/`, `.wrangler/`, ni ficheros generados.
- Los umbrales de contraste son los de WCAG 2.2: 4.5:1 texto normal, 3:1 componentes de interfaz e indicador de foco.

---

### Task 1: Test de regresión de contraste + tokens nuevos

Arregla A1 (anillo de foco 2.08:1 en claro) y A3 (`--text-tertiary` 3.17:1 claro / 4.43:1 oscuro), con un test que parsea `variables.css` y falla si algún par vuelve a caer.

**Files:**
- Create: `src/styles/contrast.test.js`
- Modify: `src/styles/variables.css` (líneas 29, 280; añadir `--focus-ring` en ambos temas)
- Modify: `src/styles/global.css:166-169` (el color del anillo; el movimiento de capa es la Task 2)

**Interfaces:**
- Produces: token CSS `--focus-ring` (claro `#b45309`, oscuro `#ff9d00`) que la Task 2 usa en la regla `:focus-visible`.

- [ ] **Step 1: Write the failing test**

```js
// src/styles/contrast.test.js
// Guards the palette against WCAG 2.2 regressions: normal text needs 4.5:1,
// UI indicators (focus ring) need 3:1. Parses variables.css directly so the
// test fails the moment a token value drops below threshold.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./variables.css', import.meta.url), 'utf8')
const darkStart = css.indexOf(":root[data-theme='dark']")
assert.ok(darkStart > 0, 'dark theme block not found in variables.css')
const blocks = { light: css.slice(0, darkStart), dark: css.slice(darkStart) }

function token(theme, name) {
  const own = blocks[theme].match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (own) return own[1]
  // Dark redefines only what changes; anything else falls through to light.
  const base = blocks.light.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))
  assert.ok(base, `token ${name} not found`)
  return base[1]
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const TEXT_PAIRS = [
  ['--text-primary', '--bg-primary'],
  ['--text-primary', '--bg-secondary'],
  ['--text-secondary', '--bg-primary'],
  ['--text-secondary', '--bg-secondary'],
  ['--text-tertiary', '--bg-primary'],
  ['--text-tertiary', '--bg-secondary'],
  ['--text-on-brand', '--brand-yellow'],
]

for (const theme of ['light', 'dark']) {
  test(`normal text meets 4.5:1 (${theme})`, () => {
    for (const [fg, bg] of TEXT_PAIRS) {
      const r = ratio(token(theme, fg), token(theme, bg))
      assert.ok(r >= 4.5, `${theme} ${fg} on ${bg}: ${r.toFixed(2)}:1 < 4.5:1`)
    }
  })

  test(`focus ring meets 3:1 against surfaces (${theme})`, () => {
    for (const bg of ['--bg-primary', '--bg-secondary', '--bg-card']) {
      const r = ratio(token(theme, '--focus-ring'), token(theme, bg))
      assert.ok(r >= 3, `${theme} --focus-ring on ${bg}: ${r.toFixed(2)}:1 < 3:1`)
    }
  })
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/styles/contrast.test.js`
Expected: FAIL — `--focus-ring` no existe todavía (`token --focus-ring not found`) y `--text-tertiary` da 3.17:1 en claro.

- [ ] **Step 3: Fix the tokens**

En `src/styles/variables.css`:

Bloque claro — línea 29, sustituir:

```css
  --text-tertiary: #8a919e;
```

por:

```css
  /* 4.83:1 on white, 4.52:1 on --bg-secondary. The previous #8a919e sat at
     3.17:1, below the 4.5:1 floor for normal text (WCAG 1.4.3). */
  --text-tertiary: #6b7280;
```

Bloque claro — junto a `--brand-orange` (línea 43), añadir debajo:

```css
  /* Focus ring. The brand orange itself is 2.08:1 on white — invisible as an
     indicator — so on the light side the ring darkens to a burnt orange that
     holds 5.0:1 while keeping the hue of the mark (WCAG 2.4.7 / 1.4.11). */
  --focus-ring: #b45309;
```

Bloque oscuro — línea 280, sustituir:

```css
  --text-tertiary: #757c8a;
```

por:

```css
  /* 5.35:1 on the page, 4.69:1 on --bg-elevated; #757c8a was 4.43:1. */
  --text-tertiary: #828a99;
```

Bloque oscuro — junto a `--brand-yellow-soft` (línea 293), añadir:

```css
  /* On ink the true brand orange clears 8.9:1, so the mark keeps its color. */
  --focus-ring: #ff9d00;
```

En `src/styles/global.css:167`, sustituir `outline: 2px solid var(--brand-orange);` por `outline: 2px solid var(--focus-ring);`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/styles/contrast.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Run lint and commit**

```bash
npm run lint
git add src/styles/contrast.test.js src/styles/variables.css src/styles/global.css
git commit -m "fix(a11y): el anillo de foco y el texto terciario pasan contraste, con test de regresión"
```

---

### Task 2: El anillo de foco gana siempre — fuera de `@layer` y saneo de `outline: none`

Arregla A2 (el `:focus-visible` global vive en `@layer base` y cualquier `outline: none` de componente le gana por reglas de capas) y elimina los `outline: none` sin reemplazo (A12, M23 y la píldora de C7).

**Files:**
- Modify: `src/styles/global.css` (mover la regla de :166-169 al final del fichero, fuera de `@layer`)
- Modify: `src/components/Settings/EditInterestsModal.css:202`
- Modify: `src/components/Search/SearchPage.css:120,126-130`
- Modify: `src/components/Explorer/EntityExplorer.css:748`
- Modify: `src/components/Reader/Annotations.css:111-114`

**Interfaces:**
- Consumes: `--focus-ring` (Task 1).
- Produces: regla global `:focus-visible` sin capa, que las tareas 6-9 asumen activa sobre sus botones nuevos.

- [ ] **Step 1: Move the focus rule out of the layer**

En `src/styles/global.css`, borrar el bloque de las líneas 164-169 (el comentario y la regla `:focus-visible` dentro de `@layer base`) y añadir al final del fichero, fuera de cualquier `@layer`:

```css
/* ============================================
   Focus ring
   Deliberately OUTSIDE @layer base: component stylesheets are unlayered, and
   unlayered CSS beats any layer, so while this rule lived inside the layer
   every component `outline: none` silently killed the ring (WCAG 2.4.7).
   Out here it competes on normal specificity and wins.
   ============================================ */
:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
```

- [ ] **Step 2: Let inputs take the global ring**

En `src/styles/global.css:180`, dentro de la regla `input, textarea, select`, borrar la línea `outline: none;`. El borde + glow de `:focus` se conserva; el anillo de `:focus-visible` se suma para teclado.

- [ ] **Step 3: Remove component outline suppressions**

- `src/components/Settings/EditInterestsModal.css:202`: en `.eim-pill`, borrar la declaración `outline: none;`.
- `src/components/Search/SearchPage.css`: borrar `outline: none !important;` (línea 120) y el bloque `.search-input:focus { outline: none !important; box-shadow: none !important; }` (líneas 126-130) entero.
- `src/components/Explorer/EntityExplorer.css:748`: en `.explorer-search-box input`, borrar `outline: none;`.
- `src/components/Reader/Annotations.css:111-114`: en `.rd-menu-input:focus`, borrar `outline: none;` (conservar el cambio de `border-color`).

- [ ] **Step 4: Verify no suppressions remain unreplaced**

Run: `grep -rn "outline: *none\|outline: *0" src --include="*.css"`
Expected: ninguna coincidencia nueva sin justificar. Si aparece alguna no listada arriba, comprobar que su selector tiene un indicador de foco equivalente visible; si no lo tiene, borrarla también.

- [ ] **Step 5: Verify in the browser**

Con el dev server (`.claude/launch.json` / preview): en el feed, pulsar Tab repetidamente y confirmar con los ojos o con `getComputedStyle(document.activeElement).outlineColor` que cada control muestra el anillo naranja oscuro en tema claro y naranja en oscuro — incluidas las píldoras de «Configura tu algoritmo» (Ajustes → intereses) y el input de búsqueda.

- [ ] **Step 6: Commit**

```bash
git add src/styles/global.css src/components/Settings/EditInterestsModal.css src/components/Search/SearchPage.css src/components/Explorer/EntityExplorer.css src/components/Reader/Annotations.css
git commit -m "fix(a11y): el anillo de foco sale de la capa base y ningún componente lo apaga"
```

---

### Task 3: Skip link, `<main>` del feed, h1 oculto y navbar nombrada

Arregla C4 (sin skip link ni landmark en la raíz), parte de A9 (h1 del feed), M10 (nav sin nombre) y M11 («Para ti» sin `aria-current`).

**Files:**
- Modify: `src/App.jsx:102-105,325`
- Modify: `src/components/Feed/FeedContainer.jsx:344-346`
- Modify: `src/components/Layout/Navbar.jsx:38,69-79`
- Modify: `src/styles/global.css` (final del fichero, sección sin capa)

**Interfaces:**
- Produces: contenedor `#main-content` (div, `tabIndex={-1}`) envolviendo las rutas — es el destino del skip link y del movimiento de foco de la Task 4.

- [ ] **Step 1: Add the skip link and the route outlet in App.jsx**

En `src/App.jsx`, dentro de `AppContent`, sustituir las líneas 102-105:

```jsx
  return (
    <FeedProvider feedRouteActive={normalizedPathname === '/'}>
      {showNavbar && <Navbar searchOpen={searchOpen} onOpenSearch={() => setSearchOpen(true)} />}
      <Suspense fallback={<RouteFallback />}>
```

por:

```jsx
  return (
    <FeedProvider feedRouteActive={normalizedPathname === '/'}>
      <a className="skip-link" href="#main-content">
        {isEnglish ? 'Skip to content' : 'Saltar al contenido'}
      </a>
      {showNavbar && <Navbar searchOpen={searchOpen} onOpenSearch={() => setSearchOpen(true)} />}
      {/* Focus target for the skip link and for route changes (RouteAnnouncer).
          A div, not <main>: several routes render their own <main> inside. */}
      <div id="main-content" tabIndex={-1}>
      <Suspense fallback={<RouteFallback />}>
```

y cerrar el div tras el cierre de `</Suspense>` de la línea 325:

```jsx
      </Suspense>
      </div>
```

(`isEnglish` ya está desestructurado en la línea 66.)

- [ ] **Step 2: Style the skip link**

Al final de `src/styles/global.css` (sección sin capa creada en la Task 2), añadir:

```css
/* Visible only while focused: the first Tab of every page lands here. */
.skip-link {
  position: fixed;
  top: -100px;
  left: var(--space-4);
  z-index: calc(var(--z-toast) + 1);
  background: var(--accent-primary);
  color: var(--text-inverse);
  font-weight: var(--fw-semibold);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  text-decoration: none;
  transition: top var(--transition-fast);
}
.skip-link:focus-visible {
  top: var(--space-2);
}

/* Programmatic focus target; the ring belongs on real controls. */
#main-content:focus {
  outline: none;
}
```

- [ ] **Step 3: Make the feed a landmark with a hidden h1**

En `src/components/Feed/FeedContainer.jsx:344-346`, sustituir:

```jsx
  return (
    <div className="feed-wrapper">
      <div className="feed-container" ref={feedRef} onScroll={handleScroll}>
```

por:

```jsx
  return (
    <main className="feed-wrapper" aria-label={isEnglish ? 'Paper feed' : 'Feed de papers'}>
      <h1 className="visually-hidden">{isEnglish ? 'For you' : 'Para ti'}</h1>
      <div className="feed-container" ref={feedRef} onScroll={handleScroll}>
```

y cambiar el `</div>` de cierre correspondiente a `feed-wrapper` (final del mismo `return`) por `</main>`. `isEnglish` ya existe en el componente (se usa en la línea 337); `.visually-hidden` ya existe en `variables.css:510`.

- [ ] **Step 4: Name the navbar and expose the current tab**

En `src/components/Layout/Navbar.jsx:38`, sustituir `<nav className="navbar">` por:

```jsx
    <nav className="navbar" aria-label={isEnglish ? 'Main navigation' : 'Navegación principal'}>
```

En el botón «Para ti» (líneas 69-76), añadir `aria-current` junto a `className`:

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
```

- [ ] **Step 5: Verify in the browser**

Recargar, pulsar Tab una vez: debe aparecer «Saltar al contenido» arriba a la izquierda; Enter debe llevar el foco al contenido (verificable con `document.activeElement.id === 'main-content'`). En `/`, `document.querySelector('main.feed-wrapper h1')` debe existir.

- [ ] **Step 6: Run checks and commit**

```bash
npm run lint && npm test
git add src/App.jsx src/components/Feed/FeedContainer.jsx src/components/Layout/Navbar.jsx src/styles/global.css
git commit -m "feat(a11y): skip link, landmark y h1 en el feed, y navbar con nombre y pestaña actual"
```

---

### Task 4: Títulos de ruta y anuncio de navegación

Arregla C3: `document.title` por ruta, anuncio `aria-live` del cambio de vista y movimiento de foco a `#main-content`.

**Files:**
- Create: `src/utils/routeMetadata.js`
- Create: `src/utils/routeMetadata.test.js`
- Create: `src/components/Layout/RouteAnnouncer.jsx`
- Modify: `src/App.jsx` (montar el announcer junto al skip link)

**Interfaces:**
- Consumes: `#main-content` con `tabIndex={-1}` (Task 3); clase `.visually-hidden` (`variables.css:510`).
- Produces: `routeTitle(pathname, isEnglish) → string | null` y `routeLabel(pathname, isEnglish) → string | null` en `src/utils/routeMetadata.js`.

- [ ] **Step 1: Write the failing test**

```js
// src/utils/routeMetadata.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeTitle, routeLabel } from './routeMetadata.js'

test('titles the main authenticated routes in both languages', () => {
  assert.equal(routeTitle('/', false), 'Para ti · PaperTok')
  assert.equal(routeTitle('/', true), 'For you · PaperTok')
  assert.equal(routeTitle('/lists', false), 'Mis listas · PaperTok')
  assert.equal(routeTitle('/research', true), 'Research · PaperTok')
  assert.equal(routeTitle('/following', false), 'Siguiendo · PaperTok')
  assert.equal(routeTitle('/search', true), 'Search · PaperTok')
})

test('normalizes trailing slashes', () => {
  assert.equal(routeTitle('/lists/', true), 'My lists · PaperTok')
})

test('returns null for self-titled and unknown routes', () => {
  // Settings, /settings/profile and the public pages already manage
  // document.title themselves (SettingsPage.jsx:382, ProfilePage.jsx:339,
  // usePublicPageMetadata); the announcer must not fight them.
  assert.equal(routeTitle('/settings', false), null)
  assert.equal(routeTitle('/settings/profile', false), null)
  assert.equal(routeTitle('/public/paper/x', false), null)
  assert.equal(routeTitle('/nonsense', false), null)
})

test('labels announce even self-titled routes', () => {
  assert.equal(routeLabel('/settings', false), 'Ajustes')
  assert.equal(routeLabel('/settings', true), 'Settings')
  assert.equal(routeLabel('/nonsense', false), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/utils/routeMetadata.test.js`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implement routeMetadata.js**

```js
// src/utils/routeMetadata.js
// Static route names for the SPA chrome. Two consumers: document.title
// (only for routes that do not title themselves) and the route-change
// announcement for screen readers (all mapped routes).

const LABELS = {
  '/': ['For you', 'Para ti'],
  '/lists': ['My lists', 'Mis listas'],
  '/research': ['Research', 'Research'],
  '/following': ['Following', 'Siguiendo'],
  '/search': ['Search', 'Buscar'],
  '/profile': ['My profile', 'Mi perfil'],
  '/settings': ['Settings', 'Ajustes'],
  '/settings/profile': ['Edit profile', 'Editar perfil'],
  '/settings/following': ['Following settings', 'Ajustes de seguimiento'],
  '/settings/comments': ['My comments', 'Mis comentarios'],
  '/login': ['Sign in', 'Iniciar sesión'],
  '/onboarding': ['Welcome', 'Bienvenida'],
}

// These set document.title on their own (SettingsPage, ProfilePage,
// PublicProfilePage in selfMode); the announcer still announces them.
const SELF_TITLED = new Set(['/settings', '/settings/profile', '/profile'])

function normalize(pathname) {
  return pathname === '/' ? '/' : pathname.replace(/\/+$/, '')
}

export function routeLabel(pathname, isEnglish) {
  const entry = LABELS[normalize(pathname)]
  return entry ? entry[isEnglish ? 0 : 1] : null
}

export function routeTitle(pathname, isEnglish) {
  const normalized = normalize(pathname)
  if (SELF_TITLED.has(normalized)) return null
  const label = routeLabel(normalized, isEnglish)
  return label ? `${label} · PaperTok` : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/utils/routeMetadata.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement RouteAnnouncer**

```jsx
// src/components/Layout/RouteAnnouncer.jsx
// SPA navigation is silent by default: the route remounts, focus falls on
// <body> and nothing tells a screen reader the view changed (WCAG 2.4.2,
// 2.4.3). On every pathname change this sets the tab title, announces the
// new view through a polite live region, and moves focus to #main-content
// so Tab restarts at the content instead of the top of the page.
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useLanguage } from '../../context/LanguageContext'
import { routeTitle, routeLabel } from '../../utils/routeMetadata'

export default function RouteAnnouncer() {
  const location = useLocation()
  const { isEnglish } = useLanguage()
  const liveRef = useRef(null)
  const isFirstRender = useRef(true)

  useEffect(() => {
    const title = routeTitle(location.pathname, isEnglish)
    if (title) document.title = title
    if (isFirstRender.current) {
      // The initial load already has the browser's own focus and title.
      isFirstRender.current = false
      return
    }
    const label = routeLabel(location.pathname, isEnglish)
    if (liveRef.current) liveRef.current.textContent = label || ''
    document.getElementById('main-content')?.focus({ preventScroll: true })
  }, [location.pathname, isEnglish])

  // Rendered persistently and empty: live regions only announce content
  // *changes*, so the node must exist before the first navigation.
  return <span ref={liveRef} className="visually-hidden" role="status" aria-live="polite" />
}
```

- [ ] **Step 6: Mount it in App.jsx**

En `src/App.jsx`: añadir el import junto a los demás de Layout:

```jsx
import RouteAnnouncer from './components/Layout/RouteAnnouncer'
```

y montarlo justo después del skip link añadido en la Task 3:

```jsx
      <a className="skip-link" href="#main-content">
        {isEnglish ? 'Skip to content' : 'Saltar al contenido'}
      </a>
      <RouteAnnouncer />
```

- [ ] **Step 7: Verify in the browser**

Navegar `/` → Research → Siguiendo desde el navbar: la pestaña debe cambiar de título («Research · PaperTok», «Siguiendo · PaperTok»), y `document.activeElement.id` debe ser `main-content` tras cada navegación. En `/settings`, el título debe seguir siendo el que pone `SettingsPage` (el announcer no lo pisa).

- [ ] **Step 8: Run all tests and commit**

```bash
npm run lint && npm test
git add src/utils/routeMetadata.js src/utils/routeMetadata.test.js src/components/Layout/RouteAnnouncer.jsx src/App.jsx
git commit -m "feat(a11y): cada ruta tiene título y la navegación se anuncia y mueve el foco"
```

---

### Task 5: `lang="en"` en el contenido de los papers

Arregla C5 en los elementos que siempre muestran texto del proveedor (títulos, revista, abstract original): sin `lang`, un sintetizador español lee los abstracts de arXiv con fonética española. Alcance deliberado: el panel de abstract de `PaperCard` y el cuerpo del lector alternan entre texto original y reescritura localizada, y se marcarán en el plan de la fase 5 cuando se toque el lector; aquí solo lo inequívoco.

**Files:**
- Modify: `src/components/Feed/PaperCard.jsx:1185`
- Modify: `src/components/Reader/PaperReader.jsx:1163`
- Modify: `src/components/Lists/ListsPage.jsx:1578`
- Modify: `src/components/Report/ResearchForme.jsx:78-82,84-93,101`
- Modify: `src/components/Search/SearchPage.jsx:1244`

**Interfaces:**
- Consumes: nada. Produces: convención `lang="en"` sobre nodos de texto de proveedor, que las tareas 6-8 conservan al convertir esos nodos en botones.

- [ ] **Step 1: Mark the always-English provider text**

- `PaperCard.jsx:1185`: `<h2 className="pc-title">` → `<h2 className="pc-title" lang="en">`.
- `PaperReader.jsx:1163`: añadir `lang="en"` al `<h1>` del título del paper.
- `ListsPage.jsx:1578`: `<p className="lists-paper-title">` → `<p className="lists-paper-title" lang="en">`.
- `ResearchForme.jsx:78`: `<h3 className={...}>` → `<h3 className={...} lang="en">`.
- `ResearchForme.jsx:84-93` (el dek): el texto es el abstract original solo cuando pasa `hasUsableAIAbstract`; el fallback es copy localizado. Sustituir la apertura del `<p>` por:

```jsx
    <p
      className={`sr-cell-dek${twoColumnDek ? ' sr-cell-dek--split' : ''}`}
      style={{ '--dek-lines': dekLines }}
      lang={hasUsableAIAbstract(paper.abstract) ? 'en' : undefined}
    >
```

- `ResearchForme.jsx:101`: `<span className="sr-micro venue">{paper.journal}</span>` → `<span className="sr-micro venue" lang="en">{paper.journal}</span>`.
- `SearchPage.jsx:1244`: añadir `lang="en"` al elemento que renderiza el título del paper en los resultados (el nodo con el título de proveedor de esa línea).

- [ ] **Step 2: Verify**

Run: `grep -rn 'lang="en"' src/components | wc -l`
Expected: ≥ 6. En el navegador, `document.querySelector('.pc-title').lang` debe ser `"en"`.

- [ ] **Step 3: Run checks and commit**

```bash
npm run lint && npm test
git add src/components/Feed/PaperCard.jsx src/components/Reader/PaperReader.jsx src/components/Lists/ListsPage.jsx src/components/Report/ResearchForme.jsx src/components/Search/SearchPage.jsx
git commit -m "fix(a11y): el contenido en inglés de los papers se marca con lang para el sintetizador"
```

---

### Task 6: PaperCard — autores, «et al.» y abstract como controles reales

Arregla la parte de C1 que vive en la tarjeta del feed: los `<span onClick>` de autor (1207), las filas del modal de autores (1531) y el abstract expandible (1232). El doble-tap del contenedor (912) y el `onClick` del bloque móvil (1189) se conservan como redundancia de puntero: dejan de ser el único camino.

**Files:**
- Modify: `src/components/Feed/PaperCard.jsx:1205-1236,1529-1553`
- Modify: `src/components/Feed/PaperCard.css` (final del fichero)

**Interfaces:**
- Consumes: reset global de `button` (`global.css:149-157`: sin borde ni fondo), anillo `:focus-visible` (Task 2), `lang="en"` del título (Task 5).
- Produces: clases CSS `pc-author-btn`, `pc-authors-more`, `pc-abstract-toggle` (solo estilo; sin API nueva).

- [ ] **Step 1: Authors become buttons**

En `PaperCard.jsx:1205-1229`, sustituir el bloque `pc-author-names` completo por:

```jsx
          <div className="pc-author-names">
            {(paper.authors || []).slice(0, 3).map((author, index) => (
               <button
                 key={index}
                 type="button"
                 className="pc-author-link pc-author-btn"
                 lang="en"
                 onClick={(e) => {
                   e.stopPropagation(); 
                   const pId = paper.id.startsWith('arxiv:') ? paper.id.split(':')[1] : paper.id;
                   const authorName = author.name || author;
                   const path = publicMode
                     ? getPublicEntityPath('author', author.id || authorName)
                     : `/explorer/author/${encodeURIComponent(authorName)}?arxivId=${pId}`;
                   trackEvent('select_content', {
                     content_type: 'author',
                     surface: analyticsSurface,
                     position,
                   });
                   if (path) navigate(path);
                 }}
               >
                 {author.name || author}{index < Math.min((paper.authors || []).length, 3) - 1 ? ', ' : ''}
               </button>
            ))}
            {(paper.authors || []).length > 3 && (
              <button
                type="button"
                className="pc-authors-more"
                aria-haspopup="dialog"
                onClick={(e) => { e.stopPropagation(); setShowAuthorsModal(true); }}
                aria-label={isEnglish ? 'Show all authors' : 'Ver todos los autores'}
              >
                et al.
              </button>
            )}
          </div>
```

(La lógica interna del onClick es la existente, sin cambios; `isEnglish` ya está en el componente.)

- [ ] **Step 2: Author modal rows become buttons**

En `PaperCard.jsx:1531-1552`, sustituir `<div ... className="pc-authors-modal-item" onClick={...}>` por `<button type="button" className="pc-authors-modal-item" lang="en" onClick={...}>` con el mismo `onClick`, y el cierre `</div>` correspondiente por `</button>`.

- [ ] **Step 3: The abstract gets a real toggle**

En `PaperCard.jsx:1232-1236`, el `div.pc-abstract` conserva su `onClick` (afordancia de puntero) pero deja de ser el único camino. Añadir `id` y, tras el cierre del div del abstract, un botón:

```jsx
        <div
          ref={abstractRef}
          id={`pc-abstract-${position}`}
          className={`pc-abstract ${expanded ? 'pc-abstract--open' : ''}`}
          onClick={(e) => toggleExpanded(e, !expanded)}
          onTransitionEnd={handleAbstractTransitionEnd}
        >
```

y justo después del `</div>` que cierra `pc-abstract`:

```jsx
        <button
          type="button"
          className="pc-abstract-toggle"
          aria-expanded={expanded}
          aria-controls={`pc-abstract-${position}`}
          onClick={(e) => toggleExpanded(e, !expanded)}
        >
          {expanded
            ? (isEnglish ? 'Show less' : 'Mostrar menos')
            : (isEnglish ? 'Read full abstract' : 'Leer el abstract completo')}
        </button>
```

- [ ] **Step 4: Style the new buttons**

Al final de `src/components/Feed/PaperCard.css`:

```css
/* Inline author buttons: the global button reset leaves them borderless, so
   they only need to stop imposing the base font size. */
.pc-author-btn {
  font: inherit;
  color: inherit;
  padding: 0;
  text-align: left;
}

.pc-authors-more {
  font: inherit;
  color: var(--text-secondary);
  padding: 0 2px;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.pc-abstract-toggle {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-secondary);
  padding: var(--space-1) 0;
  align-self: flex-start;
  text-decoration: underline;
  text-underline-offset: 2px;
}
```

- [ ] **Step 5: Verify with the keyboard**

En el navegador, con el foco dentro de una tarjeta: Tab debe alcanzar cada autor, «et al.» (si hay más de 3), y el toggle del abstract. Enter sobre un autor navega a su ficha; Enter sobre el toggle expande/colapsa y `aria-expanded` alterna (verificable con `document.activeElement.getAttribute('aria-expanded')`). Enter sobre «et al.» abre el modal y Tab queda dentro (el modal ya usa `useDialogFocus`).

- [ ] **Step 6: Run checks and commit**

```bash
npm run lint && npm test
git add src/components/Feed/PaperCard.jsx src/components/Feed/PaperCard.css
git commit -m "fix(a11y): autores, et al. y abstract de la tarjeta son botones operables por teclado"
```

---

### Task 7: ListsPage — abrir listas y papers guardados con teclado

Arregla la parte de C1 en la biblioteca (1568, 1691) y deshace el anidamiento de controles de M20: el contenedor deja de ser control (su `onClick` queda como redundancia de puntero) y el título se vuelve el botón real.

**Files:**
- Modify: `src/components/Lists/ListsPage.jsx:1578,1719`
- Modify: `src/components/Lists/ListsPage.css` (final del fichero)

**Interfaces:**
- Consumes: `openList(list)` y `openPaperCard(paper)` existentes en el componente; reset global de `button`; `lang="en"` (Task 5).
- Produces: clases CSS `lists-paper-title-btn`, `list-card-name-btn`.

- [ ] **Step 1: The saved-paper title becomes the opener**

En `ListsPage.jsx:1578` (tras la Task 5 el `<p>` lleva `lang="en"`), sustituir:

```jsx
                          <p className="lists-paper-title" lang="en"><ScientificText>{paper.title}</ScientificText></p>
```

por:

```jsx
                          <p className="lists-paper-title">
                            <button
                              type="button"
                              className="lists-paper-title-btn"
                              lang="en"
                              onClick={(e) => { e.stopPropagation(); openPaperCard(paper); }}
                            >
                              <ScientificText>{paper.title}</ScientificText>
                            </button>
                          </p>
```

El `onClick` del contenedor `lists-paper-item` (1570) se conserva tal cual: mismo destino, redundancia de puntero.

- [ ] **Step 2: The list-card name becomes the opener**

En `ListsPage.jsx:1719`, sustituir:

```jsx
                <h3 className="list-card-name">{list.name}</h3>
```

por:

```jsx
                <h3 className="list-card-name">
                  <button
                    type="button"
                    className="list-card-name-btn"
                    onClick={(e) => { e.stopPropagation(); setOpenedFromRoute(false); openList(list); }}
                  >
                    {list.name}
                  </button>
                </h3>
```

El `onClick` del contenedor `list-card` (1691) se conserva. Los botones de editar/borrar (1700, 1708) ya no viven dentro de un control: el anidamiento inválido desaparece sin tocarlos.

- [ ] **Step 3: Style**

Al final de `src/components/Lists/ListsPage.css`:

```css
/* The card titles are the real (keyboard-reachable) openers; the card's own
   onClick is pointer redundancy. Inherit everything from the heading. */
.list-card-name-btn,
.lists-paper-title-btn {
  font: inherit;
  color: inherit;
  padding: 0;
  text-align: left;
  display: block;
  width: 100%;
}
```

- [ ] **Step 4: Verify with the keyboard**

En `/lists`: Tab debe recorrer, por cada tarjeta, el nombre de la lista (Enter la abre) y — en listas propias — editar y borrar como paradas separadas. Dentro de una lista, cada paper: título (Enter abre la tarjeta), editar nota, quitar.

- [ ] **Step 5: Run checks and commit**

```bash
npm run lint && npm test
git add src/components/Lists/ListsPage.jsx src/components/Lists/ListsPage.css
git commit -m "fix(a11y): listas y papers guardados se abren con teclado desde su título"
```

---

### Task 8: ResearchForme — abrir un paper desde el informe con teclado

Arregla la parte de C1 en `/research` (110): el `<article onClick>` conserva su clic como redundancia y el título se vuelve botón.

**Files:**
- Modify: `src/components/Report/ResearchForme.jsx:72-82`
- Modify: `src/components/Report/ScientificReport.css` (final del fichero)

**Interfaces:**
- Consumes: prop `onSelect(paper)` ya recibida por `FormeCell`; `lang="en"` en el `<h3>` (Task 5).
- Produces: clase CSS `sr-cell-title-btn`.

- [ ] **Step 1: The cell title becomes the opener**

En `ResearchForme.jsx:72-82`, sustituir la constante `heading` por:

```jsx
  const heading = (
    <>
      <div className="sr-cell-kicker">
        <span className="sr-cell-cat" style={{ color: accent }}>{category}</span>
        <span className="sr-cell-year">{paper.year}</span>
      </div>
      <h3 className={`sr-cell-title sr-cell-title--${titleSize}`} lang="en">
        <button
          type="button"
          className="sr-cell-title-btn"
          onClick={(e) => { e.stopPropagation(); onSelect(paper); }}
        >
          <ScientificText>{paper.title}</ScientificText>
        </button>
      </h3>
    </>
  );
```

El `onClick` del `<article>` (113) se conserva tal cual.

- [ ] **Step 2: Style**

Al final de `src/components/Report/ScientificReport.css`:

```css
/* The forme cell's real opener. Everything visual stays on .sr-cell-title. */
.sr-cell-title-btn {
  font: inherit;
  color: inherit;
  padding: 0;
  text-align: left;
  display: block;
  width: 100%;
}
```

- [ ] **Step 3: Verify with the keyboard**

En `/research`: Tab recorre los titulares de las celdas; Enter sobre uno abre el paper (misma acción que el clic).

- [ ] **Step 4: Run checks and commit**

```bash
npm run lint && npm test
git add src/components/Report/ResearchForme.jsx src/components/Report/ScientificReport.css
git commit -m "fix(a11y): los titulares del informe research abren el paper con teclado"
```

---

### Task 9: SearchPage — deshacer el control anidado de instituciones

Arregla M20 en los resultados de institución (1062-1090): un `FollowButton` dentro de un `div role="link"` produce un árbol de accesibilidad inválido. El contenedor deja de ser control; el nombre navega.

**Files:**
- Modify: `src/components/Search/SearchPage.jsx:1059-1093`
- Modify: `src/components/Search/SearchPage.css` (final del fichero)

**Interfaces:**
- Consumes: `handleSearchItemKeyDown` deja de usarse en este bloque (sigue existiendo para los demás); `getLocalizedInstitutionName`, `FollowButton` y handlers existentes sin cambios.
- Produces: clase CSS `search-item-title-btn`.

- [ ] **Step 1: Restructure the institution row**

En `SearchPage.jsx:1061-1093`, sustituir el elemento del map por:

```jsx
                  return (
                    <div
                      key={inst.id}
                      className="search-item search-item-enter"
                      style={{ '--search-item-index': Math.min(index, 6) }}
                      onClick={() => navigate(`/explorer/institution/${inst.id.split('/').pop()}`)}
                    >
                      <div className="search-item-icon"><Building2 size={22} /></div>
                      <div className="search-item-info">
                        <h4>
                          <button
                            type="button"
                            className="search-item-title-btn"
                            onClick={(e) => { e.stopPropagation(); navigate(`/explorer/institution/${inst.id.split('/').pop()}`); }}
                          >
                            {localizedName}
                          </button>
                        </h4>
                        <p>{inst.country_code || (isEnglish ? 'Unknown country' : 'País desconocido')} • {isEnglish ? 'Academic institution' : 'Institución académica'}</p>
                      </div>
                      <FollowButton
                        entity={{
                          type: 'institution',
                          id: inst.id,
                          displayName: inst.display_name,
                          source: inst._metadataSource || 'ror',
                          externalIds: { ror: inst.ror || inst.id },
                          metadata: { localizedNames: inst.localized_names },
                        }}
                        isFollowing={isFollowing}
                        isPending={isFollowPending}
                        onToggle={handleToggleFollow}
                      />
                    </div>
                  );
```

El objeto `entity` y las props de `FollowButton` quedan exactamente como estaban (líneas 1079-1091); los únicos cambios reales son quitar `role`, `tabIndex` y `onKeyDown` del contenedor y envolver `{localizedName}` en el botón.

- [ ] **Step 2: Style**

Al final de `src/components/Search/SearchPage.css`:

```css
.search-item-title-btn {
  font: inherit;
  color: inherit;
  padding: 0;
  text-align: left;
}
```

- [ ] **Step 3: Verify with the keyboard**

En `/search`, buscar «MIT»: en cada institución, Tab para en el nombre (Enter navega al explorer) y en Seguir como controles separados; el lector de pantalla ya no anuncia un botón dentro de un enlace.

- [ ] **Step 4: Run checks and commit**

```bash
npm run lint && npm test
git add src/components/Search/SearchPage.jsx src/components/Search/SearchPage.css
git commit -m "fix(a11y): el resultado de institución separa navegar y seguir en controles distintos"
```

---

### Task 10: Verificación de conjunto y matriz de evidencia

Cierre exigido por `docs/ACCESIBILIDAD.md`: recorrido de teclado de los flujos tocados, `npm run check` completo y registro de evidencia con sus limitaciones.

**Files:**
- Create: `docs/ACCESIBILIDAD-EVIDENCIA.md`

**Interfaces:**
- Consumes: todo lo anterior. Produces: la matriz que los planes de las fases 3-5 seguirán ampliando.

- [ ] **Step 1: Full keyboard walkthrough**

Con el dev server, sin tocar el ratón:

1. Cargar `/` → Tab 1 = «Saltar al contenido»; Enter → foco en el contenido.
2. Feed: flechas ↑/↓ cambian de paper; Tab recorre título→autores→«et al.»→abstract-toggle→rail (like, guardar, etc.); Enter en un autor navega y al volver (atrás del navegador) el feed sigue operable.
3. Navegación anunciada: al pulsar Research y Siguiendo en el navbar, el título de la pestaña cambia y el foco aterriza en `#main-content`.
4. Navbar: Tab recorre marca→buscador→Para ti→Research→Siguiendo→preferencias→avatar; cada parada muestra el anillo de foco; «Para ti» expone `aria-current="page"` en `/`.
5. `/lists`: abrir una lista desde su nombre, abrir un paper desde su título, editar y quitar — todo con Enter.
6. `/research`: abrir un paper desde un titular.
7. `/search`: buscar, alcanzar un resultado de institución, navegar desde el nombre, volver, alternar Seguir.
8. En Ajustes → «Configura tu algoritmo»: las píldoras muestran anillo de foco (la gestión de foco del modal en sí queda para la fase 3 y se anota como defecto conocido).
9. Repetir 1-4 en tema oscuro (anillo naranja visible).

Cualquier paso que falle se arregla antes de continuar: los criterios de este recorrido son criterios de aceptación del plan, no sugerencias.

- [ ] **Step 2: Run the full check**

Run: `npm run check`
Expected: secretos, lint, tests (incluidos `contrast.test.js` y `routeMetadata.test.js`), build y dry-run del worker en verde.

- [ ] **Step 3: Record the evidence matrix**

Crear `docs/ACCESIBILIDAD-EVIDENCIA.md` con el formato de `docs/ACCESIBILIDAD.md` («Evidencia y criterio de finalización»), una fila por criterio tocado. Plantilla a rellenar con los resultados reales del recorrido:

```markdown
# Evidencia de accesibilidad

Matriz viva exigida por `docs/ACCESIBILIDAD.md`. Cada entrega la amplía o reprueba.

## Entrega: fases 1-2 (fecha de ejecución)

| Página o flujo | Componente | Criterio WCAG | Resultado | Evidencia | Defecto o limitación | Reprueba |
|---|---|---|---|---|---|---|
| Global | variables.css / global.css | 1.4.3, 1.4.11, 2.4.7 | Cumple | `src/styles/contrast.test.js` + recorrido Tab en ambos temas | — | En cada `npm test` |
| Global | App.jsx (skip link, RouteAnnouncer) | 2.4.1, 2.4.2, 2.4.3 | Cumple | `src/utils/routeMetadata.test.js` + recorrido del Step 1 | Rutas públicas titulan por su cuenta (usePublicPageMetadata) | Recorrido manual |
| Feed | FeedContainer, PaperCard | 2.1.1, 4.1.2, 1.3.1, 3.1.2 | Cumple | Recorrido teclado Step 1.2 | Abstract: `lang` pendiente de la vista simplificada (fase 5); sin ul/li ni role="feed" (fase 3+) | Recorrido manual |
| Listas | ListsPage | 2.1.1, 4.1.2 | Cumple | Recorrido teclado Step 1.5 | Botones con `title` sin aria-label (A10, fase 4) | Recorrido manual |
| Research | ResearchForme | 2.1.1, 4.1.2 | Cumple | Recorrido teclado Step 1.6 | — | Recorrido manual |
| Búsqueda | SearchPage (instituciones) | 4.1.2 | Cumple | Recorrido teclado Step 1.7 | Resultados siguen sin anunciarse (C6, fase 4) | Recorrido manual |
| Ajustes | EditInterestsModal | 2.4.7 | Parcial | Anillo visible en píldoras | Sin role="dialog"/foco/Escape (C7, fase 3) | Fase 3 |

**Limitación global declarada:** sin prueba con lector de pantalla real todavía;
la experiencia con VoiceOver/NVDA NO está verificada. Queda como requisito de la
fase 6 antes de afirmar conformidad de ningún criterio ante terceros.
```

Sustituir «(fecha de ejecución)» por la fecha real y cada «Cumple» por lo que el recorrido haya dado de verdad — si un paso falló y se arregló, anotarlo; si quedó pendiente, `No cumple` con su defecto.

- [ ] **Step 4: Commit**

```bash
git add docs/ACCESIBILIDAD-EVIDENCIA.md
git commit -m "docs(a11y): matriz de evidencia de las fases 1-2"
```

---

## Fuera de alcance de este plan (planes siguientes)

- **Fase 3 — diálogos y anuncios de estado:** C7 (reescritura de EditInterestsModal), C8 (AuthPrompt), A4, M3, M4, C6 (búsqueda anunciada), A6, C10, M8, M24, A5, A8/A9 restantes (listas y h1 de Search/Following).
- **Fase 4 — formularios y nombres:** A10, A11, M21, M25, B2-B4, temporizadores M7.
- **Fase 5 — lector y objetivos:** C2 (anotación por teclado/táctil), A7, M16, B15, `lang` del abstract/lector según vista original o simplificada.
- **Fase 6 — verificación con tecnología de apoyo:** VoiceOver como mínimo, zoom 200 %, reflow 320 px; solo después puede afirmarse conformidad.
