# Separata — Rediseño del documento exportado (.tex y .pdf)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El documento que sale del export del resumen de IA —en los dos formatos— se compone como una separata: cabecera de identidad, título en bandera, ficha de origen, encabezado original bajo cada sección, titulillo con la sección en curso y colofón de procedencia al final.

**Architecture:** Los dos formatos ya comparten decisiones (filtrado, numeración, copys) a través de `latexExport.js`, que se ha convertido de hecho en el módulo compartido sin serlo de nombre. La tarea 1 extrae esa parte a `src/utils/exportDocument.js`; a partir de ahí `latexExport.js` es solo el emisor de LaTeX y `pdfExport.js` solo el de DOM, y ambos leen los mismos metadatos de un único `documentMeta()`. Nada del pipeline de datos cambia: `originalHeading` ya llega al cliente (`paperRewriteService.js:250`) y el lector ya lo pinta (`PaperReader.jsx:1421`).

**Tech Stack:** LaTeX (`article`, `geometry`, `titlesec`, `fancyhdr`, `soul`, `ulem`, `xcolor`), DOM + `jspdf` + `html2canvas-pro`, `node --test` sin DOM, React 19, Vite 8.

**Spec:** El lienzo de diseño en `design/export-rediseno/` — `Main.dc.html` (página 1) y `Main2.dc.html` (página 2) son la especificación visual al pixel; `Actual.dc.html` es la referencia de lo que hay hoy. Publicado en https://claude.ai/code/artifact/5399970a-d698-410d-8256-290ba07e4a57 . La sección «Decisiones ya tomadas» de abajo recoge lo que el lienzo deja dicho.

## Global Constraints

- `npm run check` debe pasar (secretos, lint, tests, build, dry-run del worker).
- Tests con `node --test` y sin DOM: solo se testea la parte pura. Lo que necesita DOM se verifica en vivo contra el dev server, como ya hace `pdfExport.js`.
- Copys en es/en, los dos, siempre. Ningún literal de interfaz en el código.
- Los dos formatos comparten filtrado, numeración y palabras. Un cambio que solo toque uno es un bug: si algo se dice en el documento, se dice desde `exportDocument.js`.
- Colores del documento fijos en hex. El fichero es papel, sea cual sea el tema de la app.
- Cuerpo del documento a 12 pt como suelo (16 px a 96 ppp). Etiquetas, notas al pie y líneas legales pueden bajar, nunca por debajo de 8,5 px.
- Sin `npm install`: no entra ninguna dependencia nueva. Los cinco paquetes LaTeX (`geometry`, `titlesec`, `fancyhdr`, `soul`, `ulem`) están en cualquier distribución y no se instalan, se declaran.
- Nada de commits fuera de los que pide cada tarea. Antes de cada `git add`, mirar el diff fichero a fichero: puede haber otra sesión tocando el árbol.

## Decisiones ya tomadas (del lienzo)

1. **El título sigue siendo el del artículo original, en su idioma.** Es lo que emite el código hoy (`paper.title`) y la reescritura no genera título propio. Traducirlo es otro encargo: un campo más en la respuesta del modelo.
2. **El aviso de procedencia deja de ser un `abstract`.** No resume el paper, advierte de algo. Pasa a ser una nota editorial con su etiqueta al margen.
3. **La marca cambia de mecanismo, no de color.** Hoy la del lector es fondo `#FFD21E` y la de la IA fondo `#F0F0F1` más un filete de tinta debajo; pasan a lavado amarillo `#FFE066` para la del lector y punteado para la de la IA.

   Con los números delante, porque aquí es fácil equivocarse: en escala de grises `#FFD21E` cae en 203 y `#F0F0F1` en 240 sobre papel 255. **Los dos FONDOS de hoy sí se confunden entre sí** —240 contra 255 es casi nada—, pero las dos MARCAS no, porque la de la IA lleva ese filete de tinta que sobrevive intacto. Lo que gana el rediseño no es distinguirlas, que ya se distinguían: es que las dos dejen de leerse como fotocopia repasada a rotulador.

   El lavado elegido, `#FFE066`, cae en 219: 36 niveles por debajo del papel, contra los 52 del amarillo de hoy. Un lavado más claro (`#FFF1BD`, que era la primera propuesta) cae en 239 y **desaparece al fotocopiar**. Si en algún momento el blanco y negro importa más que la calma en pantalla, lo que hay que tocar es esa única línea `\definecolor`.
4. **`originalHeading` se imprime.** Bajo cada título de sección, en mono y gris, como ya hace el lector en pantalla (`.rd-section-origin`, `PaperReader.css:326`).
5. **La procedencia sigue en el pie de CADA página.** No es una casilla y no se mueve al colofón: el colofón se añade, no sustituye.

## Lo que ya está compilado y mirado

El preámbulo de las tareas 3 y 4 no está razonado: está compilado con `pdflatex` (TeX Live 2025) y mirado en la página. Cuatro cosas salieron de mirarla, y las cuatro están ya incorporadas al código de este plan:

- `\dotuline` de `ulem` **sí** admite matemáticas dentro (`$E$`) y **sí** parte entre líneas. A resolución de pantalla baja parece un subrayado sólido; a resolución de impresión es punteado.
- `ulem` **debe** cargarse `[normalem]`. Sin eso redefine `\emph` como subrayado y se lleva por delante toda la cursiva del documento.
- Con babel español el primer párrafo de cada sección sale **sangrado**, que no es lo que pide el diseño. `\titlespacing*` (con asterisco) mata el sangrado tras el título, pero `\ptorig` abre párrafo nuevo y lo resucita: por eso `\ptorig` termina en `\noindent\ignorespaces`.
- `{1em}` de separación entre el número y el título de sección queda ancho con `\large\bfseries`. `{0.62em}` es lo que se parece al diseño.

## Estructura de ficheros

| Fichero | Responsabilidad después de este plan |
| --- | --- |
| `src/utils/exportDocument.js` | **Nuevo.** El documento sin formato: copys es/en, filtrado de anotaciones, numeración, nombre de fichero, y `documentMeta()` — las palabras que los dos formatos ponen en la página. |
| `src/utils/latexExport.js` | Solo el emisor de LaTeX: escapado, matemáticas, preámbulo, estilos de página, cuerpo, colofón. |
| `src/utils/pdfExport.js` | Solo el emisor de DOM: `PAGE_CSS`, bloques, paginador, rasterizado. |
| `src/components/Reader/ExportCard.jsx` + `Export.css` | La vista previa en miniatura, que tiene que dejar de dibujar el documento viejo. |

---

### Task 1: Extraer el modelo compartido a `exportDocument.js`

Refactor puro, sin cambio de comportamiento. Existe porque `pdfExport.js` importa hoy cuatro cosas de `latexExport.js` que no tienen nada de LaTeX, y todo lo que viene después de esta tarea empeora ese enredo.

**Files:**
- Create: `src/utils/exportDocument.js`
- Create: `src/utils/exportDocument.test.js`
- Modify: `src/utils/latexExport.js` (quitar lo movido, importar lo que siga usando)
- Modify: `src/utils/pdfExport.js:1-8` (importar de `exportDocument.js`)
- Modify: `src/components/Reader/PaperReader.jsx:36-41` (partir el import en dos)
- Modify: `src/utils/latexExport.test.js` (mover ahí los tests de lo movido)

**Interfaces:**
- Produces: `documentCopy(language) → COPY`, `exportFileName(paper, language, extension) → string`, `exportableAnnotations(annotations, {sections, level, language}) → Array`, `numberAnnotations(sections, annotations) → {byParagraph: Map, numbered: Array}`, `summarizeExport(annotations) → {marks, mine, ai}`. Firmas idénticas a las de hoy.
- Consumes: nada.

- [ ] **Step 1: Crear el fichero nuevo moviendo el bloque tal cual**

Mover desde `src/utils/latexExport.js` a `src/utils/exportDocument.js`, **sin tocar una línea de su cuerpo ni de sus comentarios**: la constante `COPY`, `SECTION_FALLBACK`, y las funciones `exportFileName`, `documentCopy`, `numberAnnotations`, `exportableAnnotations`, `summarizeExport`. Encabezar el fichero nuevo con:

```js
/**
 * El documento antes de tener formato.
 *
 * Lo que las dos exportaciones comparten y por lo que no pueden divergir: las
 * palabras, qué anotaciones viajan, en qué orden van numeradas y cómo se llama
 * el fichero. Vivía en `latexExport.js` porque el `.tex` fue primero; el PDF lo
 * importaba de allí y eso convertía al emisor de LaTeX en el módulo compartido
 * sin decirlo. Aquí no hay nada de LaTeX ni de DOM.
 */
```

- [ ] **Step 2: Reconectar los dos emisores**

En `src/utils/latexExport.js`, sustituir el bloque movido por el import y re-exportar `SECTION_FALLBACK` no hace falta (era local). Cabecera de imports:

```js
import { normalizeLatexText, splitLatexText } from './latex.js';
import { buildHighlightPlan } from './textHighlights.js';
import {
  documentCopy,
  exportFileName,
  exportableAnnotations,
  numberAnnotations,
} from './exportDocument.js';
```

En `src/utils/pdfExport.js`, cambiar el primer import por:

```js
import {
  documentCopy,
  exportFileName,
  exportableAnnotations,
  numberAnnotations,
} from './exportDocument.js';
```

`SECTION_FALLBACK` está duplicado hoy en los dos ficheros: dejarlo donde está en cada uno, no es lo que arregla esta tarea.

Y el consumidor que es fácil olvidar, porque no es un fichero de export: `src/components/Reader/PaperReader.jsx:36-41` importa hoy **cuatro** cosas de `latexExport.js` y tres de ellas se mudan. El import se parte en dos:

