# El preámbulo LaTeX de JATS se imprime como prosa — Auditoría y plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un abstract que llega envuelto en el `<tex-math>` de JATS se lea como prosa con su fórmula, y no como el documento LaTeX autónomo que el editor mete alrededor de cada fórmula.

**Spec:** El bug de la tarjeta de «Persistence of vortexlike phase fluctuations in underdoped to heavily overdoped cuprates» (10.1038/s41467-025-67503-z), reproducido más abajo con datos reales de tres fuentes.

---

## Auditoría

### El síntoma

La tarjeta imprime, dentro de la prosa del abstract:

```
…transition temperature T c 0 <![CDATA[\documentclass[12pt]{minimal}
\usepackage{amsmath} \usepackage{wasysym} … \setlength{\oddsidemargin}{-69pt}
\begin{document}
```

…luego la fórmula **sí** renderizada (KaTeX, centrada), y después `]]> as a function of doping…`.

### El origen: qué manda el editor

Springer Nature deposita cada fórmula del abstract como un `<inline-formula>` con **dos representaciones alternativas** — el LaTeX y el MathML — y el LaTeX no es la fórmula suelta sino **un documento `.tex` completo y compilable**, preámbulo incluido. Verificado en PMC (`PMC12824388`, `fullTextXML`):

```xml
<inline-formula id="IEq1"><alternatives>
  <tex-math id="d33e242"><?equation-image-name d33e242.gif?><?equation-image-status READY?>
    \documentclass[12pt]{minimal}
    \usepackage{amsmath} … \setlength{\oddsidemargin}{-69pt}
    \begin{document}$${T}_{{{{\rm{c}}}}}^{0}$$\end{document}</tex-math>
  <mml:math …><mml:msubsup>…<mml:mi>T</mml:mi>…<mml:mi>c</mml:mi>…<mml:mn>0</mml:mn></mml:msubsup></mml:math>
</alternatives></inline-formula>
```

Ese mismo abstract, medido hoy en las cuatro fuentes que alimentan la app:

| Fuente | ¿Preámbulo? | ¿CDATA? | Forma |
|---|---|---|---|
| OpenAlex | no | no | `$${T}_{{{{\rm{c}}}}}^{0}$$` — limpio |
| Europe PMC | no | no | texto plano con `<sub>` |
| PubMed (efetch) | no | no | MathML con sangrado ⇒ al despojar etiquetas queda **`T c 0`** |
| **Semantic Scholar** | **sí** | no | `Tc0\documentclass…\begin{document}$${T}_c^0$$\end{document}` |

Las dos mitades del síntoma tienen fuente distinta y la app las ve juntas: el `T c 0` espaciado es MathML con sangrado despojado de etiquetas (PubMed lo produce carácter por carácter), y el preámbulo con `<![CDATA[` viene del `<tex-math>` de JATS. No hace falta decidir cuál de las dos sirvió esta tarjeta: **las dos formas existen en datos reales y ninguna se limpia hoy**.

### La causa raíz

`normalizeScientificMarkup` (`src/utils/latex.js:32`) es el único embudo por el que pasa todo lo que se pinta — `normalizeLatexText` → `splitLatexText` → `ScientificText` (tarjetas y lector), `textHighlights` y `latexExport` (PDF y .tex). Su despojador de etiquetas es:

```js
const SCIENTIFIC_MARKUP_TAG = /<\/?(?:[a-z][\w.-]*:)?[a-z][\w.-]*(?:\s[^<>]*?)?\s*\/?>/gi;
```

Exige `<` + `/` opcional + **letra**. Por eso deja intacto todo lo que empieza por `<!` o `<?`:

1. **`<![CDATA[` y `]]>`** — sobreviven como texto. El `<tex-math>` que los rodea sí se despoja, así que los marcadores quedan huérfanos en mitad de la frase.
2. **`<?equation-image-name …?>`** — las instrucciones de proceso de PMC, igual.
3. **El preámbulo** (`\documentclass`, `\usepackage`, `\setlength`, `\begin{document}`, `\end{document}`) no es marcado XML sino LaTeX: ninguna pasada lo toca, y como no va entre `$…$` se imprime como prosa. Confirmado: `grep documentclass` sobre `src/` y `worker/src/` no da un solo resultado fuera del exportador.
4. **El duplicado**: al conservar las dos ramas de `<alternatives>` se pinta la fórmula **dos veces** — una como texto aplanado del MathML (`Tc0`) y otra renderizada desde el `<tex-math>`.

Reproducido con el código actual sobre el abstract real de Semantic Scholar:

```
CHUNKS: text:"…transition temperature Tc0\documentclass[12pt]{minimal} \usepackage…\begin{document}"
        math:"{T}_{{{{\rm{c}}}}}^{0}"          ← la fórmula sí renderiza
        text:"\end{document} as a function of doping…"
```

### Alcance del daño

- **Tarjeta y lector**: párrafos ilegibles (el síntoma).
- **Exportación**: `isSafeMath` (`src/utils/latexExport.js:331`) rechaza `\documentclass` y `\usepackage` por seguridad, así que la fórmula contaminada cae al camino de texto plano y **el .tex y el PDF imprimen el preámbulo**.
- **Accesibilidad**: `EntityExplorer.jsx:2298` mete `normalizeScientificMarkup(paper.title)` en un `aria-label`; un lector de pantalla recita el preámbulo entero.

---

## Diseño de la corrección

