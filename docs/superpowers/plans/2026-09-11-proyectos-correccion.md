# Proyectos: auditoría y plan de corrección

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la página de un proyecto muestre solo los papers de ESE proyecto, llegue desde la píldora del feed sin el salto skeleton→héroe, no deje un loader eterno al pie, y explique con diseño propio por qué no hay papers.

**Architecture:** Los cuatro fallos viven en tres ficheros: `src/services/openAireService.js` (consultas), `src/components/Feed/PaperCard.jsx` (la píldora) y `src/components/Explorer/EntityExplorer.jsx` (+ su CSS). El fallo de pertenencia es de datos y se corrige en el servicio y en la URL que construye la píldora; los tres de presentación se corrigen en el Explorer sin tocar el Worker ni las rules.

**Tech Stack:** React 18 + Vite, node:test (fuente y unidades), OpenAIRE HTTP API, arnés CDP de `scripts/diagnostics/` para verificar en vivo.

**Spec:** la auditoría de la sección siguiente; no hay spec aparte.

## Global Constraints

- Tests: `npm test` corre `node --test` sobre `src worker proxy`; CI es Node 22 (ver memoria «Trampas de tests en Node 22»).
- Copia bilingüe siempre (`isEnglish`), en el mismo tono editorial que el resto del Explorer.
- Animaciones: reutilizar las keyframes existentes (`slideUpFade`, `staggerFadeUp`) y respetar el bloque `prefers-reduced-motion` de `EntityExplorer.css` (línea ~2637).
- Nada de Worker ni rules: solo frontend (Vercel). Rebasar sobre `origin/main` antes de desplegar.
- No añadir bibliotecas.

---

## Auditoría (2026-09-11)

### A1. Los papers de un proyecto NO son (solo) de ese proyecto — CONFIRMADO, dato

**Causa raíz:** toda la cadena identifica el proyecto por su **código de grant a secas**, y ese código no es único entre financiadores.

- La píldora navega con `project.code` (`PaperCard.jsx:1337`), aunque `parseProjectFromResult` ya trae el id OpenAIRE en `project.id` (`rel.to.$`, forma `snsf________::…`, `openAireService.js:239`).
- `getProjectDetails(id)` consulta `search/projects?grantID=<code>&size=1` (`openAireService.js:65`) y se queda con el **primero que devuelva OpenAIRE**.
- `getPapersByProject(code)` consulta `search/publications?projectID=<code>` (`openAireService.js:261-262`) sin `funder`; solo usa `openaireProjectID` si el id lleva `::`, cosa que la píldora nunca manda.
- El parámetro `funder=` que la píldora pone en la URL solo se usa para el texto optimista (`EntityExplorer.jsx:639-642`); ninguna consulta lo recibe.

**Evidencia medida contra la API (11-09-2026):**

| Consulta | Resultado |
|---|---|
| `search/projects?grantID=100010` | 3 proyectos: NHMRC, SNSF, UKRI (mismo código) |
| `search/projects?grantID=200020` | 2 proyectos: MESTD, UKRI |
| `search/publications?projectID=100010` | **51** publicaciones (mezcla de los tres) |
| `search/publications?openaireProjectID=snsf________::daa28096…` | **39** (solo el de SNSF) |
| `search/projects?grantID=100010&funder=SNSF` | 1 proyecto (el filtro `funder` funciona) |
| `search/projects?openaireProjectID=snsf________::…` | 1 proyecto (el parámetro existe también en `projects`) |

Consecuencia: quien pulsa la píldora del proyecto SNSF 100010 ve el **héroe del proyecto NHMRC** (el primero por `grantID`) y una lista con 12 papers ajenos.

**Secundario (mismo fichero):** `searchProjects` devuelve `id: p.code || dri:objIdentifier` (`openAireService.js` ~355), así que las filas de búsqueda arrastran la misma ambigüedad.

### A2. Animación al entrar desde la píldora — CONFIRMADO, diseño

