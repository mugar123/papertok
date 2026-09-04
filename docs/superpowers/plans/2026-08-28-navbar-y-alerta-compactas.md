# Navbar y alerta de analítica compactas — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplicar los tres cambios pedidos por Samuel el 28/8: alerta de analítica en una sola fila sin botón «No permitir», navbar sin botón de recargar, y un mini botón de preferencias que agrupe tema e idioma.

**Architecture:** Tres cambios independientes sobre el cromo existente. La alerta pasa de dos filas de grid a una (icono | texto | botón | X), donde la X hereda el `handleDecline` existente para que el rechazo siga persistiéndose. El botón de recargar de la navbar se elimina junto con su fontanería de eventos (`refreshScientificReport`, `reportLoadingStart/End`), que no tiene otro consumidor. El `ThemeToggle` suelto de la navbar se sustituye por `NavPreferencesMenu`, un disclosure con popover CSS (sin framer-motion) que contiene tema, idioma y un enlace a `/settings`.

**Tech Stack:** React 18 + Vite, CSS plano con tokens (`var(--…)`), lucide-react, tests de aserción sobre el fuente con `node --test` (patrón de `readerMobileStyles.test.js`).

**Spec:** Mensajes de Samuel del 28/8/26 (8:35), recogidos en la cabecera de este plan y auditados en la sección «Auditoría» de abajo.

## Auditoría (contexto que el ejecutor debe conocer)

1. **Alerta de analítica** ([AnalyticsConsentBanner.jsx](../../../src/components/Privacy/AnalyticsConsentBanner.jsx)): hoy es un grid de dos filas — icono+texto arriba, dos botones abajo — y la fila de acciones (36 px + 12 px de gap) es lo que Samuel quiere recuperar. **Cuidado:** el consentimiento persiste un año en localStorage+cookie y la alerta reaparece en cada visita al feed mientras `consent === null`. Si «No permitir» desaparece sin sustituto, quien no quiera analítica verá la alerta para siempre. Por eso el plan la sustituye por una **X discreta que registra DENIED** (mismo `handleDecline`), y el ajuste sigue siendo reversible en `/settings` («Analítica de uso»). La analítica es opt-in: con `consent !== GRANTED` no se envía nada, así que quitar el botón de texto no cambia la privacidad efectiva.

2. **Botón de recargar** ([Navbar.jsx:124-133](../../../src/components/Layout/Navbar.jsx)): hace tres cosas según la ruta — `refreshFeed()` (feed), evento `refreshScientificReport` (research) y `refreshFollowing()` (siguiendo). Las tres cachés que fuerza son `Map`s en memoria, así que **una recarga de página consigue lo mismo**; Samuel tiene razón. Lo único que se pierde: el `randomizeStart` del feed (página inicial aleatoria 0–4) y el spinner de 800 ms — y el feed conserva su propio refresh dentro de `FeedContainer` (línea ~227), la página de research sus botones de reintento con `forceRefresh`, y el feed de invitado su propio botón en `GuestFeedPage` (fuera de alcance: Samuel habla de la navbar). Al quitar el botón, el listener de `refreshScientificReport` y los dispatch de `reportLoadingStart/End` en `ScientificReport.jsx` quedan muertos: se limpian también.

3. **Mini botón de preferencias**: la zona derecha de la navbar queda tras las tareas 1–2 con lupa compacta (≤900 px), `ThemeToggle` y avatar. El mini botón agrupa tema + idioma (hoy el idioma solo se cambia en `/settings`) y enlaza a los ajustes completos. `ThemeToggle` sigue existiendo como componente: `GuestFeedPage` lo usa con su propio chrome y no se toca.

## Global Constraints

