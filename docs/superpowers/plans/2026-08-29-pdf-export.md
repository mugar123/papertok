# Exportación del resumen de IA a PDF — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La tarjeta de exportación del lector ofrece descargar el resumen de IA con anotaciones también como PDF, además del `.tex` existente.

**Architecture:** El PDF se genera íntegramente en cliente (el Worker no puede compilar LaTeX): un modelo puro y testeable (`buildPdfModel`) reutiliza el filtrado y la numeración de `latexExport.js`; un renderizador de navegador pagina el documento en divs A4 fuera de pantalla (KaTeX para las fórmulas, notas al pie de la página donde cae su marca), rasteriza cada página con `html2canvas-pro` y ensambla el fichero con `jspdf`. Ambas librerías se cargan por `import()` dinámico para no engordar el chunk de entrada (patrón ya usado con KaTeX).

**Tech Stack:** React 19, Vite 8, KaTeX (ya presente), `jspdf` (nuevo), `html2canvas-pro` (nuevo; el CSS del proyecto usa `color-mix`, que el html2canvas clásico no soporta).

**Spec:** Este documento (sección «Especificación» abajo) — el encargo es del usuario en conversación: «la función de descargar el resumen de IA con anotaciones, antes solo LaTeX, ahora también en PDF».

## Especificación

- La tarjeta de exportación (`ExportCard`) gana un selector de formato (PDF | LaTeX), con **PDF por defecto** (formato universal; el `.tex` sigue a un clic).
- El PDF replica el documento del `.tex`: título, autores (máx. 12 + «et al.»), sello de nivel, abstract de procedencia, secciones numeradas, subrayados (amarillo `#ffd21e` los del lector; gris `#f0f0f1` con subrayado de tinta los de la IA, como en la vista previa de la tarjeta), notas numeradas al pie de **su** página con etiqueta `Tuya`/`IA`, y pie de página en cada página con la procedencia + enlace al original + número de página.
- Mismos switches (`marks`/`mine`/`ai`), misma numeración y filtrado que el `.tex` (reutilizar `exportableAnnotations`, `numberAnnotations`).
- Nombre de fichero: mismo lexema que el `.tex` con extensión `.pdf`.
- Colores del PDF **fijos en hex** (papel claro), independientes del tema oscuro de la app.
- Tipografía: Newsreader (ya autoalojada) — lo que el `.tex` no podía hacer.
- Analítica: `trackEvent('paper_export', { format: 'pdf' | 'tex', ... })`.
- Generación asíncrona: botón deshabilitado y con texto «Generando…» mientras rasteriza.
- Un párrafo más alto que una página se deja en su página (se acepta el recorte; caso rarísimo).
- Sin commits: el árbol tiene cambios de otra sesión y el usuario no lo ha pedido.

## Global Constraints

- Tests con `node --test` (sin DOM): solo se testea la parte pura; la parte DOM se verifica en vivo con el dev server.
- `npm run check` debe pasar (secretos, lint, tests, build, dry-run del worker).
- Copys en es/en, como todo el lector.
- Librerías nuevas solo por `import()` dinámico dentro de la ruta de descarga.

---

### Task 1: Dependencias

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1:** `npm install jspdf html2canvas-pro`
- [ ] **Step 2:** `npm ls jspdf html2canvas-pro` para confirmar.

### Task 2: Compartir copy y nombre de fichero desde latexExport

**Files:**
- Modify: `src/utils/latexExport.js` (exportar `documentCopy`, extender `exportFileName`)
- Test: `src/utils/latexExport.test.js`

**Interfaces:**
- Produces: `documentCopy(language) → { stamp(level), abstract, provenance, mine, ai, levels, ... }`; `exportFileName(paper, language, extension = 'tex')`.

- [ ] **Step 1:** Test que falla: `exportFileName(paper, 'es', 'pdf')` acaba en `-en-simple.pdf`; `documentCopy('en').provenance` contiene «Rewritten by PaperTok».
- [ ] **Step 2:** Implementar: `export function documentCopy(language) { return COPY[language === 'en' ? 'en' : 'es']; }`; en `exportFileName`, parámetro `extension = 'tex'` y `return `${stem || 'paper'}-${suffix}.${extension}`;`.
- [ ] **Step 3:** `npm test` en verde.

### Task 3: Modelo puro del PDF

**Files:**
- Create: `src/utils/pdfExport.js`
- Test: `src/utils/pdfExport.test.js`