- El Explorer muestra el **skeleton completo** mientras `isLoadingEntity` (`EntityExplorer.jsx:1283`), y en la rama de proyecto ese flag solo baja **después** de `getProjectDetails` (`:674`), con plazo de 10 s. La entidad optimista de `:642` (nombre + financiador, que la píldora ya conoce) **nunca se pinta**.
- Cuando OpenAIRE contesta, el skeleton se sustituye por el héroe entero de golpe (`slideUpFade` 0.42 s sobre `.explorer-hero-content`, CSS `:238`): nombre, chips, stats y resumen llegan a la vez. Es el salto que se percibe.
- `explorerHandover.js:24-28` excluye a los proyectos del handover a propósito porque «un héroe nacido de un nombre crecería más que el skeleton». Eso vale para una fila de búsqueda; para la píldora se resuelve pintando la identidad y **reservando dentro del héroe vivo** la caja de resumen y dos celdas de stats hasta que lleguen los detalles (Tarea 4).

### A3. El loader de papers «se tira cargando un rato» — CONFIRMADO, dos causas

1. **Bucle de páginas vacías.** `setHasMore(page * 30 < total)` (`:1046`) usa el `total` de OpenAIRE, que cuenta publicaciones **con o sin pid utilizable**; `getPapersByProject` descarta las que no traen DOI ni arXiv (`:277-310`). Una página que rinde 0 papers deja `hasMore` en true, el sentinel sigue visible y el `IntersectionObserver` (`:1144-1160`) pide la siguiente en cuanto termina: el spinner «Cargando más artículos…» gira encadenando páginas vacías hasta agotar `total`.
2. **Espera larga sin señal.** Primera página: `getPapersByProject` (10 s) → arXiv + enriquecimiento + DOIs dentro de `ENTITY_PRIMARY_RENDER_BUDGET_MS = 7000` (`:62`) → failsafe del paper origen. Hasta ~17 s de filas skeleton sin ninguna frase que diga qué se espera.

### A4. Mensaje de «no se encontraron papers» — CONFIRMADO, diseño y copia

- `.explorer-empty` (`EntityExplorer.css:1469`) es un párrafo centrado con `margin-top: 64px`, sin icono, sin título ni acción y sin entrada animada.
- La copia dice siempre «No se encontraron resultados que coincidan con tu búsqueda y filtros» (`:2395-2397`), aunque no haya búsqueda ni filtro activo: para un proyecto que OpenAIRE aún no enlaza es falsa.
- Con `papersError` sí hay botón «Reintentar»; sin error no hay salida (ni «quitar filtros» ni «ver en OpenAIRE»).

### Fuera de alcance (anotado, no se toca)

- `getProjectForPaper` (la píldora en sí) consulta por DOI/pid y es correcta.
- La ruta pública `/public/entity/project/:id` recibirá el id OpenAIRE tras la Tarea 2; conviene comprobarla a mano al final.

---

## Plan

### Task 1: Consultas de OpenAIRE conscientes del financiador

**Files:**
- Modify: `src/services/openAireService.js:54-66` (`getProjectDetails`), `:251-263` (`getPapersByProject`), `~:355` (`searchProjects` id)
- Test: `src/services/openAireService.test.js`

**Interfaces:**
- Produces: `getProjectDetails(projectId, { funder } = {})` y `getPapersByProject(projectCode, page = 1, { funder } = {})`. Un id con `::` va por `openaireProjectID`; un código a secas va por `grantID`/`projectID` y añade `&funder=<funder>` si se pasa. Las claves de caché incluyen el funder.

- [ ] **Step 1: Test que falla (URLs construidas)**

```js
// añadir al final de src/services/openAireService.test.js
import { getPapersByProject } from './openAireService.js';

const emptyOpenAire = { ok: true, json: async () => ({ response: { header: { total: { $: '0' } }, results: {} } }) };
function capturingFetch(urls) { return async (url) => { urls.push(String(url)); return emptyOpenAire; }; }

test('un id de OpenAIRE consulta los detalles por openaireProjectID', async () => {
  const urls = [];
  CACHE.clear();
  await withStubbedFetch(capturingFetch(urls), () => getProjectDetails('snsf________::abc'));
  assert.match(urls[0], /openaireProjectID=snsf________%3A%3Aabc/);
  assert.doesNotMatch(urls[0], /grantID=/);
});

test('un código a secas lleva el funder a detalles y a publicaciones', async () => {
  const urls = [];
  CACHE.clear();
  await withStubbedFetch(capturingFetch(urls), async () => {
    await getProjectDetails('100010', { funder: 'SNSF' });
    await getPapersByProject('100010', 1, { funder: 'SNSF' });
  });
  assert.match(urls[0], /grantID=100010/); assert.match(urls[0], /funder=SNSF/);
  assert.match(urls[1], /projectID=100010/); assert.match(urls[1], /funder=SNSF/);
});

test('sin funder las URLs quedan como antes', async () => {
  const urls = [];
  CACHE.clear();
  await withStubbedFetch(capturingFetch(urls), () => getPapersByProject('100010', 1));
  assert.doesNotMatch(urls[0], /funder=/);
});
```

