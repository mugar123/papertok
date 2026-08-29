# Vídeo de presentación de PaperTok — plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: usa `superpowers:subagent-driven-development`
> (recomendada) o `superpowers:executing-plans` para ejecutar este plan tarea a tarea.
> Los pasos usan casillas (`- [ ]`) para seguimiento.

**Objetivo:** producir `papertok-promo.mp4`, 1920×1080 a 60 fps, ~82 s, para publicar en
X y LinkedIn.

**Arquitectura:** proyecto Remotion aislado en `video/`, con su propio `package.json`.
El vídeo es híbrido: capturas PNG de la app real como base, y encima componentes React
que aportan el movimiento (texto escribiéndose, swipes, encuadres). El guion vive como
datos en un único fichero, de modo que textos y tiempos se cambian sin tocar escenas.

**Stack:** Remotion 4.x, React, TypeScript, `@remotion/google-fonts`, ffmpeg (ya
presente en el sistema), Chrome por CDP para las capturas.

**Spec:** `docs/superpowers/specs/2026-08-29-video-presentacion-design.md` — léelo
entero antes de la Tarea 1. El plan argumenta desde él.

---

## Para quién es este plan

Lo ejecuta un agente que **no ha participado en el diseño** y probablemente no conoce
PaperTok. Todo lo necesario está aquí o en el spec. No hay contexto tácito.

### Modelo y esfuerzo recomendados (si el agente es Claude Code)

| Tarea | Modelo | Esfuerzo | Por qué |
|---|---|---|---|
| 1, 2, 3 | Sonnet 5 | medio | Scaffolding y datos. Mecánico y verificable. |
| 4, 5, 7 | Sonnet 5 | medio | Componentes pequeños con test propio. |
| 6 | Opus 5 | alto | Capturar exige navegar una app viva y juzgar encuadres. |
| 8 | Opus 5 | alto | El zoom con cruce a vectorial es la parte frágil del vídeo. |
| 9 | Opus 5 | alto | Cinco escenas donde el criterio visual decide el resultado. |
| 10, 11 | Sonnet 5 | medio | Montaje y render. |

Si el agente no es Claude Code, ignora esta tabla; el resto del plan no depende de ella.

### Sobre Claude Design

**No es necesario y no está en la ruta crítica.** Las cartelas son texto puro y se
iteran más rápido en Remotion Studio, que recarga en caliente.

Hay **un solo uso que lo justifica**, y es opcional: después de la Tarea 5 y antes de la
9, montar una lámina con los siete fotogramas clave (una cartela y seis composiciones de
escena) para que el propietario apruebe el aspecto **antes** de escribir cinco escenas.
Si se aprueba el look sobre una lámina, se evita rehacer escenas ya montadas. Si el
propietario prefiere revisar directamente en Remotion Studio, sáltatelo.

### Dependencias humanas — resolver ANTES de la Tarea 6

Estas no las puede resolver el agente. Bloquean la captura, no el arranque:

1. **Cuenta en PaperTok con datos.** El feed, el lector, las listas y `/research`
   requieren sesión iniciada, y una cuenta recién creada muestra pantallas vacías que no
   sirven para un promocional. Hace falta una cuenta con historial de lectura y al menos
   una lista con varios papers.
2. **Quién se autentica.** El agente **no debe pedir ni manejar credenciales**. El
   propietario abre el Chrome de captura y se autentica él; a partir de ahí el agente
   navega y dispara.
3. **Alternativa si eso no es posible:** que el propietario entregue los PNG ya
   capturados en `video/public/shots/`, con los nombres exactos de la Tarea 6. El plan
   sigue funcionando: la Tarea 6 pasa a ser una verificación de que los ficheros existen
   y tienen la resolución mínima.

---

## Restricciones globales

Valores exactos. No los reinterpretes ni los "mejores".

- **Resolución y cadencia:** 1920×1080, 60 fps. Duración objetivo 82 s = **4920
  fotogramas**.
- **Idioma de todo el texto en pantalla:** inglés.
- **Audio:** ninguno. El montaje no debe depender de una pista.
- **Tipografías:** `Inter` para cartelas e interfaz; `Newsreader` para la apertura de
  arXiv. Ambas por `@remotion/google-fonts`, nunca por enlace de red en tiempo de render.
- **Colores:** tinta `#111318`; palabra destacada `#1a5fd0`; fondo de cartela `#fafaf8`.
- **Tratamiento de cartela:** Inter peso 700, `letter-spacing: -0.02em`, centrada, dos
  líneas como máximo, texto escribiéndose letra a letra.
- **Aislamiento:** nada de lo que se cree aquí puede afectar al build, los tests ni el
  despliegue de PaperTok. `video/` tiene su propio `package.json`.
- **arXiv es marca de terceros.** El texto no debe insinuar respaldo ni menosprecio.
- **Verifica la API de Remotion contra <https://remotion.dev> antes de asumirla.** El
  código de este plan está escrito contra Remotion 4.x; si la versión instalada difiere,
  manda la documentación, no este fichero.

---

## Mapa de ficheros