**Interfaces:**
- Consumes: `documentCopy`, `exportFileName`, `exportableAnnotations`, `numberAnnotations` de `latexExport.js`; `buildHighlightPlan` de `textHighlights.js` (en el renderizador, Task 4).
- Produces: `plainAuthorLine(paper, limit = 12) → string`; `buildPdfModel({ paper, sections, annotations, language, level, kindLabels, originalUrl, include }) → { title, byline, stamp, abstract, provenance, originalUrl, labels: {mine, ai}, sections: [{ label, paragraphs: [{ text, annotations }] }], noteCount, fileName }`.

- [ ] **Step 1:** Tests que fallan: filename `.pdf`; byline con 13 autores lleva «et al.»; switches `include` filtran igual que el `.tex` (ai fuera con `ai: false`; nota propia fuera con `mine: false`; subrayado pelado fuera con `marks: false`); numeración en orden de documento entre secciones; `noteCount` cuenta solo anotaciones con nota; copys es/en.
- [ ] **Step 2:** Implementar el modelo reutilizando el filtrado/numeración de `latexExport` (mismas reglas, sin escapado LaTeX).
- [ ] **Step 3:** `npm test` en verde.

### Task 4: Renderizador y descarga (DOM, sin test unitario)

**Files:**
- Modify: `src/utils/pdfExport.js`

**Interfaces:**
- Produces: `renderPdfPages(model, host) → Promise<HTMLElement[]>` (pagina el modelo en divs A4 dentro de `host`; espera KaTeX y `document.fonts.ready`); `downloadPdfDocument(model, { deliver = true } = {}) → Promise<{ blob, pageCount }>` (rasteriza con `html2canvas-pro` a escala 2, JPEG 0.92, ensambla con `jspdf` A4 y con `deliver` lanza `doc.save(model.fileName)`).

- [ ] **Step 1:** Implementar: página de 794×1123 px (A4 @96dpi), márgenes 106 px (28 mm) y 129 px abajo (34 mm); CSS embebido con colores hex; bloques título/byline/sello/abstract/heading/párrafo; llenado por bloques midiendo overflow; heading no queda huérfano al pie; notas al pie de su página con regla y etiqueta mono; pie de procedencia + página en todas.
- [ ] **Step 2:** `npm run lint` y `npm run build` en verde (chunk dinámico creado).

### Task 5: UI — formato en ExportCard y cableado en PaperReader

**Files:**
- Modify: `src/components/Reader/ExportCard.jsx`, `src/components/Reader/Export.css`, `src/components/Reader/PaperReader.jsx`

**Interfaces:**
- Consumes: `buildPdfModel`, `downloadPdfDocument` (Task 3–4); `exportFileName(paper, lang, 'pdf')` (Task 2).
- Produces: `ExportCard` recibe `onDownload(format)`, `fileNames: { pdf, tex }`, `busy`; copys nuevos `format`, `formatPdf`, `formatTex`, `downloadPdf`, `generating`.

- [ ] **Step 1:** `ExportCard`: estado local `format` (defecto `'pdf'`), control segmentado bajo las opciones, nombre de fichero y etiqueta del botón según formato, botón deshabilitado con `busy` mostrando `generating`.
- [ ] **Step 2:** `PaperReader`: `handleDownload(format)` — `'tex'` mantiene la ruta actual; `'pdf'` construye el modelo, `setExporting(true)`, `await downloadPdfDocument(model)`, `finally setExporting(false)`; `trackEvent` con el formato real.
- [ ] **Step 3:** Copys es/en nuevos; `previewNote` pasa a depender del formato.
- [ ] **Step 4:** `npm run lint && npm test && npm run build` en verde.

### Task 6: Verificación en vivo

- [ ] **Step 1:** Dev server con preview; abrir el lector de un paper con reescritura cacheada.
- [ ] **Step 2:** Harness por consola (`await import('/src/utils/pdfExport.js')` en dev): `renderPdfPages` sobre el modelo real, captura de la primera página; `downloadPdfDocument(model, { deliver: false })` → `blob.size > 0`, `pageCount ≥ 1`, cabecera `%PDF`.
- [ ] **Step 3:** UI real: abrir la tarjeta, comprobar selector, cambiar formato, botón «Descargar PDF», estado «Generando…», captura de pantalla.
- [ ] **Step 4:** `npm run check` completo.

### Task 7: Documentación de estado

**Files:**
- Modify: `STATE.md` (entrada nueva arriba: el fichero va de más nuevo a más viejo)

- [ ] **Step 1:** Añadir la entrada con fecha 2026-08-29 describiendo la exportación a PDF.