- [ ] **Step 2: Comprobar que falla**

Run: `node --test src/services/openAireService.test.js`
Expected: FAIL en los dos primeros (`grantID=` presente / `funder=` ausente).

- [ ] **Step 3: Implementación mínima**

```js
// getProjectDetails
export async function getProjectDetails(projectId, { funder = '' } = {}) {
  if (!projectId) return null;
  const isOpenAireId = projectId.includes('::');
  const cacheKey = `projectDetails_${projectId}_${isOpenAireId ? '' : funder}`;
  // ...caché igual...
  const lookup = isOpenAireId
    ? `openaireProjectID=${encodeURIComponent(projectId)}`
    : `grantID=${encodeURIComponent(projectId)}${funder ? `&funder=${encodeURIComponent(funder)}` : ''}`;
  const url = `https://api.openaire.eu/search/projects?format=json&size=1&${lookup}`;
  // ...resto igual...
}

// getPapersByProject
export async function getPapersByProject(projectCode, page = 1, { funder = '' } = {}) {
  if (!projectCode) return { arxivIds: [], dois: [], total: 0 };
  const isOpenAireId = projectCode.includes('::');
  const cacheKey = `papers_proj_${projectCode}_${isOpenAireId ? '' : funder}_${page}`;
  // ...caché igual...
  const paramName = isOpenAireId ? 'openaireProjectID' : 'projectID';
  const funderParam = !isOpenAireId && funder ? `&funder=${encodeURIComponent(funder)}` : '';
  const url = `https://api.openaire.eu/search/publications?format=json&size=30&page=${page}&${paramName}=${encodeURIComponent(projectCode)}${funderParam}`;
  // ...resto igual...
}
```

En `searchProjects`, cambiar `id: p.code?.["$"] || res.header?.["dri:objIdentifier"]?.["$"]` por `id: res.header?.["dri:objIdentifier"]?.["$"] || p.code?.["$"]` (la deduplicación sigue usando `code`).

- [ ] **Step 4: Verificar**

Run: `node --test src/services/openAireService.test.js`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add src/services/openAireService.js src/services/openAireService.test.js
git commit -m "fix(openaire): las consultas de proyecto distinguen financiador (id OpenAIRE o grantID+funder)"
```

### Task 2: La píldora del feed navega con el id de OpenAIRE

**Files:**
- Modify: `src/components/Feed/PaperCard.jsx:1330-1337`
- Modify: `src/utils/searchDestinations.js` (solo si construye la ruta de proyecto con `code`; comprobar con `grep -n project src/utils/searchDestinations.js`)
- Test: `src/components/Feed/paperCardProjectBadge.test.js` (crear, test de fuente)

**Interfaces:**
- Consumes: `project.id` (id OpenAIRE con `::`) y `project.code` de `parseProjectFromResult`.
- Produces: ruta `/explorer/project/<encodeURIComponent(project.id || project.code)>?name=…&funder=…&arxivId=…`.

- [ ] **Step 1: Test de fuente que falla**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