- Registro de commits en español, estilo del repo: `tipo(ámbito): frase en minúsculas` (ej. `fix(tarjeta): …`).
- Nada de framer-motion nuevo en el cromo: el popover anima con transición CSS y respeta `@media (prefers-reduced-motion: reduce)` (auditoría móvil 2026-08-28: las animaciones esperan al rediseño).
- Colores y radios siempre por tokens `var(--…)`; los botones de icono de la navbar son `.navbar-icon-btn` de 32×32 (28×28 a ≤420 px).
- Tests con `node --test` y aserciones sobre el fuente (patrón `readerMobileStyles.test.js`); no hay jsdom.
- Antes de cada commit: `git diff` fichero a fichero (puede haber otra sesión editando el árbol) y `npm run lint && npm test`.
- **Commits aplazados (28-08, petición del usuario):** hay otros agentes trabajando en el mismo árbol, así que la ejecución dejó los tres cambios sin commitear. Los pasos «Commit» de cada tarea siguen siendo la referencia de qué ficheros agrupar cuando se retomen.
- No se despliega en este plan; si alguien despliega después, rebase primero (wrangler sube el árbol entero).

---

### Task 1: Alerta de analítica en una fila

**Files:**
- Modify: `src/components/Privacy/AnalyticsConsentBanner.jsx`
- Modify: `src/components/Privacy/AnalyticsConsentBanner.css`
- Test: `src/components/Privacy/analyticsConsentStyles.test.js` (nuevo)

**Interfaces:**
- Consumes: `handleDecline` y `copy` ya existentes en el componente; `ANALYTICS_CONSENT.DENIED` vía `updateConsent` (sin cambios de API).
- Produces: clases CSS `analytics-consent-dismiss` (X) y el grid de una fila `40px minmax(0, 1fr) auto auto`; ningún otro fichero las consume.

- [ ] **Step 1: Escribir el test que falla**

Crear `src/components/Privacy/analyticsConsentStyles.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * La alerta de consentimiento cabe en una fila.
 *
 * El botón «No permitir» se fue y su hueco lo ocupa una X que registra el
 * mismo rechazo; el botón de aceptar sube a la fila del texto. Nada de esto
 * lo vigila el build — un grid de dos filas es CSS válido — así que se
 * sostiene aquí, leyendo el fuente como hace readerMobileStyles.test.js.
 */

const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '');

const cssPromise = readFile(new URL('./AnalyticsConsentBanner.css', import.meta.url), 'utf8').then(stripComments);
const jsxPromise = readFile(new URL('./AnalyticsConsentBanner.jsx', import.meta.url), 'utf8');

test('el botón de texto «No permitir» ya no existe', async () => {
  const jsx = await jsxPromise;
  assert.ok(!jsx.includes('analytics-consent-decline'), 'la clase del botón de rechazo de texto sigue en el JSX');
});

test('la X de cierre registra el rechazo, no solo esconde la alerta', async () => {
  const jsx = await jsxPromise;
  assert.ok(jsx.includes('analytics-consent-dismiss'), 'falta la X de cierre');
  const dismissBlock = jsx.slice(jsx.indexOf('analytics-consent-dismiss'));
  assert.match(dismissBlock.slice(0, 400), /onClick=\{handleDecline\}/, 'la X debe llamar a handleDecline para persistir DENIED');
});

test('el grid es de una fila: icono, texto, acción y X como columnas', async () => {
  const css = await cssPromise;
  const rule = css.match(/\.analytics-consent\s*\{([^}]*)\}/);
  assert.ok(rule, 'falta la regla .analytics-consent');
  assert.match(rule[1], /grid-template-columns:\s*40px\s+minmax\(0,\s*1fr\)\s+auto\s+auto/, 'las acciones deben ser columnas de la misma fila');
  assert.match(rule[1], /align-items:\s*center/, 'la fila única se alinea al centro');
});

test('en móvil el icono cede su columna al texto en vez de apilar las acciones', async () => {
  const css = await cssPromise;
  const start = css.indexOf('@media (max-width: 560px)');
  assert.notEqual(start, -1, 'falta el media query de 560px');
  const block = css.slice(start, css.indexOf('@media', start + 1) === -1 ? css.length : css.indexOf('@media', start + 1));
  assert.match(block, /\.analytics-consent-icon\s*\{[^}]*display:\s*none/, 'el icono debe ocultarse en móvil');
  assert.ok(!/analytics-consent-actions\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(block), 'las acciones ya no se apilan bajo el texto');
});
```