| Fichero | Responsabilidad |
|---|---|
| `video/package.json` | Dependencias de Remotion, aisladas del raíz |
| `video/src/Root.tsx` | Registra la composición y ensambla las escenas en serie |
| `video/src/script.ts` | Guion: textos y duraciones. Fuente única de la verdad |
| `video/src/script.test.ts` | Verifica que las duraciones cuadran y no se solapan |
| `video/src/theme.ts` | Colores y familias tipográficas |
| `video/src/components/Typewriter.tsx` | Revela texto letra a letra según el fotograma |
| `video/src/components/Screenshot.tsx` | Captura con sombra y encuadre animado |
| `video/src/scenes/ArxivOpen.tsx` | Apertura: listado de arXiv y las dos frases |
| `video/src/scenes/LogoZoom.tsx` | Zoom al logotipo con cruce a vectorial y negro |
| `video/src/scenes/TitleCard.tsx` | Cartela reutilizable, parametrizada por el guion |
| `video/src/scenes/FeedSwipe.tsx` | Escena 2 |
| `video/src/scenes/ReaderAnnotate.tsx` | Escena 3 |
| `video/src/scenes/ListsSave.tsx` | Escena 4 |
| `video/src/scenes/ExplorerThread.tsx` | Escena 5 |
| `video/src/scenes/ResearchReport.tsx` | Escena 6 |
| `video/src/scenes/Outro.tsx` | Cierre con logo |
| `video/public/shots/*.png` | Capturas |
| `eslint.config.js` (raíz) | Modificar: ignorar `video/` |
| `.gitignore` (raíz) | Modificar: ignorar `video/out/` y `video/node_modules/` |

---

## El guion, íntegro

El agente lo necesita literal. Textos en inglés; la palabra entre `**` va en `#1a5fd0`.

**Apertura (0:00–0:09).** Captura fija del listado de arXiv. Texto en Newsreader, abajo
a la izquierda, dos frases que se escriben con una pausa entre ellas:

1. `This is where science gets published.`
2. `It's just not where anyone reads it.`

**Corte (0:09–0:13).** Zoom continuo al logotipo `arXiv` hasta que el trazo de la X
llena el cuadro. Negro. Medio segundo de silencio.

**Cartelas y escenas:**

| # | Cartela | Escena siguiente |
|---|---|---|
| 1 | `Introducing **PaperTok**` | Ninguna: el negro se abre a blanco |
| 2 | `Science, one **swipe** at a time` | Feed vertical |
| 3 | `Read it like it was **written for you**` | Lector con anotación y respuesta IA |
| 4 | `Keep what **matters**` | Guardar en lista y rejilla de listas |
| 5 | `Follow the **thread**` | Explorador: autor → conceptos → citas |
| 6 | `A week of reading, **one report**` | `/research`: filtros, mapa, informe |
| 7 | `Put science back in your **feed**` | Logo sobre blanco. Fin |

---

## Tarea 1: Proyecto aislado que renderiza algo

**Ficheros:**
- Crear: `video/package.json`, `video/remotion.config.ts`, `video/src/Root.tsx`,
  `video/src/index.ts`, `video/tsconfig.json`, `video/.gitignore`
- Modificar: `eslint.config.js` (raíz), `.gitignore` (raíz)

**Interfaces:**
- Produce: una composición registrada con id `Promo`, 1920×1080, 60 fps, 4920 fotogramas.
  Todas las tareas siguientes renderizan dentro de ella.

- [ ] **Paso 1: crear el proyecto Remotion dentro de `video/`**

```bash
cd /ruta/al/repo/papertok
mkdir -p video && cd video
npm init -y
npm i remotion @remotion/cli react react-dom
npm i -D typescript @types/react @types/react-dom
```

- [ ] **Paso 2: comprobar que el raíz no se ha contaminado**

```bash
cd /ruta/al/repo/papertok
git status --short package.json package-lock.json
```

Esperado: **sin salida**. Si aparecen modificados, has instalado en el sitio equivocado:
revierte con `git checkout package.json package-lock.json` y repite el Paso 1 dentro de
`video/`.

- [ ] **Paso 3: registrar la composición**

`video/src/Root.tsx`:

```tsx
import { Composition } from "remotion";
import { Promo } from "./Promo";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Promo"
    component={Promo}
    durationInFrames={4920}
    fps={60}
    width={1920}
    height={1080}
  />
);
```

`video/src/Promo.tsx` (provisional, se sustituye en la Tarea 10):

```tsx
import { AbsoluteFill } from "remotion";

export const Promo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#fafaf8" }} />
);
```

`video/src/index.ts`:

```ts
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
```

- [ ] **Paso 4: excluir `video/` del lint del proyecto principal**

En `eslint.config.js` del raíz, añade `video/**` a la lista de rutas ignoradas,
siguiendo la forma que ya use ese fichero para otras exclusiones.

- [ ] **Paso 5: ignorar lo pesado**

Añade al `.gitignore` del raíz:

```
video/node_modules/
video/out/
```

- [ ] **Paso 6: verificar que el proyecto principal sigue intacto**

```bash
cd /ruta/al/repo/papertok
npm run lint && npm test
```

Esperado: ambos pasan. Si `lint` recorre `video/`, el Paso 4 no funcionó: arréglalo antes
de continuar.

- [ ] **Paso 7: renderizar un fotograma de humo**

```bash
cd video && npx remotion still Promo out/smoke.png --frame=0
```