test('la píldora de proyecto navega con el id de OpenAIRE y cae al código solo si falta', async () => {
  const src = strip(await read('./PaperCard.jsx'));
  assert.match(src, /const projectRouteId = project\.id \|\| project\.code;/);
  assert.match(src, /\/explorer\/project\/\$\{encodeURIComponent\(projectRouteId\)\}/);
  assert.match(src, /getPublicEntityPath\('project', projectRouteId\)/);
  assert.match(src, /disabled=\{!\(project\.id \|\| project\.code\)\}/);
});
```

- [ ] **Step 2: Comprobar que falla** — `node --test src/components/Feed/paperCardProjectBadge.test.js` → FAIL.

- [ ] **Step 3: Implementar** en `PaperCard.jsx` (dentro del `onClick`, antes de `const path`):

```jsx
disabled={!(project.id || project.code)}
onClick={(e) => {
  e.stopPropagation();
  const paperId = paper.id.startsWith('arxiv:') ? paper.id.split(':')[1] : paper.id;
  const projectRouteId = project.id || project.code;
  const path = publicMode
    ? getPublicEntityPath('project', projectRouteId)
    : `/explorer/project/${encodeURIComponent(projectRouteId)}?name=${encodeURIComponent(project.acronym)}&funder=${encodeURIComponent(project.funder)}&arxivId=${paperId}`;
  // trackEvent y navigate igual
}}
```

Ajustar `title={project.code ? …}` a `title={(project.id || project.code) ? …}`.

- [ ] **Step 4: Verificar** — el test pasa; `npm run build` termina.

- [ ] **Step 5: Commit**

```bash
git add src/components/Feed/PaperCard.jsx src/components/Feed/paperCardProjectBadge.test.js src/utils/searchDestinations.js
git commit -m "fix(feed): la píldora de proyecto abre el proyecto por su id de OpenAIRE, no por el código de grant"
```

### Task 3: El Explorer pasa el financiador y mantiene el id de ruta

**Files:**
- Modify: `src/components/Explorer/EntityExplorer.jsx:637-675` (rama de entidad), `:882-888` (rama de papers)
- Test: `src/components/Explorer/explorerProjectIdentity.test.js` (crear, fuente)

**Interfaces:**
- Consumes: Task 1.
- Produces: `entity.id` = id de la ruta (estable; la clave `entityPapersRequestKey` no cambia al llegar los detalles), `entity.code` = código de grant, `entity.openaireId`.

- [ ] **Step 1: Test de fuente que falla**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

test('el proyecto se consulta con el funder de la ruta y conserva el id de ruta', async () => {
  const src = strip(await read('./EntityExplorer.jsx'));
  assert.match(src, /getProjectDetails\(id, \{ funder \}\)/);
  assert.match(src, /getPapersByProject\(resolvedId, page, \{ funder: searchParams\.get\('funder'\) \|\| entity\.funder \|\| '' \}\)/);
  assert.match(src, /id: id,\s*code: details\.id \|\| id,/, 'entity.id es el de la ruta; el código va en entity.code');
});
```

- [ ] **Step 2: Comprobar que falla.**

- [ ] **Step 3: Implementar**

```js
// rama de entidad (~:645)
const details = await getProjectDetails(id, { funder });
// ...
setEntity({
  id: id,
  code: details.id || id,
  openaireId: details.openaireId,
  // resto igual
});

// rama de papers (~:885)
const res = await getPapersByProject(resolvedId, page, { funder: searchParams.get('funder') || entity.funder || '' });
```

- [ ] **Step 4: Verificar** — test pasa; `npm test` verde. Verificación en vivo (arnés CDP, memoria «Arnés de capturas por CDP»): abrir `/#/explorer/project/snsf________%3A%3Adaa28096f9e8879ab3a02b90aa0e2f83?name=100010&funder=SNSF` y comprobar que el título es el de SNSF («Mechanistic studies of the reactions of peroxynitr…») y que en la Network solo hay peticiones con `openaireProjectID=`. Contraprueba: `/#/explorer/project/100010?name=100010&funder=NHMRC` debe dar el proyecto de amoxicilina.

- [ ] **Step 5: Commit**

```bash
git add src/components/Explorer/EntityExplorer.jsx src/components/Explorer/explorerProjectIdentity.test.js
git commit -m "fix(explorer): un proyecto se resuelve con su financiador y no se lo roba otro con el mismo código"
```

### Task 4: Héroe optimista desde la píldora (sin salto skeleton→héroe)