- [ ] **Step 2: Verlo fallar**

Run: `node --test src/components/Privacy/analyticsConsentStyles.test.js`
Expected: FAIL (los cuatro casos, contra el fuente actual).

- [ ] **Step 3: Editar el JSX**

En `AnalyticsConsentBanner.jsx`:

1. Importar `X` de lucide: `import { BarChart3, Check, LoaderCircle, X } from 'lucide-react';`
2. En `COPY`, sustituir la clave `decline` por `dismiss`:
   - es: `dismiss: 'Cerrar y no permitir',`
   - en: `dismiss: 'Dismiss and do not allow',`
3. Sustituir el botón de rechazo dentro de `.analytics-consent-actions` por nada (el div de acciones queda solo con el botón de aceptar) y añadir, justo después del cierre de `</div>` de las acciones, la X:

```jsx
          <div className="analytics-consent-actions">
            <button
              type="button"
              className={`analytics-consent-accept is-${acceptanceState}`}
              disabled={decisionInProgress}
              aria-live="polite"
              onClick={handleAccept}
            >
              {acceptanceState === 'loading' && <LoaderCircle size={14} aria-hidden="true" />}
              {acceptanceState === 'success' && <Check size={15} aria-hidden="true" />}
              {acceptanceState === 'idle' && copy.accept}
              {acceptanceState === 'loading' && copy.activating}
              {acceptanceState === 'success' && copy.activated}
              {acceptanceState === 'error' && copy.accept}
            </button>
          </div>
          <button
            type="button"
            className="analytics-consent-dismiss"
            disabled={decisionInProgress}
            onClick={handleDecline}
            aria-label={copy.dismiss}
            title={copy.dismiss}
          >
            <X size={14} aria-hidden="true" />
          </button>
```

`handleDecline` no cambia: sigue persistiendo `ANALYTICS_CONSENT.DENIED` y descartando la alerta.

- [ ] **Step 4: Editar el CSS**

En `AnalyticsConsentBanner.css`:

1. Regla base `.analytics-consent`: cambiar `grid-template-columns: 40px minmax(0, 1fr);` por `grid-template-columns: 40px minmax(0, 1fr) auto auto;` y añadir `align-items: center;`.
2. Regla `.analytics-consent-actions`: quitar `grid-column: 2;` y `justify-content: flex-end;` (ahora es una columna propia).
3. Regla `.analytics-consent-error`: cambiar `grid-column: 2;` por `grid-column: 1 / -1;`.
4. Sustituir la regla `.analytics-consent-decline:disabled` y el hover de `.analytics-consent-decline` por la X:

```css
.analytics-consent-dismiss {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-tertiary);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.analytics-consent-dismiss:disabled {
  opacity: 0.48;
  cursor: default;
}

@media (hover: hover) and (pointer: fine) {
  .analytics-consent-dismiss:hover {
    color: var(--text-primary);
    background: var(--bg-sunken);
  }
}
```

5. En el bloque `@media (max-width: 560px)`: sustituir `.analytics-consent-actions { grid-column: 1 / -1; }` por:

```css
  .analytics-consent {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .analytics-consent-icon {
    display: none;
  }
```

   (la regla de `.analytics-consent-error` del mismo bloque ya no hace falta: la base ya dice `1 / -1`; eliminarla).
6. En el bloque `prefers-reduced-motion`, añadir `.analytics-consent-dismiss` a la lista de selectores.

- [ ] **Step 5: Verlo pasar**

Run: `node --test src/components/Privacy/analyticsConsentStyles.test.js`
Expected: PASS (4 casos).

- [ ] **Step 6: Verificación visual**

Con el dev server del proyecto abierto en el pane del navegador: en `/` como usuaria sin decisión de consentimiento (borrar `papertok_analytics_consent` de localStorage y la cookie `papertok_analytics_decision`, recargar), comprobar que la alerta es una sola fila con la X a la derecha, que la X la cierra y no reaparece al recargar, y a 375 px de ancho que el icono desaparece y nada desborda. Nota del arnés: navegar por hash+reload; el pane oculto congela framer, mantenerlo visible al mirar la animación de entrada.