Esperado: se crea `out/smoke.png`, 1920×1080, liso en `#fafaf8`. **Ábrelo y míralo.**
Si el render falla aquí, ninguna tarea posterior funcionará.

- [ ] **Paso 8: commit**

```bash
git add video/ eslint.config.js .gitignore
git commit -m "feat(video): proyecto Remotion aislado que ya renderiza"
```

---

## Tarea 2: El guion como datos, con sus tiempos verificados

Esta es la única tarea con test automático de verdad, y es la que evita el error más caro
del proyecto: descubrir al final que las escenas suman una duración distinta de la
composición y todo va desincronizado.

**Ficheros:**
- Crear: `video/src/script.ts`, `video/src/script.test.ts`
- Modificar: `video/package.json` (script `test`)

**Interfaces:**
- Produce:
  - `type Block = { id: string; kind: "arxiv" | "zoom" | "card" | "scene" | "outro"; durationInFrames: number; text?: string; highlight?: string; shot?: string }`
  - `export const SCRIPT: Block[]`
  - `export const TOTAL_FRAMES: number`
  - `export const startFrameOf: (id: string) => number`

- [ ] **Paso 1: escribir el test que falla**

`video/src/script.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCRIPT, TOTAL_FRAMES, startFrameOf } from "./script";

test("la suma de bloques es exactamente la duración de la composición", () => {
  const sum = SCRIPT.reduce((n, b) => n + b.durationInFrames, 0);
  assert.equal(sum, 4920);
  assert.equal(TOTAL_FRAMES, 4920);
});

test("ningún bloque dura cero o menos", () => {
  for (const b of SCRIPT) {
    assert.ok(b.durationInFrames > 0, `${b.id} dura ${b.durationInFrames}`);
  }
});

test("los identificadores no se repiten", () => {
  const ids = SCRIPT.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("toda cartela lleva texto, y su palabra destacada aparece en el texto", () => {
  for (const b of SCRIPT.filter((b) => b.kind === "card")) {
    assert.ok(b.text, `${b.id} sin texto`);
    assert.ok(b.highlight, `${b.id} sin palabra destacada`);
    assert.ok(
      b.text!.includes(b.highlight!),
      `${b.id}: "${b.highlight}" no aparece en "${b.text}"`
    );
  }
});

test("startFrameOf devuelve el acumulado y 0 para el primero", () => {
  assert.equal(startFrameOf(SCRIPT[0].id), 0);
  assert.equal(
    startFrameOf(SCRIPT[1].id),
    SCRIPT[0].durationInFrames
  );
});
```

- [ ] **Paso 2: ejecutarlo y ver que falla**

Añade a `video/package.json`:

```json
"scripts": { "test": "node --test --experimental-strip-types src/*.test.ts" }
```

```bash
cd video && npm test
```

Esperado: FALLA porque `./script` no existe.

> Nota: si tu versión de Node no admite `--experimental-strip-types`, compila con
> `tsc` antes de testear o usa `tsx`. No cambies el contenido de los tests para
> sortear el problema.

- [ ] **Paso 3: escribir el guion**

`video/src/script.ts`. Los tiempos siguen la estructura del spec: apertura larga y fija,
corte breve, cartelas de ~2 s y escenas de ~7 s.

```ts
export type Block = {
  id: string;
  kind: "arxiv" | "zoom" | "card" | "scene" | "outro";
  durationInFrames: number;
  text?: string;
  highlight?: string;
  shot?: string;
};

export const SCRIPT: Block[] = [
  { id: "arxiv", kind: "arxiv", durationInFrames: 540 },
  { id: "zoom", kind: "zoom", durationInFrames: 240 },

  { id: "card1", kind: "card", durationInFrames: 180,
    text: "Introducing PaperTok", highlight: "PaperTok" },

  { id: "card2", kind: "card", durationInFrames: 150,
    text: "Science, one swipe at a time", highlight: "swipe" },
  { id: "feed", kind: "scene", durationInFrames: 420, shot: "feed" },

  { id: "card3", kind: "card", durationInFrames: 150,
    text: "Read it like it was written for you", highlight: "written for you" },
  { id: "reader", kind: "scene", durationInFrames: 480, shot: "reader" },

  { id: "card4", kind: "card", durationInFrames: 150,
    text: "Keep what matters", highlight: "matters" },
  { id: "lists", kind: "scene", durationInFrames: 390, shot: "lists" },

  { id: "card5", kind: "card", durationInFrames: 150,
    text: "Follow the thread", highlight: "thread" },
  { id: "explorer", kind: "scene", durationInFrames: 420, shot: "explorer" },

  { id: "card6", kind: "card", durationInFrames: 150,
    text: "A week of reading, one report", highlight: "one report" },
  { id: "research", kind: "scene", durationInFrames: 540, shot: "research" },

  { id: "card7", kind: "card", durationInFrames: 180,
    text: "Put science back in your feed", highlight: "feed" },
  { id: "outro", kind: "outro", durationInFrames: 780 },
];

export const TOTAL_FRAMES = SCRIPT.reduce(
  (n, b) => n + b.durationInFrames,
  0
);

export const startFrameOf = (id: string): number => {
  let acc = 0;
  for (const b of SCRIPT) {
    if (b.id === id) return acc;
    acc += b.durationInFrames;
  }
  throw new Error(`Bloque desconocido: ${id}`);
};
```

