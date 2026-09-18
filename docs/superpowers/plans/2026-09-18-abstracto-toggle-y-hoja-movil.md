# El abstracto de la tarjeta: el «Show less» fantasma y la hoja de lectura en móvil — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que pulsar un abstracto que cabe entero no haga aparecer «Show less»; y que en móvil,
pulsar un abstracto recortado (el que muestra «Read full abstract») o su botón abra una hoja
inferior con el abstracto completo, cómodo de leer, en vez de desplegarlo dentro de la tarjeta.

**Architecture:** Dos cambios en `PaperCard` y un componente nuevo. (1) `toggleExpanded` deja de
abrir un panel que no oculta nada: sin `abstractClipped === true` ni `expanded`, el clic no
hace nada. (2) En un puntero grueso (`(pointer: coarse)`, el mismo criterio del lector) y con el
panel recortado, el clic en el panel o en el botón monta `AbstractSheet` en lugar de desplegar.
`AbstractSheet` es un `Drawer` inferior de la casa (`ui/drawer.jsx`) con `usePopupOpenOnMount`,
como `RelatedPapersSheet`: asa, área y título, autores, el abstracto completo con la tipografía
del lector y un botón de cerrar; el cuerpo desplaza por dentro y no dispara el swipe.

**Tech Stack:** React 19, Base UI Drawer, `node --test`, Vite. Verificación con Chrome headless
por CDP sobre la build de producción: escritorio (1440×900) y móvil emulado (390×844, táctil,
`pointer: coarse`), feed de invitado.

**Spec:** este documento (diseño en §Architecture) y la reproducción del bug: en escritorio,
pulsar un abstracto con `pc-abstract--whole` lo pone en `pc-abstract--open` y el botón reservado
sale diciendo «Show less» (medido el 18-09 con `abstract-bug-probe.mjs`).

## Global Constraints

- **El escritorio no cambia**: el despliegue en línea sigue igual (curva, 420 ms, máscara,
  `handleAbstractTransitionEnd`). Solo se añade la puerta de «no hay nada que abrir».
- **La expresión de clase del botón no cambia**
  (`abstractClipped === true || expanded ? '' : ' pc-abstract-toggle--reserved'`): la fija
  `paperCardArrival.test.js` y su reserva de caja es lo que evita el salto de 25 px en móvil.
- **Puerta por tipo de puntero, nunca por ancho** (memoria del lector: encoger una ventana de
  portátil no debe cambiar de ruta a un usuario con ratón).
- **La hoja sigue el patrón de `RelatedPapersSheet`**: `usePopupOpenOnMount`, `onOpenChange(false)
  → requestClose`, `onOpenChangeComplete(false) → onClose`, el padre la monta como
  `{x && <Sheet/>}`; `data-base-ui-swipe-ignore` en la región que desplaza.
- Tests SOURCE despojan comentarios. Comentarios en inglés (los ficheros van en inglés).
- Sin analítica nueva ni acciones extra en la hoja (nada de «ya que estoy»).

---

### Task 1: un panel que no oculta nada no se abre

**Files:**
- Modify: `src/components/Feed/PaperCard.jsx` (`toggleExpanded`)
- Test: `src/components/Feed/abstractSheet.test.js` (nuevo; también recoge la Tarea 2)

**Interfaces:**
- Produces: `toggleExpanded(e, newState)` devuelve sin hacer nada cuando `newState` es `true`
  y `abstractClipped !== true`.

- [x] **Step 1: test que falla**

```js
test('a panel that hides nothing cannot be opened, so the reserved toggle never says "Show less"', async () => {
  const jsx = stripComments(await read('./PaperCard.jsx'));
  assert.match(jsx, /const toggleExpanded = \(e, newState\) => \{\s*e\.stopPropagation\(\);\s*if \(newState && abstractClipped !== true\) return;/);
});
```

- [x] **Step 2: implementar** — en `toggleExpanded`, tras `e.stopPropagation()`:

```js
    // A panel that hides nothing has nothing to open. Without this, tapping an
    // abstract that fits whole flipped `expanded` on, and the toggle — reserved
    // beneath it, invisible — came up saying "Show less" for a panel that had
    // never been anything but open (measured 2026-09-18, guest feed, desktop).
    if (newState && abstractClipped !== true) return;
```