- [ ] **Step 7: Commit**

```bash
git add src/components/Privacy/AnalyticsConsentBanner.jsx src/components/Privacy/AnalyticsConsentBanner.css src/components/Privacy/analyticsConsentStyles.test.js
git commit -m "fix(privacidad): la alerta de analítica cabe en una fila

El botón «No permitir» se sustituye por una X que registra el mismo
rechazo (el consentimiento persiste un año; sin vía de rechazo la alerta
reaparecería en cada visita), y el botón de aceptar sube a la fila del
texto: la fila de acciones desaparece y con ella ~48px de alto."
```

---

### Task 2: Quitar el botón de recargar de la navbar

**Files:**
- Modify: `src/components/Layout/Navbar.jsx`
- Modify: `src/components/Layout/Navbar.css`
- Modify: `src/components/Report/ScientificReport.jsx:221,243,278,304-311`
- Test: `src/components/Layout/navbarChrome.test.js` (nuevo)

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `Navbar` deja de consumir `refreshFeed`/`isRefreshing` (de `useFeed`) y `useFollowingUpdates`; ambos contextos conservan su API porque `FeedContainer`, `GuestFeedPage` y `FollowingFeedPage` la siguen usando. Los eventos `refreshScientificReport` y `reportLoadingStart/End` desaparecen del código (emisor y receptor a la vez).

- [ ] **Step 1: Escribir el test que falla**

Crear `src/components/Layout/navbarChrome.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * La navbar sin botón de recargar.
 *
 * Recargar la página consigue lo mismo (las tres cachés que forzaba son Maps
 * en memoria), así que el botón, su spinner y el bus de eventos que lo
 * mantenía girando durante el informe se van juntos. Se sostiene aquí porque
 * un listener sin emisor y un keyframes sin consumidor compilan sin queja.
 */

const navbarJsx = readFile(new URL('./Navbar.jsx', import.meta.url), 'utf8');
const navbarCss = readFile(new URL('./Navbar.css', import.meta.url), 'utf8');
const reportJsx = readFile(new URL('../Report/ScientificReport.jsx', import.meta.url), 'utf8');

test('la navbar no dibuja el botón de recargar ni escucha al informe', async () => {
  const jsx = await navbarJsx;
  for (const resto of ['RotateCw', 'refreshScientificReport', 'reportLoadingStart', 'reportLoadingEnd', 'showReloadButton', 'handleReload']) {
    assert.ok(!jsx.includes(resto), `\`${resto}\` sigue en Navbar.jsx`);
  }
});

test('el informe ya no emite los eventos que solo la navbar escuchaba', async () => {
  const jsx = await reportJsx;
  for (const resto of ['refreshScientificReport', 'reportLoadingStart', 'reportLoadingEnd']) {
    assert.ok(!jsx.includes(resto), `\`${resto}\` sigue en ScientificReport.jsx`);
  }
});