- [ ] **Paso 4: ejecutar los tests**

```bash
cd video && npm test
```

Esperado: PASAN los cinco. **Si el primero falla, ajusta las duraciones del guion hasta
que sumen 4920 — no toques el test ni el `durationInFrames` de la composición.** Esa
igualdad es la que mantiene el vídeo coherente.

- [ ] **Paso 5: commit**

```bash
git add video/src/script.ts video/src/script.test.ts video/package.json
git commit -m "feat(video): el guion como datos, con sus tiempos verificados"
```

---

## Tarea 3: Tema y tipografías empaquetadas

**Ficheros:**
- Crear: `video/src/theme.ts`

**Interfaces:**
- Produce: `export const THEME: { ink: string; accent: string; paper: string; sans: string; serif: string }`

- [ ] **Paso 1: instalar las fuentes**

```bash
cd video && npm i @remotion/google-fonts
```

- [ ] **Paso 2: escribir el tema**

`video/src/theme.ts`:

```ts
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadNewsreader } from "@remotion/google-fonts/Newsreader";

const inter = loadInter();
const newsreader = loadNewsreader();

export const THEME = {
  ink: "#111318",
  accent: "#1a5fd0",
  paper: "#fafaf8",
  sans: inter.fontFamily,
  serif: newsreader.fontFamily,
};
```

- [ ] **Paso 3: verificar que las fuentes se aplican de verdad**

Cambia temporalmente `video/src/Promo.tsx` para pintar `Inter 700` a 120px sobre el
fondo, renderiza `npx remotion still Promo out/font.png --frame=0` y **mira el PNG**.
Si sale una tipografía del sistema en lugar de Inter, la carga no funcionó: revisa la
documentación de `@remotion/google-fonts` para la versión instalada antes de seguir.

- [ ] **Paso 4: commit**

```bash
git add video/src/theme.ts video/package.json
git commit -m "feat(video): tema y tipografías empaquetadas"
```

---

## Tarea 4: Componente Typewriter

Es el componente más reutilizado del vídeo: cartelas, frases de arXiv y respuesta de la
IA en el lector.

**Ficheros:**
- Crear: `video/src/components/Typewriter.tsx`, `video/src/components/typewriter.test.ts`

**Interfaces:**
- Consume: nada.
- Produce:
  - `export const charsVisible: (frame: number, total: number, charsPerFrame: number, delay: number) => number`
  - `export const Typewriter: React.FC<{ text: string; charsPerFrame?: number; delay?: number; style?: React.CSSProperties; highlight?: string; highlightColor?: string }>`

- [ ] **Paso 1: escribir el test que falla**

`video/src/components/typewriter.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { charsVisible } from "./Typewriter";

test("antes del retardo no se ve nada", () => {
  assert.equal(charsVisible(5, 20, 1, 30), 0);
});

test("en el fotograma del retardo empieza en cero", () => {
  assert.equal(charsVisible(30, 20, 1, 30), 0);
});

test("avanza al ritmo indicado", () => {
  assert.equal(charsVisible(40, 20, 1, 30), 10);
  assert.equal(charsVisible(40, 20, 2, 30), 20);
});

test("nunca pasa del total", () => {
  assert.equal(charsVisible(9999, 20, 1, 30), 20);
});

test("no devuelve fracciones", () => {
  assert.equal(charsVisible(35, 20, 0.5, 30), 2);
});
```

- [ ] **Paso 2: ejecutarlo y ver que falla**

```bash
cd video && npm test
```

Esperado: FALLA, `charsVisible` no existe.

- [ ] **Paso 3: implementar**

`video/src/components/Typewriter.tsx`:

```tsx
import React from "react";
import { useCurrentFrame } from "remotion";
import { THEME } from "../theme";

export const charsVisible = (
  frame: number,
  total: number,
  charsPerFrame: number,
  delay: number
): number => {
  if (frame < delay) return 0;
  return Math.min(total, Math.floor((frame - delay) * charsPerFrame));
};

export const Typewriter: React.FC<{
  text: string;
  charsPerFrame?: number;
  delay?: number;
  style?: React.CSSProperties;
  highlight?: string;
  highlightColor?: string;
}> = ({
  text,
  charsPerFrame = 1.6,
  delay = 0,
  style,
  highlight,
  highlightColor = THEME.accent,
}) => {
  const frame = useCurrentFrame();
  const n = charsVisible(frame, text.length, charsPerFrame, delay);
  const shown = text.slice(0, n);

  if (!highlight) return <span style={style}>{shown}</span>;

  // La palabra destacada se colorea solo en la parte ya escrita.
  const at = text.indexOf(highlight);
  const before = shown.slice(0, Math.min(n, at));
  const inside = shown.slice(Math.min(n, at), Math.min(n, at + highlight.length));
  const after = shown.slice(Math.min(n, at + highlight.length));

  return (
    <span style={style}>
      {before}
      <span style={{ color: highlightColor }}>{inside}</span>
      {after}
    </span>
  );
};
```

- [ ] **Paso 4: ejecutar los tests**

```bash
cd video && npm test
```

Esperado: PASAN los cinco de `typewriter`, y siguen pasando los de `script`.

