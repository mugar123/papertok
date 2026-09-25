# El preámbulo LaTeX que NASA ADS relaya se imprime como prosa — Auditoría y arreglo

**Goal:** Que un título o un abstract relayado por NASA ADS se lea como prosa con su fórmula, y no como el documento `.tex` que Springer deposita alrededor de cada fórmula. Y dejar constancia de que el arreglo del 2026-09-07 (`e1bef41`) no cubría la tarjeta para la que se escribió.

**Spec:** La tarjeta de «Quantum avalanches in ℤ₂-preserving interacting Ising Majorana chain» (10.1038/s41598-025-32723-2), reproducida más abajo con el registro real que la sirvió.

---

## Auditoría

### El síntoma

El título imprime `Quantum avalanches in <![CDATA[\documentclass[12pt]{minimal} \usepackage{amsmath} … \begin{document}{Z}_2]]> -preserving…`, y el abstract imprime el mismo preámbulo, la fórmula **centrada** en mitad del párrafo y `]]>` detrás.

### Qué fuente sirvió la tarjeta

**NASA ADS**, por `/sources/physics` (`mapAdsPaper`, `src/services/domainSourceService.js`). La tarjeta decía 2026, 1 cita y autores «Zhang, Lv, Xu, Kai, Fan, Heng», y sólo ADS da esos tres datos a la vez (OpenAlex, Crossref, S2 y PubMed dicen 2025 y 0 citas). Registro `2026NatSR..16.2819Z`, leído el 2026-09-23 a través del Worker con sesión. Su título, verbatim:

```
Quantum avalanches in <tex-math id="IEq1_TeX">&lt;![CDATA[\documentclass[12pt]{minimal} \usepackage{amsmath}
\usepackage{wasysym} \usepackage{amsfonts} \usepackage{amssymb} \usepackage{amsbsy} \usepackage{mathrsfs}
\usepackage{upgreek} \setlength{\oddsidemargin}{-69pt} \begin{document}{Z}_2]]&gt;</tex-math>-preserving interacting Ising Majorana chain
```

La forma de ADS, medida en **29 de 29 fórmulas** de una muestra de diez registros:

- un `<tex-math>` suelto: sin `<alternatives>` y sin MathML;
- los marcadores CDATA **escapados**: `&lt;![CDATA[ … ]]&gt;`;
- **sin `\end{document}`**;
- sin `$$` en los títulos (en los abstracts sí);
- `_{…}` y `^{…}` reescritos a veces como `<SUB>`/`<SUP>` **dentro** de la TeX: `$${T}_{{{{{c}}}}}<SUP>0</SUP>$$`, `$${C}<SUB>L</SUB>$$`;
- el gemelo MathML, cuando lo hay, **delante y pegado** como HTML: `T<SUB>c</SUB><SUP>0</SUP><tex-math …>`;
- el `\mathbb` perdido: `{Z}_2` donde Crossref, OpenAlex y S2 dicen `\mathbb {Z}_2`.

La misma fórmula en cada fuente:

| Fuente | Título |
|---|---|
| Crossref / OpenAlex / OpenAIRE | `$$\mathbb {Z}_2$$` — limpio |
| INSPIRE | `$\mathbb {Z}_2$` — limpio |
| Europe PMC / PubMed | `[Formula: see text]` |
| Semantic Scholar | preámbulo sin etiquetas, **con** `\end{document}` — lo cubre `e1bef41` |
| **NASA ADS** | la forma de arriba — **la de la tarjeta** |

### La causa raíz: dos capas

1. **`mapAdsPaper` aplanaba cada etiqueta a un espacio** (`normalizeText`, `src/services/domainSourceService.js:94`). Borraba el `<tex-math>` —el único límite estructural de la fórmula— y convertía los scripts en espacios: el `<SUP>0</SUP>` de dentro de la fórmula quedaba como `0` suelto y el gemelo `T<SUB>c</SUB><SUP>0</SUP>` como `T c 0`. `&lt;![CDATA[` no es una etiqueta, así que sobrevivía.
2. **El embudo no reconocía la forma** (`normalizeScientificMarkup`, `src/utils/latex.js`):
   - `CDATA_MARKER` sólo casaba el marcador literal `<![CDATA[`;
   - `STANDALONE_DOCUMENT` exige `\end{document}`, que ADS no manda, así que no desenvolvía nada;
   - las entidades se decodifican **al final**: ahí el `&lt;` se convertía en el `<` visible, después de todas las pasadas que lo habrían quitado.

   El `$${Z}_2$$` del abstract quedaba como fórmula desplazada (centrada); el título, sin `$$`, entero como prosa.

### Por qué `e1bef41` no lo cubría

Se validó contra Semantic Scholar y PMC `fullTextXML`, fuentes reales pero que no servían la tarjeta, y el test de CDATA usaba marcadores literales. El plan del 07-09 decía «no hace falta decidir cuál de las dos sirvió esta tarjeta»: era justo lo que hacía falta. La tarjeta de cupratos de aquel día (`2026NatCo..17..805T` en ADS) seguía imprimiendo el 23-09 el mismo síntoma, carácter por carácter: `temperature T c 0 <![CDATA[\documentclass…`. Y su `T c 0` no era el MathML sangrado de PubMed: era el gemelo HTML de ADS aplanado por `normalizeText`.