test('el spinner de la navbar se fue con su botón', async () => {
  const css = await navbarCss;
  assert.ok(!css.includes('.navbar-icon-btn.spinning'), 'la regla del spinner sigue en Navbar.css');
  assert.ok(!css.includes('@keyframes spin'), 'el keyframes spin ya no tiene consumidor en Navbar.css');
});
```

- [ ] **Step 2: Verlo fallar**

Run: `node --test src/components/Layout/navbarChrome.test.js`
Expected: FAIL (3 casos).

- [ ] **Step 3: Editar Navbar.jsx**

1. Imports: quitar `RotateCw` de lucide; quitar `import { useFollowingUpdates } from '../../context/FollowingUpdatesContext';`; dejar `useState` solo si sigue usándose (tras este paso no: quitarlo y dejar `import { useEffect } from 'react';`).
2. En el cuerpo: quitar `refreshFeed, isRefreshing` del destructuring de `useFeed()` (queda `const { feedMode, setFeedMode } = useFeed();`); quitar la línea de `useFollowingUpdates`; quitar `const [isReportRefreshing, setIsReportRefreshing] = useState(false);`.
3. Quitar entero el `useEffect` de `reportLoadingStart`/`reportLoadingEnd` (líneas 36–45).
4. Quitar `showReloadButton`, `reloadSpinning` y `handleReload` (líneas 51–60).
5. Quitar el bloque JSX del botón (líneas 124–133, el `{showReloadButton && (…)}`).
6. El comentario de la Regla 6 sobre `ThemeToggle` menciona «reload»; reescribirlo para que hable del grupo de utilidades sin nombrar al botón muerto.

- [ ] **Step 4: Editar Navbar.css y ScientificReport.jsx**

1. `Navbar.css`: eliminar la regla `.navbar-icon-btn.spinning svg` (líneas 233–235), el `@keyframes spin` (386–389) y la repetición de `.navbar-icon-btn.spinning svg` dentro del bloque `prefers-reduced-motion` (400–402).
2. `ScientificReport.jsx`: eliminar el `useEffect` de `refreshScientificReport` (líneas 304–311) y las tres líneas `window.dispatchEvent(new Event('reportLoading…'))` (221, 243, 278). No tocar los botones de reintento con `forceRefresh` de las líneas ~472 y ~522: son la vía que queda para regenerar el informe.

- [ ] **Step 5: Verlo pasar y pasar la suite**

Run: `node --test src/components/Layout/navbarChrome.test.js && npm run lint && npm test`
Expected: PASS el nuevo test; lint y suite completos en verde.

- [ ] **Step 6: Verificación visual**

En el pane, con sesión iniciada: `/`, `/research` y `/following` muestran la zona derecha sin el botón de recargar y sin hueco raro (el borde izquierdo `border-left` del grupo sigue pegado al primer icono visible). Recargar la página en `/research` regenera el informe (las cachés son de memoria).

- [ ] **Step 7: Commit**

```bash
git add src/components/Layout/Navbar.jsx src/components/Layout/Navbar.css src/components/Report/ScientificReport.jsx src/components/Layout/navbarChrome.test.js
git commit -m "feat(navbar): fuera el botón de recargar

Recargar la página consigue lo mismo: las tres cachés que forzaba
(arxiv, informe, tendencias) viven en Maps de memoria. Se van con él el
listener de refreshScientificReport y los eventos reportLoadingStart/End,
que no tenían otro consumidor; el feed conserva su refresh propio en
FeedContainer y el informe sus reintentos con forceRefresh."
```

---

### Task 3: Mini botón de preferencias en la navbar

**Files:**
- Create: `src/components/Layout/NavPreferencesMenu.jsx`
- Create: `src/components/Layout/NavPreferencesMenu.css`
- Modify: `src/components/Layout/Navbar.jsx` (sustituir `<ThemeToggle />`)
- Test: `src/components/Layout/navbarChrome.test.js` (ampliar)

**Interfaces:**
- Consumes: `useTheme()` → `{ isDark, toggleTheme(el) }`; `useLanguage()` → `{ language, isEnglish, setLanguage(lang) }` (setLanguage es async, se dispara sin await como hace SettingsPage); `useAuth()` → `{ user }`; `useNavigate()`.
- Produces: componente `NavPreferencesMenu` (default export, sin props) que la navbar monta en el hueco del antiguo `ThemeToggle`. `ThemeToggle` sigue exportándose sin cambios para `GuestFeedPage`.

- [ ] **Step 1: Ampliar el test (que falla)**

Añadir a `src/components/Layout/navbarChrome.test.js`:

```js
const prefsJsx = readFile(new URL('./NavPreferencesMenu.jsx', import.meta.url), 'utf8');
const prefsCss = readFile(new URL('./NavPreferencesMenu.css', import.meta.url), 'utf8');