- [ ] **Paso 5: commit**

```bash
git add video/src/components/
git commit -m "feat(video): componente Typewriter con su revelado verificado"
```

---

## Tarea 5: Cartela reutilizable

**Ficheros:**
- Crear: `video/src/scenes/TitleCard.tsx`
- Modificar: `video/src/Promo.tsx` (temporalmente, para verla)

**Interfaces:**
- Consume: `Typewriter`, `THEME`, el tipo `Block`.
- Produce: `export const TitleCard: React.FC<{ text: string; highlight: string }>`

- [ ] **Paso 1: implementar**

`video/src/scenes/TitleCard.tsx`:

```tsx
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Typewriter } from "../components/Typewriter";
import { THEME } from "../theme";

export const TitleCard: React.FC<{ text: string; highlight: string }> = ({
  text,
  highlight,
}) => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: THEME.paper,
        justifyContent: "center",
        alignItems: "center",
        opacity: fade,
      }}
    >
      <div
        style={{
          fontFamily: THEME.sans,
          fontWeight: 700,
          fontSize: 96,
          letterSpacing: "-0.02em",
          lineHeight: 1.15,
          color: THEME.ink,
          textAlign: "center",
          maxWidth: 1400,
        }}
      >
        <Typewriter text={text} highlight={highlight} />
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Paso 2: verla renderizada**

Apunta `Promo.tsx` temporalmente a
`<TitleCard text="Introducing PaperTok" highlight="PaperTok" />` y saca dos fotogramas:

```bash
cd video
npx remotion still Promo out/card-half.png --frame=12
npx remotion still Promo out/card-full.png --frame=120
```

**Abre los dos PNG y míralos.** Criterios de aceptación:
- `card-half.png` muestra el texto **cortado a media palabra** — así se comprueba que el
  typewriter funciona.
- `card-full.png` muestra la frase completa, con `PaperTok` en azul `#1a5fd0` y el resto
  en `#111318`.
- El texto cabe en una o dos líneas y no toca los bordes.

Si el texto se sale, baja `fontSize` a 84 antes de seguir; no lo dejes desbordado.

- [ ] **Paso 3: commit**

```bash
git add video/src/scenes/TitleCard.tsx video/src/Promo.tsx
git commit -m "feat(video): cartela tipográfica reutilizable"
```

---

## Tarea 6: Capturas

**Requisito previo:** la sección «Dependencias humanas» debe estar resuelta. **No pidas
credenciales a nadie.** Si la sesión no está iniciada, detente y dilo.

**Ficheros:**
- Crear: `video/public/shots/*.png`, `video/scripts/capture.md` (registro de lo capturado)

**Interfaces:**
- Produce: los PNG con estos nombres exactos, que las Tareas 8 y 9 consumen por
  `staticFile("shots/<nombre>.png")`.

| Nombre | Contenido | Nota |
|---|---|---|
| `arxiv-list.png` | Listado de arXiv | Escala 4×, es la que sufre el zoom |
| `feed-a.png` | Tarjeta de paper en el feed | |
| `feed-b.png` | La tarjeta siguiente | Para el swipe |
| `reader-clean.png` | Lector con el paper **sin** respuesta IA | La respuesta se escribe encima |
| `lists-modal.png` | Modal de guardar en lista | |
| `lists-grid.png` | Rejilla de listas | |
| `explorer-author.png` | Entidad de autor | |
| `explorer-concepts.png` | Conceptos relacionados | |
| `research-report.png` | Informe de `/research` con el mapa mundial | |

- [ ] **Paso 1: arrancar Chrome con depuración remota**

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9223 \
  --user-data-dir=/tmp/papertok-capture-profile
```

- [ ] **Paso 2: que el propietario inicie sesión**

En esa ventana, abrir <https://mugar123.github.io/papertok/#/> e iniciar sesión.
**Lo hace una persona, no el agente.** Espera confirmación antes de continuar.

- [ ] **Paso 3: capturar arXiv a escala alta**

La app usa HashRouter: para navegar dentro de PaperTok, cambia el hash y **recarga**;
un cambio de hash sin recarga puede no montar la ruta.

Para `arxiv-list.png` usa `deviceScaleFactor: 4` — es la única captura que se amplía
~40× en el zoom, y a escala normal se pixela. Verifica el resultado:

```bash
sips -g pixelWidth -g pixelHeight video/public/shots/arxiv-list.png
```

Esperado: anchura **≥ 5000 px**. Si sale ~1280, la escala no se aplicó: corrígelo ahora,
porque la Tarea 8 depende de ello.

- [ ] **Paso 4: capturar las ocho pantallas de PaperTok**

`deviceScaleFactor: 2` basta. Criterios para cada una:
- Sin banner de consentimiento de analítica visible.
- Sin estados de carga ni esqueletos.
- Sin datos personales reales: nombre de usuario y correo del propietario no deben
  aparecer legibles. Si aparecen, recorta o usa una cuenta de demostración.
- `reader-clean.png` **sin** respuesta de la IA en pantalla.

- [ ] **Paso 5: registrar lo capturado**

Escribe `video/scripts/capture.md` con, por cada PNG: la URL exacta, el
`deviceScaleFactor`, la fecha y las dimensiones. Cuando dentro de seis meses haya que
regenerarlas, este fichero es lo único que lo hará posible sin adivinar.

- [ ] **Paso 6: mirar las nueve capturas**

Ábrelas una a una. Es verificación, no trámite: un esqueleto de carga colado en una
captura no lo detecta ningún test.

- [ ] **Paso 7: commit**

```bash
git add video/public/shots/ video/scripts/capture.md
git commit -m "feat(video): capturas de arXiv y de la app"
```

---

## Tarea 7: Componente Screenshot

**Ficheros:**
- Crear: `video/src/components/Screenshot.tsx`

**Interfaces:**
- Consume: `staticFile` de Remotion, `THEME`.
- Produce: `export const Screenshot: React.FC<{ src: string; scale?: number; x?: number; y?: number; radius?: number }>`

- [ ] **Paso 1: implementar**

```tsx
import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";