**Files:**
- Modify: `src/components/Explorer/EntityExplorer.jsx:637-675` (entidad), `~:1745-1790` (stats), `~:1916` (resumen)
- Modify: `src/components/Explorer/EntityExplorer.css` (una regla)
- Test: `src/components/Explorer/explorerReservation.test.js` (añadir un test de fuente)

**Interfaces:**
- Consumes: Task 3.
- Produces: `entity._detailsPending: true` en la entidad optimista; el héroe vivo pinta `ProjectSummarySkeleton` y dos celdas de stats reservadas mientras dure.

- [ ] **Step 1: Test de fuente que falla** (en `explorerReservation.test.js`)

```js
test('un proyecto llegado con nombre pinta el héroe ya y reserva dentro de él lo que aún no sabe', async () => {
  const src = strip(await read('./EntityExplorer.jsx'));
  assert.match(src, /setEntity\(\{ id, display_name: name, type: 'project', funder, _detailsPending: true \}\);\s*setIsLoadingEntity\(false\);/);
  assert.match(src, /\{type === 'project' && entity\._detailsPending && <ProjectSummarySkeleton \/>\}/);
  assert.match(src, /entity\._detailsPending && \[1, 2\]\.map\(/, 'dos celdas de stats reservadas');
});
```

- [ ] **Step 2: Comprobar que falla.**

- [ ] **Step 3: Implementar**

En la rama de entidad, sustituir la entidad optimista:

```js
if (type === 'project') {
  const name = searchParams.get('name') || '';
  const funder = searchParams.get('funder') || '';
  if (name) {
    // La píldora ya sabe cómo se llama y quién lo financia: se pinta ahora y
    // el héroe reserva por dentro el resumen y dos stats hasta que OpenAIRE conteste.
    setEntity({ id, display_name: name, type: 'project', funder, _detailsPending: true });
    setIsLoadingEntity(false);
  }
  const details = await getProjectDetails(id, { funder });
  if (isCancelled) return;
  if (details) { setEntity({ /* como en Task 3, sin _detailsPending */ }); }
  else if (!name) { setEntity({ id, display_name: id, type: 'project', funder }); }
  if (!isCancelled) setIsLoadingEntity(false);
  return;
}
```

En el grid de stats, justo antes de la primera celda `type === 'project' && entity.budget > 0`, copiar el marcado de una celda del skeleton (búscalo con `grep -n "ex-skel-stat" src/components/Explorer/EntityExplorer.jsx` y reutiliza sus clases tal cual):

```jsx
{type === 'project' && entity._detailsPending && [1, 2].map((n) => (
  <div key={`stat-reserved-${n}`} className="explorer-stat" aria-hidden="true">
    {/* mismas dos barras `ex-skel` que la celda del skeleton de página */}
  </div>
))}
```

En el bloque del resumen (`~:1916`), antes de `{type === 'project' && entity?.summary && (`:

```jsx
{type === 'project' && entity._detailsPending && <ProjectSummarySkeleton />}
```

CSS: la caja reservada dentro del héroe vivo no debe animar su propia entrada aparte del héroe:

```css
.explorer-hero-content .project-summary-box--reserved { animation: none; }
```

- [ ] **Step 4: Verificar**

- `node --test src/components/Explorer/explorerReservation.test.js` → PASS; `npm test` verde.
- En vivo (CDP, cuenta demo, memoria «Verificar con el pane oculto»): desde el feed pulsar una píldora de proyecto en frío. Medir `getBoundingClientRect().height` de `.explorer-hero` en el primer pintado y tras llegar los detalles: la diferencia debe ser la del texto del título (< 40 px); antes era el héroe entero. Comprobar con `document.getAnimations()` que solo corre el settle del héroe, no un segundo `slideUpFade`.

- [ ] **Step 5: Commit**

```bash
git add src/components/Explorer/EntityExplorer.jsx src/components/Explorer/EntityExplorer.css src/components/Explorer/explorerReservation.test.js
git commit -m "feat(explorer): el proyecto abierto desde la píldora nace con su nombre y reserva por dentro lo que falta"
```

### Task 5: Loader honesto — sin bucle de páginas vacías y con aviso de espera