test('la navbar monta el menú de preferencias en vez del toggle suelto', async () => {
  const jsx = await navbarJsx;
  assert.ok(jsx.includes('NavPreferencesMenu'), 'la navbar no importa NavPreferencesMenu');
  assert.ok(!jsx.includes('<ThemeToggle'), 'el ThemeToggle suelto sigue en la navbar');
});

test('el menú reúne tema, idioma y el enlace a ajustes', async () => {
  const jsx = await prefsJsx;
  assert.match(jsx, /toggleTheme\(/, 'falta el tema');
  assert.match(jsx, /setLanguage\(/, 'falta el idioma');
  assert.match(jsx, /navigate\('\/settings'\)/, 'falta el enlace a ajustes');
  assert.match(jsx, /aria-expanded/, 'el disclosure debe anunciar su estado');
});

test('el popover se ancla al botón y anima solo con CSS', async () => {
  const css = await prefsCss;
  const rule = css.match(/\.nav-prefs-menu\s*\{([^}]*)\}/);
  assert.ok(rule, 'falta la regla .nav-prefs-menu');
  assert.match(rule[1], /position:\s*absolute/);
  assert.match(css, /prefers-reduced-motion/, 'el popover debe respetar reduced motion');
});
```

- [ ] **Step 2: Verlo fallar**

Run: `node --test src/components/Layout/navbarChrome.test.js`
Expected: FAIL — los dos primeros casos nuevos por ENOENT/aserción, el tercero por ENOENT.

- [ ] **Step 3: Crear NavPreferencesMenu.jsx**

```jsx
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Moon, Settings, SlidersHorizontal, Sun } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useTheme } from '../../context/ThemeContext';
import './NavPreferencesMenu.css';

/**
 * Las preferencias rápidas de la barra, plegadas tras un solo icono: el tema
 * dejó de ocupar un botón propio y el idioma gana su primer acceso fuera de
 * /settings. Es un disclosure, no un menu ARIA: dentro hay toggles con estado,
 * y un role="menu" prometería flechas y items sin estado que esto no tiene.
 */