export const Screenshot: React.FC<{
  src: string;
  scale?: number;
  x?: number;
  y?: number;
  radius?: number;
}> = ({ src, scale = 1, x = 0, y = 0, radius = 16 }) => (
  <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
    <Img
      src={staticFile(`shots/${src}`)}
      style={{
        width: 1400,
        borderRadius: radius,
        boxShadow: "0 40px 120px rgba(17,19,24,0.18)",
        transform: `translate(${x}px, ${y}px) scale(${scale})`,
      }}
    />
  </AbsoluteFill>
);
```

- [ ] **Paso 2: verificar con un fotograma**

Apunta `Promo.tsx` a `<Screenshot src="feed-a.png" />`, renderiza el fotograma 0 y
**míralo**. La captura debe salir centrada, con sombra, sin deformarse ni pixelarse.

- [ ] **Paso 3: commit**

```bash
git add video/src/components/Screenshot.tsx video/src/Promo.tsx
git commit -m "feat(video): componente de captura con sombra y encuadre"
```

---

## Tarea 8: Apertura y zoom — la parte frágil

**Hazla antes que las escenas de producto.** Es lo único del vídeo que puede resultar
imposible tal como está diseñado, y conviene descubrirlo con cinco escenas sin escribir,
no con cinco escenas hechas.

**Ficheros:**
- Crear: `video/src/scenes/ArxivOpen.tsx`, `video/src/scenes/LogoZoom.tsx`,
  `video/src/assets/arxiv-wordmark.tsx`

**Interfaces:**
- Consume: `Typewriter`, `Screenshot`, `THEME`, `arxiv-list.png`.
- Produce: `export const ArxivOpen: React.FC`, `export const LogoZoom: React.FC`.

- [ ] **Paso 1: la apertura**

`ArxivOpen.tsx`: la captura fija a pantalla completa, y sobre ella, abajo a la izquierda,
las dos frases en Newsreader (48 px, `THEME.ink`, sobre una banda `#fafaf8` con algo de
transparencia para que se lean). La primera con `delay: 60`; la segunda con `delay: 260`,
para que quede la pausa entre ellas.

```tsx
<Typewriter
  text="This is where science gets published."
  delay={60}
  style={{ fontFamily: THEME.serif, fontSize: 48, color: THEME.ink }}
/>
```

- [ ] **Paso 2: el zoom, y la comprobación que decide el diseño**

`LogoZoom.tsx` interpola la escala de la captura de 1 a ~40 centrada en el logotipo, y
al llegar al negro funde a `#000`.

Antes de refinar nada, **renderiza el fotograma más ampliado y míralo**:

```bash
cd video && npx remotion still Promo out/zoom-peak.png --frame=200
```

- Si se ve **nítido**: la captura a escala 4× aguanta. Sigue con la interpolación
  simple y sáltate el Paso 3.
- Si se ve **pixelado**: haz el Paso 3.

- [ ] **Paso 3: cruce a vectorial (solo si el Paso 2 salió pixelado)**

Crea `video/src/assets/arxiv-wordmark.tsx` con el logotipo `arXiv` como SVG (texto
convertido a trazado, o un `<text>` con una serif similar). En `LogoZoom`, funde de la
captura al SVG en el tramo donde el encuadre ya solo muestra el logotipo — con el
encuadre tan cerrado el cambio no se percibe — y continúa el zoom sobre el vector, que
no se degrada a ninguna escala.

Vuelve a renderizar `zoom-peak.png` y míralo. Repite hasta que esté nítido.

- [ ] **Paso 4: verificar el arco completo**

```bash
cd video
for f in 0 60 300 540 660 760; do
  npx remotion still Promo out/open-$f.png --frame=$f
done
```

Míralos en orden. Debe leerse: captura fija → primera frase → segunda frase → el zoom
arranca → trazo negro llenando → negro pleno.

- [ ] **Paso 5: commit**

```bash
git add video/src/scenes/ArxivOpen.tsx video/src/scenes/LogoZoom.tsx video/src/assets/
git commit -m "feat(video): apertura de arXiv y zoom al negro"
```

---

## Tarea 9: Las cinco escenas de producto

Cada escena es independiente: **haz una entera, verifícala y commitea antes de empezar la
siguiente.** Todas comparten la misma forma — `Screenshot` de fondo, movimiento encima —
así que si la primera queda bien, las otras cuatro son variaciones.