- [x] **Step 3: `node --test src/components/Feed/abstractSheet.test.js src/components/Feed/paperCardArrival.test.js`** → verde.

---

### Task 2: en móvil, el abstracto recortado se lee en una hoja

**Files:**
- Create: `src/components/Feed/AbstractSheet.jsx`, `src/components/Feed/AbstractSheet.css`
- Modify: `src/components/Feed/PaperCard.jsx` (puerta por puntero, estado `showAbstractSheet`,
  el botón y el panel, el montaje de la hoja)
- Test: `src/components/Feed/abstractSheet.test.js`

**Interfaces:**
- Produces: `<AbstractSheet paper onClose />`. `paper.title`, `paper.authors` (`{name}` o string),
  `paper.abstract`; `onClose` se llama cuando la salida ha terminado.
- Consumes: `Drawer, DrawerBody, DrawerClose, DrawerContent, DrawerHandle, DrawerTitle` de
  `ui/drawer.jsx`; `usePopupOpenOnMount`; `ScientificText`; `areaLabelForPaper`; `useLanguage`.

- [x] **Step 1: tests que fallan** (mismo fichero):

```js
test('on a coarse pointer a clipped abstract opens the reading sheet instead of unfolding in the card', async () => {
  const jsx = stripComments(await read('./PaperCard.jsx'));
  assert.match(jsx, /const coarsePointer = useMemo\(\(\) => \{\s*try \{ return window\.matchMedia\('\(pointer: coarse\)'\)\.matches; \} catch \{ return false; \}\s*\}, \[\]\);/);
  assert.match(jsx, /const readsInSheet = coarsePointer && abstractClipped === true && !expanded;/);
  assert.match(jsx, /const openAbstract = \(e\) => \{\s*if \(readsInSheet\) \{\s*e\.stopPropagation\(\);\s*setShowAbstractSheet\(true\);\s*return;\s*\}\s*toggleExpanded\(e, !expanded\);\s*\};/);
  assert.match(jsx, /className=\{`pc-abstract \$\{expanded[^`]*`\}\s*onClick=\{openAbstract\}/);
  assert.match(jsx, /className=\{`pc-abstract-toggle\$\{abstractClipped === true \|\| expanded \? '' : ' pc-abstract-toggle--reserved'\}`\}\s*aria-expanded=\{readsInSheet \? undefined : expanded\}\s*aria-haspopup=\{readsInSheet \? 'dialog' : undefined\}\s*aria-controls=\{readsInSheet \? undefined : abstractId\}\s*onClick=\{openAbstract\}/);
  assert.match(jsx, /\{showAbstractSheet && \(\s*<AbstractSheet paper=\{paper\} onClose=\{closeAbstractSheet\} \/>\s*\)\}/);
});