**Capa:** `normalizeScientificMarkup`, en `src/utils/latex.js`. Es el embudo único: arreglarlo ahí cubre tarjeta, lector, resaltados, exportación y `aria-label` de una vez. Los adaptadores son seis y desiguales; el embudo es uno.

El preámbulo se desenvuelve **aquí y no en `normalizeLatexText`** aunque sea LaTeX y no XML: llega dentro del elemento `<tex-math>`, es inseparable del marcado que lo trae, y los consumidores que sólo llaman a `normalizeScientificMarkup` (títulos, `aria-label`, informes) lo quieren fuera igual.

**Orden de las pasadas** (importa: la resolución de `<alternatives>` necesita las etiquetas todavía puestas):

1. Comentarios `<!-- … -->` fuera.
2. Instrucciones de proceso `<?…?>` fuera.
3. CDATA: fuera los marcadores, **dentro se queda** (ahí vive el `<tex-math>`).
4. `<alternatives>`: si hay `<tex-math>`, se queda **sólo** ése y se tiran los hermanos. Estructural y por tanto independiente del orden en que el editor los escriba — se han visto las dos.
5. Desenvolver `\documentclass…\begin{document}CUERPO\end{document}` → `CUERPO`.
6. El resto como hasta ahora: `<br>`, etiquetas, entidades, espacios.

**El duplicado pegado** (paso 5): cuando la app recibe la forma ya despojada de etiquetas (Semantic Scholar), el paso 4 no puede actuar porque no queda `<alternatives>`. Ahí el texto aplanado del MathML llega **pegado** al preámbulo, sin espacio. La regla no puede ser «borra la palabra de delante»: medido sobre datos reales, el trozo pegado a veces es todo duplicado y a veces sólo su cola.

| Real | Delante del preámbulo | Correcto | Por qué |
|---|---|---|---|
| cuprate (S2) | `temperature Tc0` | quitar `Tc0` | `Tc0` es el MathML aplanado de `{T}_{{{\rm{c}}}}^{0}` |
| NH₃ (S2, `10.1038/s41467-024-…`) | `114.0 mgNH3` | quitar sólo `NH3` | `mg` es prosa de verdad; `NH3` aplana `{}_{{{\rm{NH}}}_3}` |

Por eso la regla es: **aplanar la fórmula que se acaba de desenvolver** (fuera comandos, llaves, `_`, `^`, `$`) y quitar esa cadena exacta **sólo si el texto anterior termina justo en ella**. Si no coincide, no se toca nada. Prototipo validado contra las tres formas reales:

- cuprate → `…temperature $${T}_{{{{\rm{c}}}}}^{0}$$ as a function…` (idéntico a la copia limpia de OpenAlex)
- NH₃ → `…114.0 mg$${}_{{{{{{\rm{NH}}}}}}_3}$$ h−1 cm−2…` (el `mg` sobrevive)
- PMC → preámbulo desenvuelto; PIs y etiquetas los quitan los pasos 1–4

## Global Constraints

- Node 22 en CI, Node 25 en local: nada exclusivo de 25.
- Tests con `node --test <fichero>`; la suite entera con `npm test`.
- Otra sesión de Claude puede estar tocando el mismo árbol: `git status --short` y `git diff` fichero a fichero antes de cada commit; `git add` sólo de lo de la tarea.
- Comentarios de código en inglés, como el resto del fichero, y que digan el motivo medido, no lo que hace la línea.
- Commits en español, trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **No desplegar**: el usuario pidió empujar, no desplegar. `git push` y parar ahí.

## Fuera del alcance (y por qué)

- **Arreglar los adaptadores uno a uno.** El embudo los cubre a todos y no hay que tocar seis ficheros.
- **Convertir la fórmula a prosa para el `aria-label`.** Que diga `$${T}_c^0$$` en vez del preámbulo entero ya es la mejora; leer LaTeX en voz alta es otro problema (y de la auditoría WCAG).
- **Pedirle a las fuentes la copia limpia** (OpenAlex la tiene). Cambiar la preferencia de fuentes mueve mucho más que este bug.

---

## Tareas

### Tarea 1 — Test que falla con los datos reales

- [ ] En `src/utils/latex.test.js`, un test por cada forma real: JATS con `<alternatives>` + CDATA + PIs, y la forma despojada de Semantic Scholar (las dos variantes de pegado: duplicado entero y sólo la cola).
- [ ] Afirmar las tres cosas: no queda `documentclass`/`usepackage`/`CDATA`/`]]>`; la fórmula sigue estando y KaTeX la renderiza sin lanzar; la prosa de verdad (`mg`) sobrevive.
- [ ] Verificar que **falla** antes de tocar `latex.js`.

### Tarea 2 — Implementar en `normalizeScientificMarkup`

- [ ] Los seis pasos del diseño, en ese orden, con un comentario que cite la forma real que justifica cada uno.
- [ ] Verificar que la suite entera pasa (`npm test`), no sólo el fichero nuevo: `textHighlights` mide desplazamientos sobre esta salida y `latexExport` decide el envoltorio con ella.

### Tarea 3 — Comprobar por mutación

- [ ] Romper a mano cada pasada nueva y confirmar que algún test se pone rojo. Una pasada que nadie vigila no está probada (convención `ce139ce`).

### Tarea 4 — Cerrar

- [ ] `npm run lint` y `npm test`.
- [ ] Commit y `git push`.