**Ficheros:** `video/src/scenes/FeedSwipe.tsx`, `ReaderAnnotate.tsx`, `ListsSave.tsx`,
`ExplorerThread.tsx`, `ResearchReport.tsx`

**Interfaces:** cada una exporta un `React.FC` sin props. Consumen `Screenshot`,
`Typewriter`, `THEME` y los PNG de la Tarea 6.

- [ ] **Paso 1: FeedSwipe (420 fotogramas)**

`feed-a.png` visible; a partir del fotograma 150, ambas capturas se desplazan hacia
arriba con `spring()` hasta que `feed-b.png` ocupa el centro. Un solo swipe, sin prisa.

```tsx
const progress = spring({ frame: frame - 150, fps, config: { damping: 200 } });
const shift = interpolate(progress, [0, 1], [0, -900]);
```

- [ ] **Paso 2: verificar FeedSwipe**

Renderiza los fotogramas 0, 150, 200, 260 y 400 y míralos. Debe verse la primera tarjeta,
el arranque del movimiento, el punto intermedio y la segunda ya asentada. Si el
movimiento parece brusco, sube `damping`; si parece muerto, bájalo.

- [ ] **Paso 3: commit de FeedSwipe**

```bash
git add video/src/scenes/FeedSwipe.tsx
git commit -m "feat(video): escena del feed"
```

- [ ] **Paso 4: ReaderAnnotate (480 fotogramas)**

`reader-clean.png` de fondo. Encima, en tres tiempos:
1. Fotograma 60: aparece un rectángulo de selección semitransparente
   (`rgba(26,95,208,0.18)`) sobre un párrafo.
2. Fotograma 150: entra un panel blanco con sombra a la derecha.
3. Fotograma 200: dentro del panel, un `Typewriter` escribe una respuesta corta, en Inter
   16 px, del estilo de las que da la app.

**Este es el plano donde más se nota el truco del vídeo:** la respuesta es texto real
escribiéndose, no un PNG. Por eso `reader-clean.png` se capturó sin ella.

- [ ] **Paso 5: verificar ReaderAnnotate**

Fotogramas 0, 60, 150, 230 y 470. Comprueba que en el 230 el texto está **a medio
escribir**. Si ya está completo, baja `charsPerFrame`.

- [ ] **Paso 6: commit**

```bash
git add video/src/scenes/ReaderAnnotate.tsx
git commit -m "feat(video): escena del lector"
```

- [ ] **Paso 7: ListsSave (390 fotogramas)**

`lists-modal.png` entra con una escala de 0.96 a 1 y opacidad de 0 a 1 en 20 fotogramas.
En el 200, corte a `lists-grid.png` con la misma entrada. Verifica los fotogramas 0, 20,
200, 220 y 380. Commit.

- [ ] **Paso 8: ExplorerThread (420 fotogramas)**

`explorer-author.png` con un paneo lento (`translateX` de 0 a -120 px a lo largo de toda
la escena, que insinúa recorrido sin marear). En el fotograma 220, cruce por opacidad a
`explorer-concepts.png`. Verifica 0, 210, 240 y 410, y commitea con
`git commit -m "feat(video): escena del explorador"`.

- [ ] **Paso 9: ResearchReport (540 fotogramas)**

La escena más larga y la única que puede crecer si el vídeo sabe corto.
`research-report.png` aparece por bandas horizontales: divide la captura en tres franjas
con `clipPath` y revélalas en los fotogramas 40, 120 y 200. Deja el mapa mundial visible
sin tapar durante los últimos 200 fotogramas. Verifica 0, 60, 140, 220 y 530, y commitea con
`git commit -m "feat(video): escena del informe"`.

- [ ] **Paso 10: Outro (780 fotogramas)**

`video/src/scenes/Outro.tsx`. Fondo `THEME.paper`, el logotipo de PaperTok centrado
entrando con opacidad de 0 a 1 en 20 fotogramas y una escala de 0.94 a 1.

El logotipo sale del repositorio, no lo inventes:
`public/icons/icon-512.png` es el icono de la app; `public/favicon.svg` es la versión
vectorial y es la preferible por nitidez. Cópialo a `video/public/brand/`.

```tsx
import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { THEME } from "../theme";

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  const scale = interpolate(frame, [0, 20], [0.94, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: THEME.paper,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Img
        src={staticFile("brand/favicon.svg")}
        style={{ width: 220, opacity: fade, transform: `scale(${scale})` }}
      />
    </AbsoluteFill>
  );
};
```

Renderiza los fotogramas 0, 20 y 700 y míralos. El logotipo debe verse nítido y
centrado, sin recortes.

```bash
cp public/favicon.svg video/public/brand/favicon.svg
git add video/src/scenes/Outro.tsx video/public/brand/
git commit -m "feat(video): cierre con el logotipo"
```

---

## Tarea 10: Montaje

**Ficheros:**
- Modificar: `video/src/Promo.tsx` (ahora definitivo)

**Interfaces:**
- Consume: `SCRIPT` y todas las escenas.

- [ ] **Paso 1: ensamblar desde el guion**

`Promo.tsx` recorre `SCRIPT` y monta cada bloque con `<Series.Sequence>`, eligiendo
componente por `kind` y por `id`. El montaje **no** debe llevar duraciones escritas a
mano: salen todas de `SCRIPT`, que es lo que la Tarea 2 dejó verificado.