test('the reading sheet is a bottom drawer that arrives, scrolls inside and leaves before it unmounts', async () => {
  const jsx = stripComments(await read('./AbstractSheet.jsx'));
  assert.match(jsx, /const \{ open, requestClose \} = usePopupOpenOnMount\(\);/);
  assert.match(jsx, /onOpenChange=\{\(next\) => \{ if \(!next\) requestClose\(\); \}\}/);
  assert.match(jsx, /onOpenChangeComplete=\{\(next\) => \{ if \(!next\) onClose\(\); \}\}/);
  assert.match(jsx, /<DrawerBody className="abstract-sheet-body" data-base-ui-swipe-ignore>/);
  assert.match(jsx, /<ScientificText>\{paper\.abstract\}<\/ScientificText>/);
  assert.match(jsx, /initialFocus=\{closeRef\}/);
  const css = stripComments(await read('./AbstractSheet.css'));
  assert.match(css, /\.abstract-sheet-body p \{[^}]*font-family: var\(--font-serif\);[^}]*font-size: 1\.0625rem;[^}]*line-height: 1\.72;/);
  assert.match(css, /\.abstract-sheet-body \{[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;/);
});
```

- [x] **Step 2: `AbstractSheet.jsx`**

```jsx
import { useRef } from 'react';
import { X } from 'lucide-react';
import ScientificText from '../ScientificText';
import { useLanguage } from '../../context/LanguageContext';
import { usePopupOpenOnMount } from '../../hooks/usePopupOpenOnMount.js';
import { areaLabelForPaper } from '../../utils/areaAccent.js';
import { Drawer, DrawerBody, DrawerClose, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.jsx';
import './AbstractSheet.css';

/**
 * The abstract, read comfortably on a phone.
 *
 * On a fine pointer the card unfolds its abstract in place; on a phone the
 * column is bottom-anchored and short, the unfolded panel scrolls inside a
 * box a few lines tall, and reading it there is a thumb fight. A clipped
 * abstract opens here instead: a bottom sheet with the title and the whole
 * text, at the reader's own measure, dismissed by a swipe or the X. Mounted
 * by the card as `{showAbstractSheet && <AbstractSheet/>}`; `open` flips on
 * the frame after mount (usePopupOpenOnMount) so the drawer actually arrives.
 */
export default function AbstractSheet({ paper, onClose }) {
  const { isEnglish } = useLanguage();
  const { open, requestClose } = usePopupOpenOnMount();
  const closeRef = useRef(null);
  const authors = (paper?.authors || []).map((author) => author?.name || author).filter(Boolean);
  const authorsLine = authors.slice(0, 3).join(', ') + (authors.length > 3 ? (isEnglish ? ' et al.' : ' et al.') : '');
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => { if (!next) requestClose(); }}
      onOpenChangeComplete={(next) => { if (!next) onClose(); }}
    >
      <DrawerContent render={<section />} className="abstract-sheet" initialFocus={closeRef}>
        <DrawerHandle />
        <header className="abstract-sheet-head">
          <div className="abstract-sheet-heading">
            <span className="abstract-sheet-kicker">{areaLabelForPaper(paper, { english: isEnglish })}</span>
            <DrawerTitle render={<h3 />} className="abstract-sheet-title"><ScientificText>{paper?.title}</ScientificText></DrawerTitle>
            {authorsLine && <p className="abstract-sheet-authors">{authorsLine}</p>}
          </div>
          <DrawerClose
            ref={closeRef}
            className="abstract-sheet-close"
            aria-label={isEnglish ? 'Close' : 'Cerrar'}
          >
            <X size={18} />
          </DrawerClose>
        </header>
        <DrawerBody className="abstract-sheet-body" data-base-ui-swipe-ignore>
          <p><ScientificText>{paper.abstract}</ScientificText></p>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
```

- [x] **Step 3: `AbstractSheet.css`** — la caja de la hoja y la tipografía del lector:

```css
/* The abstract read on a phone: a bottom sheet in the reader's measure. */
.abstract-sheet {
  width: min(720px, 100%);
  overflow: hidden;
}

.abstract-sheet-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-5) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
}

.abstract-sheet-heading {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.abstract-sheet-kicker {
  font: var(--mono-label);
  letter-spacing: var(--mono-track);
  text-transform: uppercase;
  color: var(--text-secondary);
}

.abstract-sheet-title {
  margin: 0;
}

.abstract-sheet-authors {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.abstract-sheet-close {
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-card);
  color: var(--text-secondary);
  cursor: pointer;
}

/* The words, at the reader's own measure (.rd-p), scrolling inside the sheet
   so a flick that reaches the end never carries into the feed behind. */
.abstract-sheet-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: var(--space-4) var(--space-5) var(--space-6);
}