```js
import { buildLatexDocument } from '../../utils/latexExport.js';
import {
  exportFileName,
  exportableAnnotations,
  summarizeExport,
} from '../../utils/exportDocument.js';
```

Sin esto el build rompe, no los tests: `npm test` no carga el lector.

- [ ] **Step 3: Mover los tests que corresponden**

Mover de `src/utils/latexExport.test.js` a `src/utils/exportDocument.test.js` los tests de `exportFileName`, `documentCopy`, `numberAnnotations`, `exportableAnnotations` y `summarizeExport`, con su import nuevo:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  documentCopy,
  exportFileName,
  exportableAnnotations,
  numberAnnotations,
  summarizeExport,
} from './exportDocument.js';
```

En `latexExport.test.js` quedan los de escapado, matemáticas, `renderParagraph`, `authorLine` y `buildLatexDocument`; quitar de su import las funciones movidas.

- [ ] **Step 4: Verificar que no ha cambiado nada**

Run: `npm test`
Expected: PASS, con el mismo número de tests que antes del refactor (`npm test 2>&1 | grep -E '^# (tests|pass|fail)'`). Si el recuento baja, un test se ha quedado por el camino.

- [ ] **Step 5: Commit**

```bash
git add src/utils/exportDocument.js src/utils/exportDocument.test.js src/utils/latexExport.js src/utils/latexExport.test.js src/utils/pdfExport.js
git commit -m "refactor(export): el modelo compartido deja de vivir dentro del emisor de LaTeX"
```

---

### Task 2: Los copys de la separata y `documentMeta()`

**Files:**
- Modify: `src/utils/exportDocument.js`
- Test: `src/utils/exportDocument.test.js`

**Interfaces:**
- Produces: `formatExportDate(date, language) → string`; `documentMeta({paper, language, level, originalUrl, generatedAt, counts}) → { masthead, level, title, byline, source, noticeLabel, notice, provenance, runningTitle, colophon }` donde `colophon` es `{ heading, rows: Array<{key, value}> }`. Todo son cadenas ya montadas: ni el emisor de LaTeX ni el de DOM componen frases.
- Consumes: `documentCopy` (Task 1).

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('la fecha se compone en el idioma del documento', () => {
  const day = new Date(Date.UTC(2026, 8, 4));
  assert.equal(formatExportDate(day, 'es'), '4 de septiembre de 2026');
  assert.equal(formatExportDate(day, 'en'), '4 September 2026');
});

test('una fecha que no lo es no rompe el documento', () => {
  // El export no puede caerse por esto: si la fecha falta, la línea la pierde.
  assert.equal(formatExportDate(new Date('nada'), 'es'), '');
  assert.equal(formatExportDate(null, 'es'), '');
});

test('los metadatos salen montados y en los dos idiomas', () => {
  const meta = documentMeta({
    paper: { title: 'Worldline proper length correlators', authors: [{ name: 'A. Sivaramakrishnan' }] },
    language: 'es',
    level: 'university',
    originalUrl: 'https://arxiv.org/abs/2405.04331',
    generatedAt: new Date(Date.UTC(2026, 8, 4)),
    counts: { marks: 2, mine: 3, ai: 1 },
  });
  assert.equal(meta.masthead, 'PaperTok · Versión en lenguaje sencillo');
  assert.equal(meta.level, 'Nivel universitario');
  assert.equal(meta.noticeLabel, 'Aviso');
  assert.equal(meta.source, 'Artículo original: https://arxiv.org/abs/2405.04331 · 4 de septiembre de 2026');
  assert.equal(meta.runningTitle, 'Worldline proper length correlators');
  assert.equal(meta.colophon.heading, 'Procedencia');
  assert.deepEqual(meta.colophon.rows.map(row => row.key), [
    'Artículo original', 'Autoría', 'Fuente', 'Esta versión', 'Anotado con',
  ]);
  assert.equal(meta.colophon.rows.at(-1).value, '2 subrayados y 4 notas: 3 del lector, 1 de la IA');
});

test('la mitad que vale cero no se imprime', () => {
  // Un documento con notas y ningún subrayado suelto es el caso normal, y
  // «0 subrayados y 4 notas» es exactamente lo que no se puede imprimir.
  const copy = documentCopy('es');
  assert.equal(copy.annotatedWith({ marks: 0, mine: 2, ai: 2 }), '4 notas: 2 del lector, 2 de la IA');
  assert.equal(copy.annotatedWith({ marks: 3, mine: 0, ai: 0 }), '3 subrayados');
  assert.equal(copy.annotatedWith({ marks: 1, mine: 1, ai: 0 }), '1 subrayado y 1 nota: 1 del lector, 0 de la IA');
  assert.equal(copy.annotatedWith({ marks: 0, mine: 0, ai: 0 }), 'Sin subrayados ni notas');
});

test('sin enlace al original la línea de fuente no queda coja', () => {
  const meta = documentMeta({
    paper: { title: 'T', authors: [] },
    language: 'es', level: 'beginner', originalUrl: '',
    generatedAt: new Date(Date.UTC(2026, 8, 4)),
    counts: { marks: 0, mine: 0, ai: 0 },
  });
  assert.equal(meta.source, '4 de septiembre de 2026');
  assert.equal(meta.byline, '');
  assert.equal(meta.colophon.rows.find(row => row.key === 'Fuente'), undefined);
  assert.equal(meta.colophon.rows.at(-1).value, 'Sin subrayados ni notas');
});

test('en inglés cambia todo, no solo el título', () => {
  const meta = documentMeta({
    paper: { title: 'T', authors: [{ name: 'A. B.' }] },
    language: 'en', level: 'researcher', originalUrl: 'https://doi.org/10.1/x',
    generatedAt: new Date(Date.UTC(2026, 8, 4)),
    counts: { marks: 1, mine: 0, ai: 2 },
  });
  assert.equal(meta.masthead, 'PaperTok · Plain-language version');
  assert.equal(meta.level, 'Researcher level');
  assert.equal(meta.noticeLabel, 'Notice');
  assert.equal(meta.colophon.heading, 'Provenance');
  assert.equal(meta.colophon.rows.at(-1).value, '1 highlight and 2 notes: 0 yours, 2 from the AI');
});
```

- [ ] **Step 2: Correr los tests para verlos fallar**

Run: `node --test src/utils/exportDocument.test.js`
Expected: FAIL, `formatExportDate is not defined` / `documentMeta is not defined`.

- [ ] **Step 3: Ampliar `COPY` con lo que la separata dice**

Dentro de `COPY.es`, añadir junto a las claves que ya hay:

```js
    masthead: 'PaperTok · Versión en lenguaje sencillo',
    levelStamp: level => `Nivel ${level}`,
    noticeLabel: 'Aviso',
    sourcePrefix: 'Artículo original',
    colophonHeading: 'Procedencia',
    colophonKeys: {
      title: 'Artículo original',
      authors: 'Autoría',
      source: 'Fuente',
      version: 'Esta versión',
      annotated: 'Anotado con',
    },
    versionValue: (level, date) => `Lenguaje sencillo, nivel ${level} · ${date}`,
    // Ni «0 subrayados» ni «0 notas»: la mitad que vale cero no se imprime. Un
    // documento solo marcado y otro solo anotado son los dos casos normales.
    annotatedWith: ({ marks, mine, ai }) => {
      const notes = mine + ai;
      if (marks + notes === 0) return 'Sin subrayados ni notas';
      const left = marks ? `${marks} ${marks === 1 ? 'subrayado' : 'subrayados'}` : '';
      const right = notes
        ? `${notes} ${notes === 1 ? 'nota' : 'notas'}: ${mine} del lector, ${ai} de la IA`
        : '';
      return [left, right].filter(Boolean).join(' y ');
    },
```

Y en `COPY.en`:

```js
    masthead: 'PaperTok · Plain-language version',
    levelStamp: level => `${level.charAt(0).toUpperCase()}${level.slice(1)} level`,
    noticeLabel: 'Notice',
    sourcePrefix: 'Original article',
    colophonHeading: 'Provenance',
    colophonKeys: {
      title: 'Original article',
      authors: 'Authors',
      source: 'Source',
      version: 'This version',
      annotated: 'Annotated with',
    },
    versionValue: (level, date) => `Plain language, ${level} level · ${date}`,
    annotatedWith: ({ marks, mine, ai }) => {
      const notes = mine + ai;
      if (marks + notes === 0) return 'No highlights or notes';
      const left = marks ? `${marks} ${marks === 1 ? 'highlight' : 'highlights'}` : '';
      const right = notes
        ? `${notes} ${notes === 1 ? 'note' : 'notes'}: ${mine} yours, ${ai} from the AI`
        : '';
      return [left, right].filter(Boolean).join(' and ');
    },
```

`COPY.es.levelStamp('universitario')` da «Nivel universitario» porque `COPY.es.levels` ya traduce el nivel; en inglés `levels` da `beginner|university|researcher` y `levelStamp` los pone en mayúscula inicial.

- [ ] **Step 4: Implementar `formatExportDate` y `documentMeta`**