export default function NavPreferencesMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const themeRowRef = useRef(null);
  const { isDark, toggleTheme } = useTheme();
  const { language, isEnglish, setLanguage } = useLanguage();
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const label = isEnglish ? 'Preferences' : 'Preferencias';

  return (
    <div className="nav-prefs" ref={rootRef}>
      <button
        type="button"
        className={`navbar-icon-btn nav-prefs-trigger ${open ? 'is-open' : ''}`}
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <SlidersHorizontal size={17} aria-hidden="true" />
      </button>

      {open && (
        <div className="nav-prefs-menu" role="group" aria-label={label}>
          <button
            type="button"
            ref={themeRowRef}
            className="nav-prefs-row"
            aria-pressed={isDark}
            onClick={() => toggleTheme(themeRowRef.current)}
          >
            {isDark ? <Moon size={15} aria-hidden="true" /> : <Sun size={15} aria-hidden="true" />}
            <span>{isEnglish ? 'Dark mode' : 'Modo oscuro'}</span>
            {isDark && <Check size={14} className="nav-prefs-check" aria-hidden="true" />}
          </button>

          <div className="nav-prefs-row nav-prefs-row--static">
            <span>{isEnglish ? 'Language' : 'Idioma'}</span>
            <div className="nav-prefs-lang" role="group" aria-label={isEnglish ? 'Language' : 'Idioma'}>
              <button
                type="button"
                aria-pressed={language === 'es'}
                onClick={() => { setLanguage('es'); }}
              >
                ES
              </button>
              <button
                type="button"
                aria-pressed={language === 'en'}
                onClick={() => { setLanguage('en'); }}
              >
                EN
              </button>
            </div>
          </div>

          {user && (
            <>
              <div className="nav-prefs-divider" role="separator" />
              <button
                type="button"
                className="nav-prefs-row"
                onClick={() => {
                  setOpen(false);
                  navigate('/settings');
                }}
              >
                <Settings size={15} aria-hidden="true" />
                <span>{isEnglish ? 'All settings' : 'Todos los ajustes'}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Crear NavPreferencesMenu.css**

```css
/* El popover de preferencias: un desplegable anclado al grupo de utilidades.
   Anima con una transición CSS de entrada (opacity/translate) — nada de
   framer en el cromo — y a la derecha se pega al borde del propio botón. */

.nav-prefs {
  position: relative;
  display: flex;
  align-items: center;
}

.nav-prefs-trigger.is-open {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.nav-prefs-menu {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  z-index: var(--z-nav);
  min-width: 216px;
  padding: 6px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  box-shadow: 0 16px 40px rgba(17, 19, 24, 0.14);
  animation: navPrefsIn 0.16s ease-out;
}

@keyframes navPrefsIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

.nav-prefs-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-md);
  background: none;
  color: var(--text-secondary);
  font-family: var(--font-body);
  font-size: var(--fs-sm);
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.nav-prefs-row span {
  flex: 1;
}

.nav-prefs-row svg {
  color: var(--text-tertiary);
}

.nav-prefs-row--static {
  cursor: default;
}

.nav-prefs-check {
  flex: 0 0 auto;
}

.nav-prefs-lang {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.nav-prefs-lang button {
  padding: 3px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-tertiary);
  font: 600 0.6875rem/1.4 var(--font-mono);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.nav-prefs-lang button[aria-pressed='true'] {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.nav-prefs-divider {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-default);
}

@media (hover: hover) and (pointer: fine) {
  .nav-prefs-row:not(.nav-prefs-row--static):hover {
    background: var(--bg-glass);
    color: var(--text-primary);
  }
}

@media (prefers-reduced-motion: reduce) {
  .nav-prefs-menu,
  .nav-prefs-row,
  .nav-prefs-lang button {
    animation: none;
    transition: none;
  }
}
```

- [ ] **Step 5: Sustituir el ThemeToggle de la navbar**

En `Navbar.jsx`:

1. Cambiar `import ThemeToggle from './ThemeToggle';` por `import NavPreferencesMenu from './NavPreferencesMenu';`.
2. Sustituir `<ThemeToggle />` (y su comentario de la Regla 6, ya reescrito en la Task 2) por:

```jsx
          {/* Regla 6: las utilidades se agrupan a la derecha tras la regla de
              1px. Tema e idioma viven plegados tras el botón de preferencias:
              cambian cómo se ve la aplicación, no lo que está mostrando. */}
          <NavPreferencesMenu />
```

`ThemeToggle.jsx` y `ThemeToggle.css` no se tocan: `GuestFeedPage` los sigue usando.

- [ ] **Step 6: Verlo pasar y pasar la suite**

Run: `node --test src/components/Layout/navbarChrome.test.js && npm run lint && npm test && npm run build`
Expected: PASS todos los casos; lint, suite y build en verde.

- [ ] **Step 7: Verificación visual**

En el pane: abrir el menú, cambiar el tema desde la fila (la vista debe transicionar igual que con el toggle antiguo — `toggleTheme` recibe el elemento origen), cambiar ES→EN y ver la navbar re-etiquetarse, click fuera y Escape lo cierran, «Todos los ajustes» navega a `/settings` y cierra el menú. A 375 px: el popover no desborda el viewport por la derecha (está anclado `right: 0` dentro de `.navbar-right`). En el feed de invitado (sin sesión), el header conserva su toggle de tema de siempre. Nota del arnés: el pane oculto congela las transiciones CSS — mantenerlo visible o leer el estado final con `getComputedStyle`.

- [ ] **Step 8: Commit**

```bash
git add src/components/Layout/NavPreferencesMenu.jsx src/components/Layout/NavPreferencesMenu.css src/components/Layout/Navbar.jsx src/components/Layout/navbarChrome.test.js
git commit -m "feat(navbar): tema e idioma se pliegan tras un mini botón de preferencias

El ThemeToggle suelto deja su hueco a un disclosure con popover CSS que
reúne tema, idioma (su primer acceso fuera de /settings) y el enlace a
los ajustes completos. El feed de invitado conserva su toggle propio."
```