.abstract-sheet-body p {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 1.0625rem;
  line-height: 1.72;
  color: var(--text-primary);
}
```

- [x] **Step 4: `PaperCard.jsx`** — importar `AbstractSheet`; junto a `coarsePointer` (memo, como
  el lector) y `showAbstractSheet`/`closeAbstractSheet`; `readsInSheet` y `openAbstract`; el
  panel y el botón usan `openAbstract`; el botón cambia sus atributos ARIA según la ruta; la hoja
  se monta junto a las demás (`{showAbstractSheet && (<AbstractSheet paper={paper} onClose={closeAbstractSheet} />)}`).

- [x] **Step 5: tests y lint** — `node --test src/components/Feed/*.test.js`; `npx eslint` de los ficheros tocados.

---

### Task 3: verificación sobre la build

- [x] Escritorio (1440×900, invitado, `abstract-bug-probe.mjs`): pulsar un abstracto entero → el
  panel NO pasa a `pc-abstract--open` y el botón sigue reservado; pulsar uno recortado → se abre
  y dice «Show less»; pulsar otra vez → se cierra.
- [x] Móvil (390×844, `mobile: true`, táctil, `pointer: coarse` emulado; sonda nueva
  `abstract-sheet-probe.mjs`): en un abstracto recortado, tocar el panel → `.abstract-sheet` monta,
  llega desde abajo (`data-starting-style` en el primer fotograma, `translateY` → 0 en ~400 ms),
  contiene el abstracto entero, el cuerpo desplaza por dentro; el panel de la tarjeta NO se abre.
  Tocar «Read full abstract» → lo mismo. Tocar la X → sale (`data-ending-style`) y desmonta. En
  un abstracto entero, tocar → nada.
- [x] `npm test` y eslint en verde.

## Resultado (2026-09-18, build de producción, `localhost:5174`)

| Escenario | Antes | Después |
|---|---|---|
| Escritorio, abstracto ENTERO, clic en el panel | `pc-abstract--open` y el toggle reservado pasaba a «Show less» | nada cambia: `open:false`, toggle reservado y oculto |
| Escritorio, abstracto RECORTADO, clic | se abre | se abre y el toggle dice «Show less» (igual) |
| Móvil emulado (390×844, `pointer: coarse`), recortado, toque en el panel o en «Read full abstract» | se desplegaba en la tarjeta | monta `.abstract-sheet` (starting → open, translateY 719 → 0, fondo 0 → 0,4); abstracto entero (1.679 caracteres); cuerpo con scroll (1.151 > 535); foco en la X; el panel de la tarjeta sigue `open:false` |
| Móvil, la X | — | `ending` → desmontada; la tarjeta como estaba |

`npm test`: 2.843 en verde; eslint limpio.

## Añadidos a mitad de turno (mismo día, misma verificación)

Tres retoques de movimiento que el usuario pidió mientras esto se hacía, medidos con
`reader-anim-probe.mjs` (perfil de sondas con sesión: la lectura con IA de un invitado abre la
hoja de «Continue with Google») y `ai-button-motion-probe.mjs`:

- [x] **El carril de anotaciones (`Annotations.css`).** Sus transiciones eran inválidas:
  `var(--transition-slow) cubic-bezier(…)` y el token ya es `320ms ease`, así que cada línea
  llevaba dos curvas y NADA animaba (el carril aparecía en su estado final en el primer
  fotograma; la columna saltaba 176 px). Ahora `margin-right 320ms var(--ease-out-quad)`,
  `opacity 180ms linear`, `transform 320ms var(--ease-out-quad)`, `visibility 0s` con retardo
  plano de 320 ms; `transition: none` bajo movimiento reducido. Medido: el margen recorre
  0 → −352 px en 320 ms sobre la quad y el documento viaja 201 → 377 px sin saltos, ida y vuelta.
  Test de fuente + guardia sobre TODOS los `.css`: un token `--transition-*` no puede llevar
  una segunda curva.
- [x] **La tarjeta de exportar al cerrarse (`Export.css`).** Cerraba con la curva de la llegada
  (expo, 120 ms): 5,1 de sus 6 px en dos fotogramas y 90 ms de tarjeta fundiéndose quieta.
  Ahora `translate: 0 10px; scale: 0.97` con `opacity 160ms linear`, `scale/translate 200ms
  var(--ease-out-quad)` bajo `prefers-reduced-motion: no-preference`. Medido (X y Escape):
  1,6 → 3,1 → 4,5 → 5,8 → 6,8 → 7,7 → 8,4 → 8,9 → 9,4 → 9,7 → 9,9 → 10 px. Un Escape REAL
  (`Input.dispatchKeyEvent`) cierra solo la tarjeta; un `keydown` sintético en `document`
  cierra también el lector, y eso es la sonda, no la app.
- [x] **El hover de «Read in plain words» (`button-variants.js`).** Un solo reloj
  (`duration-[180ms] ease-expo`) para todo. Ahora cada propiedad con el suyo: colores 160 ms
  lineal; elevación 180 ms expo a la ida y 220 ms quad a la vuelta; pulsación 120 ms expo;
  sombra `--shadow-md` al elevarse y ninguna al pulsar; el icono gira 8° y crece 1,1 con la
  elevación. Medido: −1,71 px a los 60 ms (llega donde mira el ojo), −2 px en reposo; la vuelta
  1,44 → 0,72 → 0,40 → 0,12 → 0 px por 40 ms; movimiento reducido: colores sí, sin
  elevación, sin escala, sin giro.