```js
/**
 * La fecha, en el idioma del documento.
 *
 * `Intl` es el único sitio donde el documento depende de la máquina que lo
 * hace. Una fecha inválida devuelve cadena vacía en vez de «Invalid Date»
 * impreso en la portada: la línea se queda sin fecha, que es mucho menos malo.
 */
export function formatExportDate(value, language = 'es') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'es-ES', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(date);
}

/** Los autores como una línea de texto: hasta `limit` nombres, luego honestidad. */
export function bylineText(paper, limit = 12) {
  const names = (Array.isArray(paper?.authors) ? paper.authors : [])
    .map(author => String(author?.name || author || '').trim())
    .filter(Boolean);
  if (names.length === 0) return '';
  const shown = names.slice(0, limit).join(', ');
  return names.length > limit ? `${shown} et al.` : shown;
}

/**
 * Todo lo que el documento dice de sí mismo, ya montado en frases.
 *
 * Es el sitio donde los dos formatos no pueden divergir: el emisor de LaTeX y
 * el de DOM reciben cadenas y las colocan, ninguno de los dos compone. Las
 * filas del colofón se omiten cuando no hay dato en vez de imprimirse vacías,
 * porque medio arXiv no trae DOI y una fila «Fuente: —» no informa de nada.
 */
export function documentMeta({
  paper, language = 'es', level = 'university', originalUrl = '',
  generatedAt = new Date(), counts = { marks: 0, mine: 0, ai: 0 },
} = {}) {
  const copy = documentCopy(language);
  const levelName = copy.levels[level] || level;
  const date = formatExportDate(generatedAt, language);
  const title = String(paper?.title || '');
  const byline = bylineText(paper);
  const url = String(originalUrl || '');

  const source = [url && `${copy.sourcePrefix}: ${url}`, date].filter(Boolean).join(' · ');

  const rows = [
    { key: copy.colophonKeys.title, value: title },
    { key: copy.colophonKeys.authors, value: byline },
    { key: copy.colophonKeys.source, value: url },
    { key: copy.colophonKeys.version, value: copy.versionValue(levelName, date) },
    { key: copy.colophonKeys.annotated, value: copy.annotatedWith(counts) },
  ].filter(row => row.value);

  return {
    masthead: copy.masthead,
    level: copy.levelStamp(levelName),
    title,
    byline,
    source,
    noticeLabel: copy.noticeLabel,
    notice: copy.abstract,
    provenance: copy.provenance,
    runningTitle: title,
    colophon: { heading: copy.colophonHeading, rows },
  };
}
```

- [ ] **Step 5: Correr los tests**

Run: `node --test src/utils/exportDocument.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/utils/exportDocument.js src/utils/exportDocument.test.js
git commit -m "feat(export): los metadatos de la separata, montados una sola vez para los dos formatos"
```

---

### Task 3: El preámbulo y los estilos de página del `.tex`

**Files:**
- Modify: `src/utils/latexExport.js` (`preamble`, `footer` → `pageStyles`)
- Test: `src/utils/latexExport.test.js`

**Interfaces:**
- Produces: `preamble(copy, hasHighlights) → string[]`, `pageStyles(meta) → string[]` (sustituye a `footer(copy, originalUrl)`).
- Consumes: `documentMeta` (Task 2).

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('el preámbulo declara los paquetes que la separata necesita', () => {
  const { source } = buildLatexDocument({ paper: PAPER, sections: SECTIONS, annotations: [] });
  assert.match(source, /\\usepackage\{titlesec\}/);
  assert.match(source, /\\usepackage\[normalem\]\{ulem\}/);
  assert.match(source, /\\usepackage\{fancyhdr\}/);
  assert.match(source, /headheight=14pt/);
});

test('ulem se carga normalem o se lleva por delante toda la cursiva', () => {
  // Sin [normalem], ulem redefine \emph como subrayado. Compilado y mirado.
  const { source } = buildLatexDocument({ paper: PAPER, sections: SECTIONS, annotations: [] });
  assert.doesNotMatch(source, /\\usepackage\{ulem\}/);
});

test('el amarillo del documento es el lavado, no el de la marca en pantalla', () => {
  const { source } = buildLatexDocument({
    paper: PAPER, sections: SECTIONS, annotations: [MARK],
  });
  assert.match(source, /\\definecolor\{ptWash\}\{HTML\}\{FFE066\}/);
  assert.doesNotMatch(source, /FFD21E/);
});

test('la primera página lleva cabecera de identidad y las demás titulillo', () => {
  const { source } = buildLatexDocument({
    paper: PAPER, sections: SECTIONS, annotations: [], originalUrl: 'https://arxiv.org/abs/2405.04331',
  });
  assert.match(source, /\\fancypagestyle\{ptfirst\}/);
  assert.match(source, /\\renewcommand\{\\sectionmark\}/);
  assert.match(source, /\\leftmark/);
});
```

Añadir arriba del fichero de test, si no está ya, la constante que usan:

```js
const MARK = {
  id: 'a1', sectionId: 's1', paragraphIndex: 0, kind: 'user',
  quote: 'Los autores calculan', note: 'Una nota.',
};
```

- [ ] **Step 2: Correr los tests para verlos fallar**

Run: `node --test src/utils/latexExport.test.js`
Expected: FAIL en los cuatro.

- [ ] **Step 3: Reescribir `preamble`**

Este preámbulo está compilado con `pdflatex` y mirado en la página, no razonado. No cambiar valores sin volver a compilar (Task 7).

```js
function preamble(copy, hasHighlights) {
  return [
    `% ${copy.generated}`,
    '\\documentclass[11pt,a4paper]{article}',
    '',
    '\\usepackage[T1]{fontenc}',
    '\\usepackage{lmodern}',
    `% ${copy.fontHint}`,
    '% \\usepackage{fontspec}',
    '% \\setmainfont{Newsreader}',
    `\\usepackage[${copy.babel}]{babel}`,
    // Márgenes de 27,5 mm: la medida cae en unos 72 caracteres a 11 pt, que es
    // medida de lectura. La de antes (28 mm con cuerpo menor) iba por 79.
    '\\usepackage[a4paper,top=22mm,bottom=20mm,left=27.5mm,right=27.5mm,'
      + 'headheight=14pt,headsep=10pt,footskip=22pt]{geometry}',
    '\\usepackage{xcolor}',
    ...(hasHighlights ? ['\\usepackage{soul}'] : []),
    // `normalem` no es opcional: sin él ulem redefine \emph como subrayado y
    // toda la cursiva del documento —incluidos los títulos originales— sale
    // subrayada. Compilado y mirado.
    '\\usepackage[normalem]{ulem}',
    '\\usepackage{titlesec}',
    '\\usepackage{fancyhdr}',
    '\\usepackage[hidelinks]{hyperref}',
    '',
    // El amarillo de pantalla (#FFD21E) a plena saturación detrás del texto lee
    // como una fotocopia repasada a rotulador. El lavado conserva la marca y
    // deja de gritar; la de la IA pierde el fondo y pasa a punteado, que es lo
    // que las distingue también impresas en blanco y negro.
    '\\definecolor{ptWash}{HTML}{FFE066}',
    '\\definecolor{ptGrey}{HTML}{6B7280}',
    '\\definecolor{ptRule}{HTML}{C9CCD4}',
    ...(hasHighlights ? ['\\sethlcolor{ptWash}'] : []),
    '',
    ...copy.kindNote.map(line => `% ${line}`),
    '\\newcommand{\\ptmono}{\\ttfamily}',
    '\\newcommand{\\ptkind}[1]{\\textsc{#1}}',
    // El encabezado tal como está impreso en el paper. Termina en \noindent
    // \ignorespaces porque abre párrafo y, con babel español, el siguiente
    // saldría sangrado: el primer párrafo de una sección va a bandera.
    '\\newcommand{\\ptorig}[1]{\\vspace{-5pt}\\par\\noindent'
      + '{\\ptmono\\scriptsize\\color{ptGrey}#1}\\par\\vspace{3pt}\\noindent\\ignorespaces}',
    '\\newcommand{\\ptrule}{\\noindent\\textcolor{ptRule}{\\rule{\\textwidth}{0.4pt}}}',
    '',
    // {0.62em}: con \large\bfseries, 1em deja el número descolgado del título.
    '\\titleformat{\\section}[hang]{\\normalfont\\bfseries\\large}{\\thesection}{0.62em}{}',
    '\\titlespacing*{\\section}{0pt}{18pt}{5pt}',
    '',
  ];
}
```

- [ ] **Step 4: Sustituir `footer` por `pageStyles`**

Borrar la función `footer` entera y poner en su lugar:

```js
/**
 * Las dos páginas que tiene este documento.
 *
 * La primera se presenta —quién compuso esto y a qué nivel— y las demás
 * navegan: a la izquierda el artículo, a la derecha la sección en la que vas.
 * `\leftmark` da la ÚLTIMA sección abierta en la página, que es lo que quiere
 * decir «dónde estoy» cuando una sección viene de la página anterior.
 *
 * La procedencia no se mueve al colofón: sigue al pie de CADA página, fuera de
 * la numeración de las notas, porque el fichero puede acabar lejos de aquí.
 */