```tsx
import { AbsoluteFill, Series } from "remotion";
import { SCRIPT } from "./script";
// ...importa las escenas

export const Promo: React.FC = () => (
  <AbsoluteFill>
    <Series>
      {SCRIPT.map((b) => (
        <Series.Sequence key={b.id} durationInFrames={b.durationInFrames}>
          {renderBlock(b)}
        </Series.Sequence>
      ))}
    </Series>
  </AbsoluteFill>
);
```

`renderBlock` es la función que traduce un bloque del guion a su componente. Va en el
mismo fichero, encima de `Promo`:

```tsx
import type { Block } from "./script";

const renderBlock = (b: Block): React.ReactNode => {
  switch (b.id) {
    case "arxiv":    return <ArxivOpen />;
    case "zoom":     return <LogoZoom />;
    case "feed":     return <FeedSwipe />;
    case "reader":   return <ReaderAnnotate />;
    case "lists":    return <ListsSave />;
    case "explorer": return <ExplorerThread />;
    case "research": return <ResearchReport />;
    case "outro":    return <Outro />;
    default:
      if (b.kind === "card") {
        return <TitleCard text={b.text!} highlight={b.highlight!} />;
      }
      throw new Error(`Bloque sin componente: ${b.id}`);
  }
};
```

El `throw` del final es deliberado: si alguien añade un bloque al guion y olvida su
escena, el render falla en voz alta en vez de dejar un hueco en negro.

- [ ] **Paso 2: comprobar que no queda hueco al final**

```bash
cd video && npx remotion still Promo out/last.png --frame=4919
```

Esperado: el cierre con el logo. **Si sale un fotograma en blanco**, las escenas no
suman la duración de la composición: vuelve al test de la Tarea 2 antes de renderizar
nada.

- [ ] **Paso 3: barrido de verificación**

```bash
cd video
for f in 0 400 700 800 1000 1500 2000 2600 3200 3800 4400 4900; do
  npx remotion still Promo out/sweep-$f.png --frame=$f
done
```

Míralos todos en orden. Es la revisión que sustituye a ver el vídeo: cada uno debe caer
en la escena que dice el guion, sin fotogramas en negro fuera del corte de arXiv.

- [ ] **Paso 4: commit**

```bash
git add video/src/Promo.tsx
git commit -m "feat(video): montaje completo desde el guion"
```

---

## Tarea 11: Render y entrega

- [ ] **Paso 1: revisión humana antes de renderizar**

Levanta el estudio y **que lo vea el propietario**:

```bash
cd video && npx remotion studio
```

El agente no puede reproducir vídeo; el ritmo solo lo juzga una persona. Espera su visto
bueno antes del render final.

- [ ] **Paso 2: render**

```bash
cd video && npx remotion render Promo out/papertok-promo.mp4 --codec=h264
```

- [ ] **Paso 3: verificar el fichero**

```bash
ffprobe -v error -show_entries format=duration \
  -show_entries stream=codec_name,width,height,r_frame_rate \
  -of default=noprint_wrappers=1 video/out/papertok-promo.mp4
```

Esperado: `h264`, `1920`, `1080`, `60/1`, duración ≈ 82 s.

- [ ] **Paso 4: preparar el fichero para publicar**

```bash
ffmpeg -i video/out/papertok-promo.mp4 -c copy -movflags +faststart \
  video/out/papertok-promo-web.mp4
```

`faststart` mueve el índice al principio, que es lo que hace que X y LinkedIn empiecen a
reproducir sin descargar el fichero entero.

- [ ] **Paso 5: extraer fotogramas de contacto para el registro**

```bash
ffmpeg -i video/out/papertok-promo-web.mp4 \
  -vf "fps=1/2,scale=480:-1,tile=5x5" -frames:v 2 video/out/sheet_%02d.png
```

Las dos láminas resumen el vídeo entero y permiten revisarlo de un vistazo. Míralas.

- [ ] **Paso 6: commit final**

El `.mp4` **no** va a git: `video/out/` está ignorado, y son decenas de MB. Entrega el
fichero al propietario por el canal que él indique.

```bash
git add video/
git commit -m "feat(video): vídeo de presentación listo para publicar"
```

---

## Notas para quien ejecute

- **Verificar es mirar los PNG.** El agente no reproduce vídeo. `remotion still` más una
  lectura atenta del fotograma es el único control de calidad real que hay aquí, y los
  pasos que dicen «míralo» no son retórica.
- **No cambies `durationInFrames` de la composición para cuadrar las escenas.** Ajusta el
  guion. La composición y la suma del guion son iguales por diseño, y ese test es lo que
  evita que el vídeo se desincronice.
- **Si una decisión visual no está en el plan, pregunta al propietario.** El eje es un
  recorrido de funciones por decisión suya, con una reserva registrada en el spec: la
  referencia funciona porque cuenta una sola historia. Si al montar notas que el vídeo se
  siente como una lista, dilo — no lo reescribas por tu cuenta.
- **Las capturas envejecen.** Son PNG congelados: cuando la app se rediseñe quedarán
  obsoletos sin que nada falle. `video/scripts/capture.md` existe para poder regenerarlas.