### Alcance

- ADS da `numFound` **2.373** para `abs:(documentclass)` en `astronomy OR physics`, casi todo Springer Nature (*Sci Rep*, *Nat Commun*…). ADS es la fuente principal de `/sources/physics`; INSPIRE sólo entra como reserva.
- Sobre 20 registros reales: 12 de 40 campos con el preámbulo visible, y 30 de 30 fórmulas centradas.
- Consumidores dañados: tarjeta (título y abstract), lector, resaltados, `aria-label` de `EntityExplorer`, exportación (el `.tex` imprimía `\textless{}![CDATA[\textbackslash{}documentclass…`), la entrada de «Read in plain words» (`cleanText` sólo recorta) y los resúmenes de las listas (`SaveToListModal` guarda `abstract.substring(0, 500)`, y en este paper el corte cae dentro del preámbulo).
- Del mismo mapper, sin preámbulo de por medio: `{C}<SUB>L</SUB>` salía como `C L` y `La2<SUB>-x</SUB>Sr<SUB>x</SUB>CuO<SUB>4</SUB>` como `La2 -x Sr x CuO 4`.

---

## Arreglo

- [x] **Embudo** (`src/utils/latex.js`):
  - `CDATA_SECTION` y `CDATA_MARKER` reconocen también el marcador escapado;
  - una sección CDATA cierra su documento en su propio cierre, nunca al final del texto, que se llevaría el resto del abstract como fórmula;
  - los `<SUB>`/`<SUP>` de dentro de la fórmula se leen como `_{}`/`^{}`;
  - el gemelo se busca a través de etiquetas, pero sólo pegado: nunca a través de espacios, o `the ` perdería su `e` ante una fórmula `e` sin gemelo.

  Cubre también las copias ya guardadas.
- [x] **`mapAdsPaper`**: título y abstract pasan por `normalizeScientificMarkup` en vez de `normalizeText`. Sin esto, el embudo no puede recuperar ni los scripts ni el gemelo, y quedaba `Z₂ -preserving` con un espacio de más.
- [x] Tests con fixtures reales de ADS (siete en `latex.test.js` y uno en `domainSourceService.test.js`), vistos fallar antes del arreglo.

## Verificación

- Los ocho tests nuevos fallaron sobre HEAD mostrando el `<![CDATA[` visible, y pasan con el arreglo.
- Mutación sobre el código final: nueve roturas probadas, todas detectadas: no reconocer el escapado, no cerrar el documento, no traducir scripts, gemelo sin atravesar etiquetas, gemelo a través de espacios, fórmula sin recortar, marcador huérfano, título aplanado otra vez y abstract aplanado otra vez. Dos piezas que ninguna rotura delataba se quitaron por no responder a ninguna forma real: un pase de `<tex-math>` suelto y un bucle para scripts anidados.
- Registros reales, 20 de ADS: 0 campos con preámbulo, 31 fórmulas y todas inline, 0 errores de KaTeX. Exportación `.tex` limpia.
- `npm test` 2963/2963, lint del árbol trackeado, `npm run build` y `wrangler deploy --dry-run` en verde. `npm run check` se detiene en el lint por seis errores dentro de `.claude/worktrees/landing-papertok/`, un worktree sin trackear de la landing retirada.
- **Sin verificar**: la tarjeta en el feed real con sesión (hace falta que el feed de física traiga un registro de ADS con fórmula), el lector y la exportación desde la interfaz.

## Fuera del alcance (y por qué)

- **El `\mathbb` perdido en ADS**: sale Z₂ y no ℤ₂. Sólo tiene arreglo prefiriendo el título o el abstract de otra fuente al deduplicar por DOI, y eso mueve mucho más que este bug.
- **Copias guardadas con el mapper viejo**: pierden el preámbulo, pero conservan el gemelo `T c 0` y los superíndices que ya se aplanaron. No se recuperan sin volver a pedir el registro.
- **`SaveToListModal` recorta el abstract crudo** a 500 caracteres antes de normalizarlo. Debería normalizar primero.
- **`navigator.share`** usa `paper.title` crudo (`PaperCard.jsx`).
- **Los demás mappers de dominio** (OSTI, NASA NTRS, CORE, INSPIRE) usan el mismo `normalizeText` que aplana a espacios, y Scopus tiene el suyo. Sin medir.
- **La línea de autores** de ADS («Zhang, Lv, Xu, Kai, Fan, Heng») junta con comas nombres «Apellido, Nombre». No es LaTeX.

## Cómo se midió

`/sources/physics` va con ID token, y la web de ADS tiene captcha. Se leyó desde una pestaña propia en segundo plano de la Chrome de sondas, sobre `http://localhost:5174/robots.txt` (el origen con la sesión, sin arrancar el feed ni escribir en la cuenta), con `import()` de `firebase.js` y `workerApiClient.js` y una sola llamada a `authenticatedWorkerFetch`. Tres lecturas en total: el paper, `q=documentclass` para el alcance y el paper de cupratos.