function pageStyles(meta) {
  const foot = escapeLatexText(meta.provenance);
  return [
    '\\renewcommand{\\sectionmark}[1]'
      + '{\\markboth{\\thesection\\ \\textperiodcentered\\ #1}{}}',
    '\\renewcommand{\\headrule}{\\color{ptRule}\\hrule height \\headrulewidth}',
    '\\renewcommand{\\footrule}{\\color{ptRule}\\hrule height \\footrulewidth}',
    '',
    '\\fancypagestyle{ptfirst}{%',
    '  \\fancyhf{}%',
    `  \\fancyhead[L]{\\ptmono\\scriptsize ${escapeLatexText(meta.masthead)}}%`,
    `  \\fancyhead[R]{\\ptmono\\scriptsize ${escapeLatexText(meta.level)}}%`,
    `  \\fancyfoot[L]{\\ptmono\\scriptsize ${foot}}%`,
    '  \\fancyfoot[R]{\\thepage}%',
    '  \\renewcommand{\\headrulewidth}{1.3pt}%',
    '  \\renewcommand{\\headrule}{\\hrule height \\headrulewidth}%',
    '  \\renewcommand{\\footrulewidth}{0.4pt}%',
    '}',
    '',
    '\\pagestyle{fancy}',
    '\\fancyhf{}',
    `\\fancyhead[L]{\\ptmono\\scriptsize ${escapeLatexText(meta.runningTitle)}}`,
    '\\fancyhead[R]{\\ptmono\\scriptsize\\leftmark}',
    `\\fancyfoot[L]{\\ptmono\\scriptsize ${foot}}`,
    '\\fancyfoot[R]{\\thepage}',
    '\\renewcommand{\\headrulewidth}{0.4pt}',
    '\\renewcommand{\\footrulewidth}{0.4pt}',
    '',
  ];
}
```

El enlace al original deja de ir en el pie (era una URL en mono cortada a mitad): ahora vive en la línea de fuente de la portada y en el colofón, las dos veces entero.

- [ ] **Step 5: Enganchar `pageStyles` en `buildLatexDocument`**

En `buildLatexDocument`, sustituir la llamada `...footer(copy, originalUrl)` por `...pageStyles(meta)`, donde `meta` sale de:

```js
  const meta = documentMeta({
    paper, language, level, originalUrl, generatedAt,
    counts: summarizeExport(kept),
  });
```

y añadir `generatedAt = new Date()` a los parámetros desestructurados de `buildLatexDocument`, junto a `originalUrl`. Importar `documentMeta` y `summarizeExport` de `./exportDocument.js`.

- [ ] **Step 6: Correr los tests**

Run: `node --test src/utils/latexExport.test.js`
Expected: PASS los cuatro nuevos. Los viejos que buscan `\maketitle`, `abstract` o `\definecolor{ptYellow}` fallarán: es lo que arregla la Task 4. Si alguno falla por otra cosa, pararse.

- [ ] **Step 7: Commit**

```bash
git add src/utils/latexExport.js src/utils/latexExport.test.js
git commit -m "feat(tex): preámbulo y estilos de página de la separata"
```

---

### Task 4: El cuerpo del `.tex` — portada, aviso y secciones

**Files:**
- Modify: `src/utils/latexExport.js` (`authorLine`, `buildLatexDocument`)
- Test: `src/utils/latexExport.test.js`

**Interfaces:**
- Consumes: `pageStyles`, `documentMeta`.
- Produces: `authorLine(paper, limit)` deja de devolver un `\parbox` centrado y devuelve la línea escapada.

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('la portada va en bandera: ni maketitle ni abstract', () => {
  const { source } = buildLatexDocument({ paper: PAPER, sections: SECTIONS, annotations: [] });
  // `\thispagestyle{ptfirst}` se emite aquí, en el cuerpo — la Task 3 solo
  // DEFINE el estilo; quien lo aplica a la página 1 es esta portada.
  assert.match(source, /\\begin\{document\}\n\\thispagestyle\{ptfirst\}/);
  assert.doesNotMatch(source, /\\maketitle/);
  assert.doesNotMatch(source, /begin\{abstract\}/);
  assert.match(source, /\\begin\{flushleft\}/);
});

test('el aviso lleva su etiqueta al margen y no es un resumen', () => {
  const { source } = buildLatexDocument({ paper: PAPER, sections: SECTIONS, annotations: [] });
  assert.match(source, /\\begin\{minipage\}\[t\]\{58pt\}\\ptmono\\scriptsize Aviso/);
});

test('el encabezado original del paper se imprime bajo el título de sección', () => {
  const { source } = buildLatexDocument({
    paper: PAPER,
    sections: [{ ...SECTIONS[0], originalHeading: '2. Methods & results' }],
    annotations: [],
  });
  assert.match(source, /\\ptorig\{2\. Methods \\& results\}/);
});

test('una sección sin encabezado original no deja un ptorig vacío', () => {
  const { source } = buildLatexDocument({
    paper: PAPER, sections: [{ ...SECTIONS[0], originalHeading: '' }], annotations: [],
  });
  assert.doesNotMatch(source, /\\ptorig/);
});

test('el byline es una línea de texto, no una caja centrada', () => {
  assert.equal(
    authorLine({ authors: [{ name: 'A. Pérez' }, { name: 'B. Ruiz' }] }),
    'A. P\\\'erez, B. Ruiz'.replace("\\'", 'é') === '' ? '' : 'A. Pérez, B. Ruiz',
  );
  assert.doesNotMatch(authorLine({ authors: [{ name: 'A' }] }), /parbox/);
});
```

> Nota para quien implemente: la última aserción del byline está escrita así de rara a propósito para que no dependa de cómo escape acentos `escapeLatexText` (los deja pasar, son UTF-8 y compilan). Si al implementar ves que la comparación es confusa, sustitúyela por `assert.equal(authorLine({ authors: [{ name: 'A. Perez' }, { name: 'B. Ruiz' }] }), 'A. Perez, B. Ruiz')` y quédate solo con el `doesNotMatch` para el `parbox`.

- [ ] **Step 2: Correr los tests para verlos fallar**

Run: `node --test src/utils/latexExport.test.js`
Expected: FAIL en los cinco.

- [ ] **Step 3: Simplificar `authorLine`**

```js
/**
 * El byline, escapado. Ya no es un `\parbox` centrado: la portada va en
 * bandera y `flushleft` parte la línea sola cuando hay nueve autores.
 */
export function authorLine(paper, limit = 12) {
  const names = (Array.isArray(paper?.authors) ? paper.authors : [])
    .map(author => String(author?.name || author || '').trim())
    .filter(Boolean);
  if (names.length === 0) return '';
  const shown = names.slice(0, limit).map(escapeLatexText).join(', ');
  return names.length > limit ? `${shown} et al.` : shown;
}
```

- [ ] **Step 4: Reescribir el cuerpo de `buildLatexDocument`**

Sustituir el bloque que va desde `\title{...}` hasta el cierre del `abstract` por:

```js
  const lines = [
    ...preamble(copy, hasHighlights),
    ...pageStyles(meta),
    '\\begin{document}',
    '\\thispagestyle{ptfirst}',
    '',
    '\\begin{flushleft}',
    `{\\LARGE ${escapeLatexText(meta.title)}\\par}`,
    ...(meta.byline ? ['\\vspace{10pt}', `{\\large ${authorLine(paper)}\\par}`] : []),
    ...(meta.source ? ['\\vspace{5pt}', `{\\ptmono\\small ${escapeLatexText(meta.source)}\\par}`] : []),
    '\\end{flushleft}',
    '',
    // El aviso no es un abstract: no resume el paper, advierte de algo. Etiqueta
    // al margen y texto a la derecha, entre dos filetes finos.
    '\\vspace{6pt}\\ptrule\\vspace{6pt}',
    '',
    `\\noindent\\begin{minipage}[t]{58pt}\\ptmono\\scriptsize ${escapeLatexText(meta.noticeLabel)}\\end{minipage}%`,
    '\\hspace{22pt}%',
    `\\begin{minipage}[t]{\\dimexpr\\textwidth-80pt\\relax}\\small ${escapeLatexText(meta.notice)}\\end{minipage}`,
    '',
    '\\vspace{6pt}\\ptrule\\vspace{4pt}',
    '',
  ];
```

Y en el bucle de secciones, después del `\section{...}`:

```js
  for (const section of sections) {
    const label = section?.heading
      || kindLabels[section?.kind]
      || SECTION_FALLBACK[language === 'en' ? 'en' : 'es'];
    lines.push(`\\section{${escapeLatexText(label)}}`);
    // El encabezado tal como está impreso en el paper. Lo devuelve el modelo
    // (`originalHeading`) y hasta ahora los dos exports lo tiraban: es lo que
    // deja volver al sitio exacto del PDF original.
    const origin = String(section?.originalHeading || '').trim();
    if (origin) lines.push(`\\ptorig{${escapeLatexText(origin)}}`);
```

- [ ] **Step 5: Correr los tests**

Run: `node --test src/utils/latexExport.test.js`
Expected: PASS todo el fichero. Los tests viejos que esperaban `\maketitle`/`abstract` hay que actualizarlos aquí, no antes: cambiar sus aserciones a la portada nueva, sin borrar el test.

- [ ] **Step 6: Commit**

```bash
git add src/utils/latexExport.js src/utils/latexExport.test.js
git commit -m "feat(tex): portada en bandera, aviso con etiqueta y el encabezado original bajo cada sección"
```

---

### Task 5: Las marcas del `.tex` — lavado y punteado

**Files:**
- Modify: `src/utils/latexExport.js` (`renderParagraph`)
- Test: `src/utils/latexExport.test.js`

**Interfaces:**
- Consumes: `buildHighlightPlan` (sin cambios).
- Produces: `renderParagraph(text, annotations, labels)` emite `\hl{}` para la marca del lector y `\dotuline{}` para la de la IA.

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('la marca del lector es lavado y la de la IA, punteado', () => {
  const text = 'Los autores calculan el tiempo propio de la particula.';
  const mine = { id: 'm', kind: 'user', quote: 'Los autores calculan' };
  const ai = { id: 'a', kind: 'ai', quote: 'el tiempo propio' };
  const out = renderParagraph(text, [mine, ai], LABELS);
  assert.match(out, /\\hl\{Los autores calculan\}/);
  assert.match(out, /\\dotuline\{el tiempo propio\}/);
});