**Files:**
- Modify: `src/components/Explorer/EntityExplorer.jsx:882-888`, `~:1046`, `~:2350-2366`
- Modify: `src/components/Explorer/EntityExplorer.css`
- Test: `src/components/Explorer/explorerLoading.test.js` (añadir dos tests de fuente)

**Interfaces:**
- Produces: estado `isPapersLoadSlow` (true a los 4000 ms de `isLoadingPapers && !isFetchingMore`), nodo `.explorer-loading-note`.

- [ ] **Step 1: Tests de fuente que fallan**

```js
test('una página de proyecto sin pids utilizables corta la paginación en vez de encadenar páginas vacías', async () => {
  const src = strip(await read('./EntityExplorer.jsx'));
  assert.match(src, /const usable = res\.arxivIds\.length \+ \(res\.dois \|\| \[\]\)\.length;\s*total = usable === 0 \? page \* 30 : res\.total;/);
});

test('la espera larga de la primera página se anuncia a los 4 s, en fade y bajo las filas skeleton', async () => {
  const src = strip(await read('./EntityExplorer.jsx'));
  const css = await read('./EntityExplorer.css');
  assert.match(src, /setTimeout\(\(\) => setIsPapersLoadSlow\(true\), 4000\)/);
  assert.match(src, /isLoadingPapers && !isFetchingMore && isPapersLoadSlow && \(\s*<p className="explorer-loading-note"/);
  assert.match(css, /\.explorer-loading-note \{[^}]*animation: slideUpFade/s);
});
```

- [ ] **Step 2: Comprobar que fallan.**

- [ ] **Step 3: Implementar**

Rama de papers del proyecto:

```js
if (type === 'project') {
  const res = await getPapersByProject(resolvedId, page, { funder: searchParams.get('funder') || entity.funder || '' });
  arxivIds = res.arxivIds;
  dois = res.dois || [];
  // OpenAIRE cuenta también las publicaciones sin DOI ni arXiv, que aquí se
  // descartan: una página que no rinde nada no promete la siguiente.
  const usable = res.arxivIds.length + (res.dois || []).length;
  total = usable === 0 ? page * 30 : res.total;
}
```

Estado y temporizador (junto a `isLoadingPapers`):

```js
const [isPapersLoadSlow, setIsPapersLoadSlow] = useState(false);
useEffect(() => {
  if (!(isLoadingPapers && !isFetchingMore)) { setIsPapersLoadSlow(false); return undefined; }
  const handle = setTimeout(() => setIsPapersLoadSlow(true), 4000);
  return () => clearTimeout(handle);
}, [isLoadingPapers, isFetchingMore]);
```

Render, justo después del `map` de filas skeleton (`~:2366`), dentro de `.explorer-grid`:

```jsx
{isLoadingPapers && !isFetchingMore && isPapersLoadSlow && (
  <p className="explorer-loading-note" role="status">
    {type === 'project'
      ? (isEnglish ? 'Asking OpenAIRE for this project’s publications. It can take a few seconds.' : 'Consultando a OpenAIRE las publicaciones del proyecto. Puede tardar unos segundos.')
      : (isEnglish ? 'Still loading publications…' : 'Todavía cargando publicaciones…')}
  </p>
)}
```

CSS:

```css
.explorer-loading-note {
  padding: var(--space-4) var(--space-5) 0 var(--space-6);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  animation: slideUpFade 0.42s cubic-bezier(0.16, 1, 0.3, 1) both;
}
```

Añadir `.explorer-loading-note` a la lista del bloque `prefers-reduced-motion` que ya apaga animaciones (`~:2637`).

- [ ] **Step 4: Verificar** — tests PASS; en vivo con el DevTools throttling «Slow 3G», la nota aparece a los 4 s y desaparece con las filas; con `openaireProjectID` de un proyecto grande (el SNSF de la auditoría: 39 publicaciones, 2 páginas) el sentinel deja de girar tras la segunda página.

- [ ] **Step 5: Commit**

```bash
git add src/components/Explorer/EntityExplorer.jsx src/components/Explorer/EntityExplorer.css src/components/Explorer/explorerLoading.test.js
git commit -m "fix(explorer): la lista de un proyecto no encadena páginas vacías y avisa cuando OpenAIRE tarda"
```