test('una marca de la IA que cruza una fórmula sigue siendo un solo comando', () => {
  // El mismo motivo que ya tenía \hl: dos comandos seguidos dejan una costura
  // visible a mitad de la marca. \dotuline admite matemáticas dentro y parte
  // entre líneas — compilado y mirado.
  const text = 'La anchura $\\tau$ crece con la energia.';
  const ai = { id: 'a', kind: 'ai', quote: 'La anchura $\\tau$ crece' };
  const out = renderParagraph(text, [ai], LABELS);
  assert.equal(out.match(/\\dotuline\{/g).length, 1);
});

test('la nota va detrás de la marca, sea del tipo que sea', () => {
  const text = 'Los autores calculan el tiempo propio.';
  const ai = { id: 'a', kind: 'ai', quote: 'Los autores calculan', note: 'Ojo.' };
  const out = renderParagraph(text, [ai], LABELS);
  assert.match(out, /\\dotuline\{Los autores calculan\}\\footnote\{\\ptkind\{IA\}/);
});
```

- [ ] **Step 2: Correr los tests para verlos fallar**

Run: `node --test src/utils/latexExport.test.js`
Expected: FAIL: hoy todo sale como `\hl`.

- [ ] **Step 3: Hacer que el run recuerde de quién es la marca**

En `renderParagraph`, el objeto `run` pasa a llevar `kind`, y `flush` elige comando:

```js
  const flush = () => {
    if (!run) return;
    const body = run.parts.join('');
    // Dos mecanismos, no dos colores: el lavado amarillo para la del lector,
    // el punteado para la de la IA. Fotocopiadas en gris, dos fondos claros
    // eran el mismo gris; un fondo y un punteado no se confunden nunca.
    const command = run.kind === 'ai' ? '\\dotuline' : '\\hl';
    const note = marked.find(item => item.id === run.id);
    const kind = note && (note.kind === 'ai' ? labels.ai : labels.mine);
    pieces.push(note
      ? `${command}{${body}}\\footnote{\\ptkind{${escapeLatexText(kind || '')}}\\quad ${escapeLatexText(note.note)}}`
      : `${command}{${body}}`);
    run = null;
  };
```

y en el bucle, donde hoy se abre o continúa el run:

```js
    if (run && run.id === (item.id || null)) run.parts.push(body);
    else {
      flush();
      run = { id: item.id || null, kind: item.kind || null, parts: [body] };
    }
```

- [ ] **Step 4: Corregir la guarda de `hasHighlights`**

`soul` solo se carga si hay marcas, pero ahora un documento puede tener solo marcas de la IA y ninguna del lector. `ulem` se carga siempre (Task 3), así que lo único que hay que afinar es que `\sethlcolor` no se emita sin `soul`. En `buildLatexDocument`:

```js
  const hasHighlights = kept.some(item => item.kind !== 'ai');
```

- [ ] **Step 5: Correr los tests**

Run: `node --test src/utils/latexExport.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/utils/latexExport.js src/utils/latexExport.test.js
git commit -m "feat(tex): la marca de la IA deja de ser un fondo gris y pasa a punteado"
```

---

### Task 6: El colofón del `.tex`

**Files:**
- Modify: `src/utils/latexExport.js` (`buildLatexDocument`)
- Test: `src/utils/latexExport.test.js`

- [ ] **Step 1: Escribir el test que falla**

```js
test('el documento cierra con un colofón de procedencia', () => {
  const { source } = buildLatexDocument({
    paper: PAPER, sections: SECTIONS, annotations: [MARK],
    originalUrl: 'https://arxiv.org/abs/2405.04331',
    generatedAt: new Date(Date.UTC(2026, 8, 4)),
  });
  assert.match(source, /Procedencia/);
  assert.match(source, /Artículo original/);
  assert.match(source, /4 de septiembre de 2026/);
  // Va al final, después de la última sección y antes de cerrar el documento.
  assert.ok(source.indexOf('Procedencia') > source.lastIndexOf('\\section{'));
});

test('el colofón no imprime filas sin dato', () => {
  const { source } = buildLatexDocument({
    paper: { title: 'T', authors: [] }, sections: SECTIONS, annotations: [], originalUrl: '',
  });
  assert.doesNotMatch(source, /Autoría/);
  assert.doesNotMatch(source, /Fuente/);
});
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `node --test src/utils/latexExport.test.js`
Expected: FAIL, no hay «Procedencia» en la salida.

- [ ] **Step 3: Implementar el bloque**

Añadir la función, junto a `pageStyles`:

```js
/**
 * De dónde salió esto, en una tabla que se lee de un vistazo seis meses después
 * con el fichero suelto en una carpeta. Ningún campo es nuevo: todos salen del
 * modelo que ya viaja al export.
 */
function colophon(meta) {
  if (meta.colophon.rows.length === 0) return [];
  return [
    '\\vspace{24pt}',
    '\\noindent\\rule{\\textwidth}{1.3pt}',
    '\\vspace{6pt}',
    '',
    `\\noindent{\\ptmono\\scriptsize ${escapeLatexText(meta.colophon.heading)}}`,
    '\\vspace{6pt}',
    '',
    '\\noindent\\begin{tabular}{@{}p{92pt}p{\\dimexpr\\textwidth-104pt\\relax}@{}}',
    ...meta.colophon.rows.map(row =>
      `{\\ptmono\\scriptsize\\color{ptGrey}${escapeLatexText(row.key)}} & ${escapeLatexText(row.value)} \\\\[3pt]`),
    '\\end{tabular}',
    '',
  ];
}
```

y en `buildLatexDocument`, antes de `lines.push('\\end{document}')`:

```js
  lines.push(...colophon(meta));
```

- [ ] **Step 4: Correr los tests**

Run: `node --test src/utils/latexExport.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/latexExport.js src/utils/latexExport.test.js
git commit -m "feat(tex): colofón de procedencia al cierre del documento"
```

---

### Task 7: Puerta de compilación — compilar y MIRAR la página

Ningún test de este fichero prueba que el `.tex` compile: prueban que la cadena contiene lo que debe. Esta tarea es la que dice si el documento existe. La doctrina del fichero (su comentario de cabecera) es que aquí no se razona, se compila y se mira.

**Files:** ninguno del repo. Se trabaja en un directorio temporal.

- [ ] **Step 1: Generar un `.tex` de verdad desde el código**

```bash
mkdir -p /tmp/separata && node --input-type=module -e "
import { buildLatexDocument } from './src/utils/latexExport.js';
const paper = { title: 'Worldline proper length correlators & el 100% del ruido_medido',
  authors: [{ name: 'Allic Sivaramakrishnan' }, { name: 'M. Ángeles Pérez' }] };
const sections = [
  { id: 's1', kind: 'intro', heading: 'De qué va el paper', originalHeading: '§1 Introduction',
    paragraphs: ['Los autores calculan cuánto tiempo propio transcurre y encuentran que esa cantidad deja de ser un número y pasa a ser una distribución con \$\\\\tau\$ dentro en cuanto la gravedad cuántica entra en juego.',
                 'La varianza \$\\\\langle \\\\tau^2 \\\\rangle - \\\\langle \\\\tau \\\\rangle^2\$ deja de anularse y la anchura crece con la energía —despacio— del sistema estudiado.'] },
  { id: 's2', kind: 'methods', heading: 'Cómo lo hicieron', originalHeading: '§2 Proper length from the two-point function',
    paragraphs: ['Una inducción sobre el índice \$[M : N]\$ del submódulo cierra el hueco entre los dos recuentos.'] },
];
const annotations = [
  { id: 'a1', sectionId: 's1', paragraphIndex: 0, kind: 'user', quote: 'esa cantidad deja de ser un número y pasa a ser una distribución con \$\\\\tau\$ dentro', note: 'El ruido no lo pone el aparato: sale de la propia métrica.' },
  { id: 'a2', sectionId: 's1', paragraphIndex: 1, kind: 'ai', quote: 'la anchura crece con la energía', note: 'Crece como la raíz de la energía.' },
];
const built = buildLatexDocument({ paper, sections, annotations, language: 'es', level: 'university',
  kindLabels: { intro: 'Introducción', methods: 'Método', other: 'Sección' },
  originalUrl: 'https://arxiv.org/abs/2405.04331', generatedAt: new Date(Date.UTC(2026, 8, 4)) });
process.stdout.write(built.source);
" > /tmp/separata/doc.tex && head -5 /tmp/separata/doc.tex
```

- [ ] **Step 2: Compilar**

```bash
cd /tmp/separata && pdflatex -interaction=nonstopmode -halt-on-error doc.tex >log.txt 2>&1; echo "exit=$?"; tail -20 log.txt
```

Expected: `exit=0` y `Output written on doc.pdf`. Cualquier otra cosa: leer `log.txt`, no adivinar.

- [ ] **Step 3: MIRAR la página**

```bash
cd /tmp/separata && sips -s format png --resampleWidth 1500 doc.pdf --out p1.png
```

Abrir `p1.png` y comprobar, una por una:
- La cabecera de identidad arriba, con filete grueso debajo.
- Título en bandera, byline, línea de fuente en mono.
- El aviso con «Aviso» a la izquierda, entre dos filetes finos.
- El número de sección pegado a su título, y debajo el encabezado original en mono gris.
- **El primer párrafo de cada sección, a bandera; el segundo, sangrado.**
- La marca del lector con lavado amarillo; la de la IA punteada, y el punteado se ve punteado.
- Las notas al pie con la etiqueta en versalitas.
- Filete, procedencia y número de página al pie.
- El colofón al final, con sus filas.

- [ ] **Step 4: Compilar también con xelatex**

El preámbulo promete en su comentario que compila con los dos.

```bash
cd /tmp/separata && xelatex -interaction=nonstopmode -halt-on-error doc.tex >logx.txt 2>&1; echo "exit=$?"; tail -5 logx.txt
```

Expected: `exit=0`.

- [ ] **Step 5: Sin commit**

Esta tarea no toca el repo. Si algo de lo mirado no cuadra, se arregla en la tarea que lo introdujo y se vuelve a pasar por aquí.

---

### Task 8: `PAGE_CSS` y los bloques del PDF

**Files:**
- Modify: `src/utils/pdfExport.js` (`PAGE_CSS`, `buildPdfModel`, `buildBlocks`)
- Test: `src/utils/pdfExport.test.js`
- Read: `design/export-rediseno/Main.dc.html` — es la especificación al pixel

**Interfaces:**
- Consumes: `documentMeta` (Task 2).
- Produces: el modelo gana `meta` (lo que devuelve `documentMeta`) y cada sección gana `originalHeading`. Desaparecen `title`, `byline`, `stamp`, `abstract` y `provenance` del nivel raíz: ahora viven en `meta`.

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('el modelo lleva los metadatos montados, no las piezas sueltas', () => {
  const model = build({ generatedAt: new Date(Date.UTC(2026, 8, 4)) });
  assert.equal(model.meta.masthead, 'PaperTok · Versión en lenguaje sencillo');
  assert.equal(model.meta.level, 'Nivel universitario');
  assert.match(model.meta.source, /4 de septiembre de 2026/);
  assert.equal(model.meta.colophon.rows.length > 0, true);
});

test('el encabezado original del paper llega al modelo del PDF', () => {
  const model = build({
    sections: [{ ...SECTIONS[0], originalHeading: '2. Methods' }],
  });
  assert.equal(model.sections[0].originalHeading, '2. Methods');
});

test('una sección sin encabezado original lo deja vacío, no undefined', () => {
  const model = build();
  assert.equal(model.sections[1].originalHeading, '');
});

test('el modelo del PDF y el del .tex cuentan lo mismo', () => {
  // Los dos formatos son el mismo documento: si divergen, uno miente.
  const args = { paper: PAPER, sections: SECTIONS, annotations: [], language: 'es',
    level: 'university', kindLabels: KIND_LABELS, originalUrl: 'https://arxiv.org/abs/2401.00001',
    generatedAt: new Date(Date.UTC(2026, 8, 4)) };
  const model = buildPdfModel(args);
  const { source } = buildLatexDocument(args);
  assert.ok(source.includes(model.meta.colophon.rows.at(-1).value));
});
```

Añadir a los imports del test: `import { buildLatexDocument } from './latexExport.js';`

- [ ] **Step 2: Correr los tests para verlos fallar**

Run: `node --test src/utils/pdfExport.test.js`
Expected: FAIL en los cuatro.

- [ ] **Step 3: Cambiar `buildPdfModel`**

Añadir `generatedAt = new Date()` a los parámetros, y sustituir el objeto devuelto por:

```js
  return {
    meta: documentMeta({
      paper, language, level, originalUrl, generatedAt, counts: summarizeExport(kept),
    }),
    language: language === 'en' ? 'en' : 'es',
    labels: { mine: copy.mine, ai: copy.ai },
    sections: sections.map(section => ({
      label: section?.heading || kindLabels[section?.kind] || fallback,
      originalHeading: String(section?.originalHeading || '').trim(),
      paragraphs: (Array.isArray(section?.paragraphs) ? section.paragraphs : [])
        .map((text, index) => ({
          text,
          annotations: byParagraph.get(`${section?.id}:${index}`) || [],
        })),
    })),
    noteCount: numbered.length,
    fileName: exportFileName(paper, language, 'pdf'),
  };
```

Importar `documentMeta` y `summarizeExport` de `./exportDocument.js`. Borrar `plainAuthorLine` y su test: lo hace ahora `bylineText` en `exportDocument.js`.

- [ ] **Step 4: Reescribir `PAGE_CSS`**

Los valores salen de `design/export-rediseno/Main.dc.html`, que está compuesto a 794×1123 (A4 a 96 ppp) con margen de 104 px. Constantes de arriba del fichero:

```js
const PAGE_W = 794;
const PAGE_H = 1123;
const MARGIN = 104;
```

`FOOT_H` desaparece: el pie ahora es un bloque con su filete y se mide solo.

```js
const PAGE_CSS = `
.pdfx-page { box-sizing: border-box; width: ${PAGE_W}px; height: ${PAGE_H}px; padding: 62px ${MARGIN}px 46px; display: flex; flex-direction: column; background: #ffffff; color: #111318; font-family: 'Newsreader Variable', 'Iowan Old Style', Georgia, serif; }
.pdfx-page * { box-sizing: border-box; margin: 0; }
.pdfx-mast { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9px; font-weight: 500; line-height: 1; letter-spacing: 0.12em; text-transform: uppercase; color: #7b8290; }
.pdfx-mast-b { color: #111318; }
.pdfx-mast-rule { height: 1.3px; background: #111318; margin-top: 9px; }
.pdfx-mast-rule--cont { height: 0.8px; background: #c9ccd4; margin-top: 9px; }
.pdfx-hair { height: 0.8px; background: #dcdee4; }
.pdfx-title { font-size: 30px; font-weight: 400; line-height: 1.14; letter-spacing: -0.006em; margin-top: 27px; text-wrap: pretty; }
.pdfx-byline { font-size: 16px; line-height: 1.35; margin-top: 14px; }
.pdfx-source { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 10px; line-height: 1.5; letter-spacing: 0.035em; color: #7b8290; margin: 7px 0 21px; }
.pdfx-notice { display: flex; gap: 22px; padding: 13px 0 14px; }
.pdfx-notice-l { flex: 0 0 58px; font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9px; font-weight: 500; line-height: 1.85; letter-spacing: 0.12em; text-transform: uppercase; color: #7b8290; }
.pdfx-notice-t { flex: 1 1 auto; font-size: 13.5px; line-height: 1.52; color: #3a3e46; text-align: justify; }
.pdfx-flow { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.pdfx-sec { display: flex; gap: 13px; margin: 25px 0 10px; }
.pdfx-sec-no { flex: 0 0 22px; font-size: 17px; font-weight: 600; line-height: 1.3; }
.pdfx-sec-n { font-size: 17px; font-weight: 600; line-height: 1.3; }
.pdfx-sec-o { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9.5px; line-height: 1.5; letter-spacing: 0.03em; color: #6b7280; margin-top: 3px; }
.pdfx-para { font-size: 16px; line-height: 1.62; text-align: justify; }
.pdfx-para + .pdfx-para { text-indent: 1.4em; }
.pdfx-mark { background: #ffe066; padding: 0 1px; }
.pdfx-mark--ai { background: none; border-bottom: 1.4px dotted #6b7280; }
.pdfx-fnref { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9.5px; font-weight: 500; vertical-align: super; line-height: 0; padding-left: 1.5px; }
.pdfx-colo { margin-top: 30px; border-top: 1.3px solid #111318; padding-top: 12px; }
.pdfx-colo-h { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9px; font-weight: 500; line-height: 1; letter-spacing: 0.12em; text-transform: uppercase; color: #7b8290; margin-bottom: 10px; }
.pdfx-colo-g { display: grid; grid-template-columns: 116px 1fr; gap: 6px 18px; }
.pdfx-colo-k { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 10px; line-height: 1.55; letter-spacing: 0.03em; color: #868d99; }
.pdfx-colo-v { font-size: 13.5px; line-height: 1.42; }
.pdfx-notes { flex: 0 0 auto; padding-top: 13px; }
.pdfx-notes::before { content: ''; display: block; width: 132px; height: 0.8px; background: #111318; margin-bottom: 9px; }
.pdfx-note { display: flex; gap: 8px; font-size: 12.5px; line-height: 1.46; color: #3a3e46; margin-bottom: 5px; }
.pdfx-note-no { flex: 0 0 11px; font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9.5px; font-weight: 500; line-height: 1.95; color: #7b8290; }
.pdfx-note-kind { font-variant: small-caps; letter-spacing: 0.045em; color: #111318; }
.pdfx-foot { flex: 0 0 auto; padding-top: 14px; }
.pdfx-foot-row { display: flex; align-items: baseline; gap: 14px; padding-top: 7px; }
.pdfx-foot-s { flex: 1 1 auto; font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 9px; line-height: 1.5; letter-spacing: 0.03em; color: #868d99; }
.pdfx-foot-n { font-size: 13px; }
.pdfx-page .katex { font-size: 1.02em; }
`;
```

Sigue sin haber `hyphens: auto` en ningún sitio, y por el mismo motivo de siempre: el rasterizador dibuja el corte sin el guion y «justificado» salía «justific ado».

Y una trampa que hay que no pisar: la marca del lector es `background`, no `box-shadow`. `box-shadow` está en la lista de propiedades que html2canvas no dibuja, así que una marca hecha así se rasterizaría invisible y el subrayado del lector desaparecería del PDF sin error ninguno. `background` y `border-bottom` —lo que usan `.pdfx-mark` y `.pdfx-mark--ai`— sí se dibujan, y es lo que ya funciona hoy. Si alguien quiere el trazo bajo la línea en vez del lavado, hay que comprobarlo antes contra `html2canvas-pro`, no darlo por hecho.

- [ ] **Step 5: Reescribir `buildBlocks`**

```js
function buildBlocks(model, katex) {
  const blocks = [];
  const push = (node, { notes = [], heading = null } = {}) => {
    blocks.push({ node, notes, heading });
  };

  const title = element('h1', 'pdfx-title');
  renderParagraphInto(title, model.meta.title, [], katex);
  push(title);
  if (model.meta.byline) push(element('div', 'pdfx-byline', model.meta.byline));
  if (model.meta.source) push(element('div', 'pdfx-source', model.meta.source));

  push(element('div', 'pdfx-hair'));
  const notice = element('div', 'pdfx-notice');
  notice.append(
    element('span', 'pdfx-notice-l', model.meta.noticeLabel),
    element('p', 'pdfx-notice-t', model.meta.notice),
  );
  push(notice);
  push(element('div', 'pdfx-hair'));

  model.sections.forEach((section, index) => {
    const head = element('div', 'pdfx-sec');
    const stack = element('div');
    stack.appendChild(element('h2', 'pdfx-sec-n', section.label));
    // El encabezado tal como está impreso en el paper, igual que en el lector.
    if (section.originalHeading) {
      stack.appendChild(element('p', 'pdfx-sec-o', section.originalHeading));
    }
    head.append(element('span', 'pdfx-sec-no', String(index + 1)), stack);
    // `heading` deja de ser un booleano: lleva el texto del titulillo, que el
    // paginador necesita para saber en qué sección acaba cada página.
    push(head, { heading: `${index + 1}  ·  ${section.label}` });

    for (const paragraph of section.paragraphs) {
      const node = element('p', 'pdfx-para');
      node.lang = model.language;
      renderParagraphInto(node, paragraph.text, paragraph.annotations, katex);
      const notes = paragraph.annotations
        .filter(item => item.note && item.number != null)
        .map(item => ({
          number: item.number,
          kind: item.kind === 'ai' ? model.labels.ai : model.labels.mine,
          text: item.note,
        }));
      push(node, { notes });
    }
  });

  if (model.meta.colophon.rows.length > 0) {
    const colo = element('div', 'pdfx-colo');
    colo.appendChild(element('p', 'pdfx-colo-h', model.meta.colophon.heading));
    const grid = element('div', 'pdfx-colo-g');
    for (const row of model.meta.colophon.rows) {
      grid.append(element('span', 'pdfx-colo-k', row.key), element('p', 'pdfx-colo-v', row.value));
    }
    colo.appendChild(grid);
    push(colo);
  }

  return blocks;
}
```

Y `noteEntry` pasa a la estructura de dos columnas:

```js
function noteEntry(note) {
  const node = element('div', 'pdfx-note');
  const body = element('span');
  body.append(
    element('span', 'pdfx-note-kind', note.kind),
    document.createTextNode(` ${note.text}`),
  );
  node.append(element('span', 'pdfx-note-no', String(note.number)), body);
  return node;
}
```

- [ ] **Step 6: Correr los tests**

Run: `node --test src/utils/pdfExport.test.js`
Expected: PASS. Los tests viejos que leían `model.title`, `model.byline`, `model.stamp`, `model.abstract` o `model.provenance` hay que reescribirlos contra `model.meta.*` aquí mismo.

- [ ] **Step 7: Commit**

```bash
git add src/utils/pdfExport.js src/utils/pdfExport.test.js
git commit -m "feat(pdf): la página del PDF se compone como la separata"
```

---

### Task 9: El mobiliario de página del PDF

La parte que no tiene test porque necesita DOM: cabecera de identidad en la página 1, titulillo con la sección en curso en las demás. El paginador crea la página ANTES de sentar su contenido, así que el titulillo no se puede escribir en ese momento: se escribe en una segunda pasada, cuando ya se sabe qué secciones cayeron en cada página.

**Files:**
- Modify: `src/utils/pdfExport.js` (`renderPdfPages`)

- [ ] **Step 1: Dar a cada página su cabecera y su pie**

Dentro de `renderPdfPages`, sustituir `newPage` por:

```js
  const heads = [];

  const newPage = () => {
    page = element('div', 'pdfx-page');
    const mast = element('div', 'pdfx-mast');
    const mastL = element('span');
    const mastR = element('span');
    mast.append(mastL, mastR);
    const mastRule = element('div');
    // La primera página se presenta; las demás navegan.
    if (pages.length === 0) {
      mastL.appendChild(element('span', 'pdfx-mast-b', model.meta.masthead));
      mastR.textContent = model.meta.level;
      mastRule.className = 'pdfx-mast-rule';
    } else {
      mastL.appendChild(element('span', 'pdfx-mast-b', model.meta.runningTitle));
      mastRule.className = 'pdfx-mast-rule--cont';
    }
    heads.push(mastR);

    flow = element('div', 'pdfx-flow');
    notes = element('div', 'pdfx-notes');
    notes.style.display = 'none';

    const foot = element('div', 'pdfx-foot');
    foot.appendChild(element('div', 'pdfx-hair'));
    const row = element('div', 'pdfx-foot-row');
    row.append(
      element('span', 'pdfx-foot-s', model.meta.provenance),
      element('span', 'pdfx-foot-n', String(pages.length + 1)),
    );
    foot.appendChild(row);

    page.append(mast, mastRule, flow, notes, foot);
    host.appendChild(page);
    pages.push(page);
  };
```

- [ ] **Step 2: Llevar la cuenta de la sección en curso**

En el bucle de bloques, donde hoy se comprueba `block.heading` para no dejar un título huérfano, `heading` ya no es booleano sino el texto del titulillo. Cambiar la comprobación del huérfano a la clase, que es lo que de verdad identifica el nodo:

```js
      const last = flow.lastElementChild;
      const carried = last?.classList.contains('pdfx-sec') && flow.children.length > 1
        ? last
        : null;
```

Y justo después de sentar definitivamente un bloque, anotar en qué página quedó su sección. Declarar antes del bucle `const marks = [];` y dentro, después de que el bloque se quede:

```js
    if (block.heading) marks.push({ page: pages.length - 1, text: block.heading });
```

Cuidado: si el bloque se movió a página nueva, esta línea tiene que ejecutarse DESPUÉS del movimiento, no antes — `pages.length - 1` se lee al final del cuerpo del bucle.

- [ ] **Step 3: Segunda pasada, escribir los titulillos**

Justo antes de `if (document.fonts?.ready)`:

```js
  // El titulillo dice en qué sección vas. Se escribe ahora y no al crear la
  // página porque una página se crea vacía: hasta que no se ha sentado todo no
  // se sabe qué secciones cayeron en ella. Una página sin título propio hereda
  // el de la anterior, que es justo el caso de una sección que continúa.
  let running = '';
  for (let index = 0; index < pages.length; index += 1) {
    const own = marks.filter(mark => mark.page === index).at(-1);
    if (own) running = own.text;
    if (index > 0) heads[index].textContent = running;
  }
```

- [ ] **Step 4: Comprobar que no ha quedado nada del pie viejo**

```bash
grep -n "FOOT_H\|pdfx-foot-link\|pdfx-stamp\|pdfx-abstract\|pdfx-heading\|model.provenance\b" src/utils/pdfExport.js
```

Expected: solo `model.meta.provenance`. Cualquier otra cosa es un resto del diseño anterior.

- [ ] **Step 5: Correr todo**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/utils/pdfExport.js
git commit -m "feat(pdf): cabecera de identidad, titulillo con la sección en curso y colofón"
```

---

### Task 10: La vista previa de la tarjeta deja de mentir

La tarjeta dibuja una miniatura de la página («la vista previa es una página de verdad dibujada pequeña», dice su comentario). Si el documento cambia y la miniatura no, la tarjeta promete un documento que ya no existe.

**Files:**
- Modify: `src/components/Reader/ExportCard.jsx:170-200`
- Modify: `src/components/Reader/Export.css:225-305`
- Modify: `src/components/Reader/PaperReader.jsx:100-102,177-179` (copys de la miniatura)

- [ ] **Step 1: Cambiar la miniatura**

En `ExportCard.jsx`, dentro de `.rd-export-sheet`, sustituir el bloque título/byline/abstract por la portada nueva: título a la izquierda (no centrado), byline, línea de fuente, filete, aviso con etiqueta, y bajo el título de sección una línea corta gris que representa el encabezado original.

```jsx
          <div className="rd-export-sheet" aria-hidden="true">
            <p className="rd-export-sheet-mast">{copy.previewMasthead}</p>
            <span className="rd-export-sheet-mastrule" />
            <p className="rd-export-sheet-title">{copy.previewTitle}</p>
            <p className="rd-export-sheet-byline">{copy.previewByline}</p>
            <span className="rd-export-sheet-rule" />
            <div className="rd-export-sheet-notice">
              <b>{copy.previewNotice}</b>
              <i /><i style={{ width: '76%' }} />
            </div>
            <span className="rd-export-sheet-rule" />
            <p className="rd-export-sheet-section">1&nbsp;&nbsp;{copy.previewSection}</p>
            <p className="rd-export-sheet-origin">{copy.previewOrigin}</p>
            <div className="rd-export-sheet-lines">
```

El resto del bloque (`rd-export-sheet-lines`, `rd-export-sheet-marked`, `rd-export-sheet-notes`) se queda como está: sigue respondiendo a las casillas, que es lo que hace que la vista previa valga para algo.

- [ ] **Step 2: Copys nuevos**

En `PaperReader.jsx`, junto a `previewTitle`/`previewByline`/`previewSection`, añadir en el bloque español:

```js
    previewMasthead: 'PaperTok · versión en lenguaje sencillo',
    previewNotice: 'Aviso',
    previewOrigin: '§1 Introduction',
```

y en el inglés:

```js
    previewMasthead: 'PaperTok · plain-language version',
    previewNotice: 'Notice',
    previewOrigin: '§1 Introduction',
```

`previewOrigin` no se traduce a propósito: el encabezado original está en el idioma del paper, no en el del lector. Pasarlos por el objeto que ya baja a `ExportCard` (`PaperReader.jsx:1567-1570`).

- [ ] **Step 3: Estilos de la miniatura**

En `Export.css`, junto a las reglas que ya hay:

```css
.rd-export-sheet-mast {
  font: var(--mono-label);
  font-size: 0.34rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-tertiary);
  margin: 0;
}
.rd-export-sheet-mastrule { display: block; height: 1px; background: var(--text-primary); margin: 2px 0 6px; }
.rd-export-sheet-notice { display: flex; gap: 5px; align-items: flex-start; margin: 4px 0; }
.rd-export-sheet-notice b {
  flex: 0 0 auto;
  font: var(--mono-label);
  font-size: 0.32rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-tertiary);
}
.rd-export-sheet-origin {
  font: var(--mono-label);
  font-size: 0.32rem;
  color: var(--text-tertiary);
  margin: 1px 0 3px;
}
```

Y en `.rd-export-sheet-title`, quitar el `text-align: center` si lo lleva: la portada va en bandera.

El amarillo de la miniatura (`.rd-export-sheet-marked i[data-on]`, `Export.css:293`) pasa de `var(--brand-yellow)` a `var(--brand-yellow-soft)`, y `i[data-ai]` pierde el fondo y se queda en un `border-bottom: 1px dotted var(--text-tertiary)`: la miniatura enseña los dos mecanismos nuevos, no los dos fondos viejos.

- [ ] **Step 4: Verificar en el navegador**

Levantar el dev server, abrir un paper con resumen y anotaciones, abrir la tarjeta de descarga y comprobar que la miniatura se parece a `design/export-rediseno/Main.dc.html` y que sigue respondiendo a las tres casillas y al selector de formato.

- [ ] **Step 5: Commit**

```bash
git add src/components/Reader/ExportCard.jsx src/components/Reader/Export.css src/components/Reader/PaperReader.jsx
git commit -m "feat(card): la vista previa dibuja la separata y no el documento anterior"
```

---

### Task 11: Verificación en vivo del PDF

**Files:** ninguno, salvo que aparezca un fallo.

- [ ] **Step 1: Levantar el dev server y generar un PDF de verdad**

Abrir un paper con resumen generado y al menos cuatro anotaciones —dos del lector con nota, una de la IA, una marca sin nota— repartidas en secciones distintas, y descargar el PDF.

- [ ] **Step 2: Mirar el fichero, no la pantalla**

Comprobar en el PDF descargado:
- Página 1: cabecera de identidad con filete grueso; título en bandera; aviso con etiqueta.
- Página 2 en adelante: titulillo con el artículo a la izquierda y la sección en curso a la derecha, con filete fino.
- **Una sección que empieza a mitad de página cambia el titulillo de ESA página**; una que continúa desde la anterior mantiene el suyo.
- Cada nota al pie está en la página donde cayó su marca, no todas en la última.
- El lavado amarillo y el punteado se distinguen, y siguen distinguiéndose al imprimir en escala de grises.
- El colofón sale entero y no partido entre dos páginas.
- Ningún párrafo recortado por abajo.

- [ ] **Step 3: Comprobar el caso que rompe paginadores**

Un documento de una sola sección corta, que cabe entero en una página: no debe generar una segunda página vacía con solo el colofón. Y un documento sin ninguna anotación: no debe dibujar el filete de notas.

- [ ] **Step 4: `npm run check`**

Run: `npm run check`
Expected: PASS entero.

- [ ] **Step 5: Commit de lo que haya salido**

Si la verificación no encontró nada, no hay commit. Si encontró algo, arreglarlo y commitear con mensaje propio.

---

### Task 12 (separable): fórmulas destacadas numeradas

`Main2.dc.html` enseña la fórmula con un `(1)` a la derecha, para poder citarla. **Es la única parte del diseño que se puede dejar fuera sin que la separata deje de serlo**, y es la más arriesgada: en LaTeX obliga a reescribir el delimitador que el modelo escribió, y `emitMath` existe precisamente porque re-envolver `raw` ya rompió un párrafo entero una vez (el comentario que lo cuenta está en `latexExport.js`, en `emitMath`). Si hay que recortar algo del plan, es esta tarea.

**Files:**
- Modify: `src/utils/latexExport.js` (`emitMath`)
- Modify: `src/utils/pdfExport.js` (`renderParagraphInto`, `PAGE_CSS`)
- Test: `src/utils/latexExport.test.js`, `src/utils/pdfExport.test.js`

- [ ] **Step 1: Escribir el test que falla**

```js
test('una fórmula en bloque sale numerada y una en línea no', () => {
  const display = paragraphChunks('Queda $$a = b$$ demostrado.').find(item => item.display);
  assert.ok(display, 'el fixture tiene que traer una fórmula en bloque');
  const { source } = buildLatexDocument({
    paper: PAPER, annotations: [],
    sections: [{ id: 's1', kind: 'other', heading: 'H', paragraphs: ['Queda $$a = b$$ demostrado.'] }],
  });
  assert.match(source, /\\begin\{equation\}/);
  assert.doesNotMatch(source, /\$\$/);
});

test('una fórmula en bloque que no es segura no se envuelve en equation', () => {
  const { source } = buildLatexDocument({
    paper: PAPER, annotations: [],
    sections: [{ id: 's1', kind: 'other', heading: 'H', paragraphs: ['Queda $$\\input{/etc/passwd}$$ ahi.'] }],
  });
  assert.doesNotMatch(source, /\\begin\{equation\}/);
  assert.match(source, /textbackslash/);
});
```

- [ ] **Step 2: Envolver solo lo que es seguro y solo si es de bloque**

```js
function emitMath(item) {
  if (!isSafeMath(item.raw)) return escapeLatexText(item.raw);
  // Solo la fórmula EN BLOQUE se numera, y solo se toca su delimitador: el
  // cuerpo va tal cual lo escribió el modelo. `item.value` es el interior sin
  // delimitadores para `$$…$$` y `\[…\]`; para un `\begin{...}` propio,
  // `value === raw` y ahí no se toca nada, que es lo que rompió la vez pasada.
  if (item.display && item.value !== item.raw) {
    return `\\begin{equation}\n${item.value}\n\\end{equation}`;
  }
  return item.raw;
}
```

Antes de implementar: comprobar contra `src/utils/latex.js` que `splitLatexText` deja `value` sin delimitadores para `$$…$$` y `\[…\]` y que `value === raw` para entornos. Si no es así, el `if` de arriba está mal y hay que ajustarlo a lo que el splitter devuelva de verdad.

- [ ] **Step 3: Numerar también en el PDF**

En `renderParagraphInto`, para un chunk con `item.display`, envolver el nodo en una fila con su número, llevando un contador por documento. Añadir a `PAGE_CSS`:

```css
.pdfx-eq { display: flex; align-items: baseline; gap: 16px; margin: 15px 0 16px; }
.pdfx-eq-b { flex: 1 1 auto; text-align: center; }
.pdfx-eq-n { flex: 0 0 auto; font-size: 15px; }
```

El contador vive en `buildBlocks`, no en `renderParagraphInto`, para que reinicie una vez por documento y no una por párrafo.

- [ ] **Step 4: Volver a pasar la puerta de compilación (Task 7)**

Con un fixture que traiga una fórmula en bloque. Mirar que el `(1)` sale a la derecha y que la numeración es correlativa.

- [ ] **Step 5: Commit**

```bash
git add src/utils/latexExport.js src/utils/pdfExport.js src/utils/latexExport.test.js src/utils/pdfExport.test.js
git commit -m "feat(export): las fórmulas en bloque salen numeradas y citables"
```

---

## Autorrevisión

**Cobertura de la especificación.** Recorriendo `Main.dc.html` y `Main2.dc.html` elemento a elemento: cabecera de identidad (T3), filete grueso (T3), título en bandera (T4), byline (T4), línea de fuente (T2, T4), filetes y aviso con etiqueta (T4), número de sección colgado (T3 `titlesec`), encabezado original (T4 en `.tex`, T8 en PDF), cuerpo a 16 px justificado con sangrado a partir del segundo párrafo (T3 `\titlespacing*` + `\ptorig`, T8 `PAGE_CSS`), lavado amarillo y punteado (T5, T8), notas al pie con etiqueta en versalitas (T3 `\ptkind`, T8 `noteEntry`), filete y procedencia al pie (T3, T9), titulillo con la sección en curso (T3 `\leftmark`, T9 segunda pasada), fórmula numerada (T12, separable), colofón (T6, T8). Sin huecos.

**Placeholders.** Ninguna tarea dice «añadir manejo de errores» ni «tests para lo anterior»: todos los pasos de código llevan el código. Los dos sitios donde el plan pide comprobar antes de escribir (el `value`/`raw` del splitter en T12 Step 2, y la aserción rara del byline en T4 Step 1) están marcados como tales, con qué mirar y qué hacer según lo que se encuentre.

**Consistencia de tipos.** `documentMeta` devuelve la misma forma en T2, T3 (`pageStyles(meta)`), T4 (`meta.title`, `meta.byline`, `meta.source`, `meta.noticeLabel`, `meta.notice`), T6 (`meta.colophon.rows`), T8 (`model.meta.*`) y T9 (`model.meta.masthead`, `.level`, `.runningTitle`, `.provenance`). `block.heading` cambia de booleano a cadena en T8 y T9 lo consume como cadena — y por eso T9 Step 2 cambia también la detección del título huérfano, que era lo único que leía el booleano. `summarizeExport` se consume con la lista ya filtrada (`kept`) en T3 y T8, igual que hace hoy `PaperReader.jsx:1034`.