### Task 6: Estado vacío con diseño propio y copia veraz

**Files:**
- Create: `src/components/Explorer/ExplorerEmptyState.jsx`
- Modify: `src/components/Explorer/EntityExplorer.jsx:2387-2400` (papers) y `~:2457-2465` (autores)
- Modify: `src/components/Explorer/EntityExplorer.css:1469-1479`
- Test: `src/components/Explorer/explorerEmptyState.test.js` (crear; unidad pura sobre la elección de variante)

**Interfaces:**
- Produces: `ExplorerEmptyState({ variant, isEnglish, onClearFilters, onRetry, errorMessage, openAireUrl })` con `variant ∈ 'error' | 'filtered' | 'project-unindexed' | 'none'`, y `export function pickEmptyVariant({ papersError, hasActiveFilters, type })`.

- [ ] **Step 1: Test unitario que falla**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickEmptyVariant } from './ExplorerEmptyState.jsx';

test('el vacío distingue error, filtros activos y proyecto sin indexar', () => {
  assert.equal(pickEmptyVariant({ papersError: 'X', hasActiveFilters: true, type: 'project' }), 'error');
  assert.equal(pickEmptyVariant({ papersError: null, hasActiveFilters: true, type: 'project' }), 'filtered');
  assert.equal(pickEmptyVariant({ papersError: null, hasActiveFilters: false, type: 'project' }), 'project-unindexed');
  assert.equal(pickEmptyVariant({ papersError: null, hasActiveFilters: false, type: 'author' }), 'none');
});
```

Nota: el fichero exporta JSX; para que `node --test` lo importe, poner `pickEmptyVariant` en `src/components/Explorer/explorerEmptyVariant.js` (sin JSX) y que `ExplorerEmptyState.jsx` lo reexporte. El test importa de `./explorerEmptyVariant.js`.

- [ ] **Step 2: Comprobar que falla.**

- [ ] **Step 3: Implementar**

`src/components/Explorer/explorerEmptyVariant.js`:

```js
export function pickEmptyVariant({ papersError, hasActiveFilters, type }) {
  if (papersError) return 'error';
  if (hasActiveFilters) return 'filtered';
  if (type === 'project') return 'project-unindexed';
  return 'none';
}
```

`src/components/Explorer/ExplorerEmptyState.jsx`:

```jsx
import { Briefcase, FileText, SearchX } from 'lucide-react';
import { Button } from '../ui/button';
export { pickEmptyVariant } from './explorerEmptyVariant.js';

const COPY = {
  filtered: {
    en: ['Nothing matches these filters', 'Loosen the search or the filters to see the full list again.', 'Clear filters'],
    es: ['Nada coincide con estos filtros', 'Afloja la búsqueda o los filtros para volver a ver la lista completa.', 'Quitar filtros'],
  },
  'project-unindexed': {
    en: ['OpenAIRE has not linked publications to this project yet', 'Projects are indexed with some delay. Papers that acknowledge this grant will appear here once OpenAIRE links them.', 'View on OpenAIRE'],
    es: ['OpenAIRE aún no enlaza publicaciones con este proyecto', 'Los proyectos se indexan con retraso. Los artículos que citan esta financiación aparecerán aquí cuando OpenAIRE los enlace.', 'Ver en OpenAIRE'],
  },
  none: {
    en: ['No publications here', 'Nothing to show for this entity yet.', null],
    es: ['No hay publicaciones', 'Todavía no hay nada que mostrar para esta entidad.', null],
  },
};

export function ExplorerEmptyState({ variant, isEnglish, onClearFilters, onRetry, errorMessage, openAireUrl }) {
  const lang = isEnglish ? 'en' : 'es';
  const Icon = variant === 'filtered' ? SearchX : variant === 'project-unindexed' ? Briefcase : FileText;
  if (variant === 'error') {
    return (
      <div className="explorer-empty" role="alert">
        <span className="explorer-empty-icon"><FileText size={22} /></span>
        <h3 className="explorer-empty-title">{isEnglish ? 'The publications could not be loaded' : 'No se pudieron cargar las publicaciones'}</h3>
        <p className="explorer-empty-body">{errorMessage}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>{isEnglish ? 'Try again' : 'Reintentar'}</Button>
      </div>
    );
  }
  const [title, body, action] = COPY[variant][lang];
  return (
    <div className="explorer-empty">
      <span className="explorer-empty-icon"><Icon size={22} /></span>
      <h3 className="explorer-empty-title">{title}</h3>
      <p className="explorer-empty-body">{body}</p>
      {variant === 'filtered' && <Button variant="outline" size="sm" onClick={onClearFilters}>{action}</Button>}
      {variant === 'project-unindexed' && openAireUrl && (
        <a className="explorer-empty-link" href={openAireUrl} target="_blank" rel="noopener noreferrer">{action}</a>
      )}
    </div>
  );
}
```

En `EntityExplorer.jsx`, sustituir el bloque `:2387-2400`:

```jsx
{!isLoadingPapers && filteredPapers.length === 0 && (
  <ExplorerEmptyState
    variant={pickEmptyVariant({
      papersError,
      hasActiveFilters: Boolean(debouncedSearch) || Boolean(filters.category) || filters.peerReviewed || Boolean(filters.dateRange),
      type,
    })}
    isEnglish={isEnglish}
    errorMessage={papersError ? getUiErrorMessage(papersError, language, 'PUBLICATIONS_LOAD_FAILED') : ''}
    onRetry={retryPapers}
    onClearFilters={() => { setSearchQuery(''); setFilters({ category: '', peerReviewed: false, dateRange: '' }); }}
    openAireUrl={entity?.openaireId ? `https://explore.openaire.eu/search/project?projectId=${encodeURIComponent(entity.openaireId)}` : null}
  />
)}
```

El vacío de autores (`~:2457`) usa el mismo componente con `variant="none"` y copia propia: pasar `title`/`body` no está en la interfaz, así que añadir a `COPY` la clave `authors: { en: ['No authors matched your search', '', null], es: ['No se encontraron autores que coincidan con tu búsqueda', '', null] }` y aceptar `variant="authors"` en el mismo camino que `none` (icono `Users`).

CSS (sustituye la regla de `:1469`):

```css
.explorer-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  max-width: 440px;
  margin: 56px auto 0;
  padding: 0 var(--space-5);
  text-align: center;
  color: var(--text-secondary);
  animation: slideUpFade 0.42s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.explorer-empty-icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  margin-bottom: var(--space-1);
}
.explorer-empty-title {
  margin: 0;
  color: var(--text-primary);
  /* misma fuente que el título de una fila: copiar el `font` de `.eli-title` */
  font-size: 1.125rem;
  line-height: 1.3;
}
.explorer-empty-body { margin: 0; font-size: var(--fs-sm); line-height: 1.55; }
.explorer-empty-link { margin-top: var(--space-2); font-size: var(--fs-sm); text-decoration: underline; text-underline-offset: 3px; color: var(--text-primary); }
```

Añadir `.explorer-empty` al bloque `prefers-reduced-motion`.

- [ ] **Step 4: Verificar** — test PASS; `npm run build`; en vivo: (a) el proyecto UKRI de la auditoría (`ukri________%3A%3Adaa28096f9e8879ab3a02b90aa0e2f83`, 0 publicaciones) muestra la variante «sin indexar» con enlace a OpenAIRE; (b) escribir una búsqueda imposible en un autor muestra «Nada coincide» con «Quitar filtros» y el botón restaura la lista; (c) captura en claro y oscuro.

- [ ] **Step 5: Commit**

```bash
git add src/components/Explorer/ExplorerEmptyState.jsx src/components/Explorer/explorerEmptyVariant.js src/components/Explorer/explorerEmptyState.test.js src/components/Explorer/EntityExplorer.jsx src/components/Explorer/EntityExplorer.css
git commit -m "feat(explorer): el vacío de publicaciones dice la verdad y ofrece una salida"
```

### Cierre

- `npm test` y `npm run build` verdes; rebasar sobre `origin/main` (otra sesión puede haber tocado el árbol) y abrir PR.
- Verificación final en producción tras el despliegue de Vercel: la píldora de un paper con proyecto SNSF/NHMRC abre el proyecto correcto y la Network solo muestra `openaireProjectID=`.
