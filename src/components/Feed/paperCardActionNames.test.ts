import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Los nombres de la barra de acciones de la tarjeta, y por qué se rompieron.
 *
 * `display: none` no esconde texto: lo BORRA del árbol de accesibilidad. En
 * móvil `.pc-action-label` es `display: none`, así que el botón principal —el
 * que abre el paper— se quedaba sin nombre ninguno: axe cantó `button-name`,
 * crítico, quince nodos por pantalla, el 18-09-2026. Nada lo delataba mirando
 * la pantalla, porque el icono sigue ahí y el botón sigue funcionando con el
 * dedo.
 *
 * La otra mitad es el criterio 2.5.3 (Label in Name): donde el botón SÍ
 * enseña texto, el nombre accesible tiene que contenerlo, o quien maneja la
 * interfaz por voz dice lo que lee y no acciona nada. Estas pruebas leen del
 * propio fuente qué dibuja cada botón y qué nombre declara, y comprueban la
 * relación entre las dos cosas en vez de fijar un literal: cambiar el rótulo
 * sin cambiar el nombre tiene que fallar aquí.
 */

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');
// Los comentarios de este mismo fichero de origen explican los `aria-label`
// que se buscan abajo. Sin despojarlos, una prosa que promete el atributo
// bastaría para que la aserción pasara con el atributo borrado.
const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

/** El trozo de JSX de un botón, desde su apertura hasta su `</Button>`. */
const bloque = (jsx: string, ancla: string, cierre = '</Button>') => {
  const desde = jsx.indexOf(ancla);
  assert.notEqual(desde, -1, `no encuentro «${ancla}» en PaperCard.tsx`);
  const hasta = jsx.indexOf(cierre, desde);
  assert.notEqual(hasta, -1, `«${ancla}» ya no está dentro de un ${cierre}`);
  return jsx.slice(desde, hasta);
};

/** The string literal of an expression (the interface is English-only). */
const idiomas = (expresion: string) => {
  const suelto = expresion.match(/'([^']*)'/);
  return suelto ? [suelto[1]] : [];
};

test('SOURCE: el botón principal se llama como su rótulo, que en móvil no se ve', async () => {
  const card = stripComments(await read('./PaperCard.tsx'));
  const boton = bloque(card, 'className={`pc-action-read');
  assert.match(boton, /onClick=\{handleOpenPaper\}/, 'el ancla ya no cae en el botón que abre el paper');

  assert.match(
    boton,
    /aria-label=\{primaryActionLabel\}/,
    'el botón que abre el paper perdió su `aria-label`. Su único texto vive en '
    + '`.pc-action-label`, que PaperCard.css pone a `display: none` por debajo de '
    + '640 px, y un texto en `display: none` no está en el árbol de accesibilidad: '
    + 'el botón se queda sin nombre y axe lo canta como `button-name`, crítico.',
  );
  assert.match(
    boton,
    /<span key=\{[^}]*\} className=\{`pc-action-label\$\{[^}]*\}`\}>\{primaryActionLabel\}<\/span>/,
    'el rótulo dibujado dejó de ser `primaryActionLabel`.',
  );
  // La promesa no es «tiene aria-label», es «el nombre y el rótulo son LA MISMA
  // expresión». Así el 2.5.3 se cumple por construcción en escritorio, donde
  // el rótulo sí se lee, y no por que hoy coincidan dos literales.
  const nombre = boton.match(/aria-label=\{([^}]+)\}/)?.[1];
  const rotulo = boton.match(/<span key=\{[^}]*\} className=\{`pc-action-label\$\{[^}]*\}`\}>\{([^}]+)\}<\/span>/)?.[1];
  assert.equal(
    nombre,
    rotulo,
    'el nombre accesible del botón principal y su rótulo visible ya no salen de la '
    + 'misma expresión. En cuanto se separan pueden decir cosas distintas, y en '
    + 'escritorio —donde el rótulo se ve— eso es un fallo de 2.5.3: el nombre tiene '
    + 'que CONTENER lo que se lee.',
  );
});

/**
 * En móvil el botón principal enseña una palabra (23-09-2026): era la única
 * acción de la barra sin rótulo, y el mismo icono servía para leer aquí y para
 * salir a la fuente. El 2.5.3 exige que el nombre contenga esa palabra, y se
 * cumple por construcción: la palabra es la primera del rótulo en reposo, que
 * es el nombre salvo mientras se busca acceso — y entonces la palabra se
 * esconde bajo el spinner, porque «Leer» no está en «Buscando acceso...».
 */
test('SOURCE: la palabra que el botón principal enseña en móvil está en su nombre', async () => {
  const card = stripComments(await read('./PaperCard.tsx'));
  const boton = bloque(card, 'className={`pc-action-read');
  assert.match(
    boton,
    /<span key=\{[^>]*\} className=\{`pc-action-label--short\$\{[^}]*\}`\}>\{primaryActionShortLabel\}<\/span>/,
    'el botón principal dejó de dibujar su rótulo corto en móvil',
  );
  assert.match(
    card,
    /const primaryActionLabel = isResolvingAccess\s*\?\s*\(?'[^']*'\)?\s*:\s*restingActionLabel;\s*const primaryActionShortLabel = libraryLabel \? restingActionLabel : restingActionLabel\.split\(' '\)\[0\];/,
    'la palabra corta ya no es la primera del rótulo en reposo (o «Via <biblioteca>» '
    + 'entero), así que el nombre accesible puede dejar de contenerla (2.5.3)',
  );

  const css = stripComments(await read('./PaperCard.css'));
  const movil = css.slice(css.indexOf('@media (max-width: 640px)'), css.indexOf('@media (max-width: 420px)'));
  assert.match(
    movil,
    /\.pc-action-read\.is-resolving \.pc-action-label--short \{\s*visibility: hidden;\s*\}/,
    'mientras se busca acceso la palabra en reposo queda a la vista, y el nombre '
    + '(«Buscando acceso...») ya no la contiene',
  );
});

/**
 * A library that has the paper is named on the button, not on the chip: the
 * button is what goes through the library, and the chip keeps telling
 * everyone what the record says ("Subscription"). Asked for on 2026-10-17,
 * after the chip had carried «Via USAL» for four days.
 */
test('SOURCE: the primary button names the library it opens the paper through', async () => {
  const card = stripComments(await read('./PaperCard.tsx'));
  assert.match(
    card,
    /const libraryLabel = currentInstitutionAccess\?\.status === 'entitled' \? institutionLabel\(institution\) : '';\s*const restingActionLabel = libraryLabel\s*\?\s*`Via \$\{libraryLabel\}`/,
    'an entitled library no longer renames the primary button',
  );
  const boton = bloque(card, 'className={`pc-action-read');
  assert.match(boton, /libraryLabel \? <GraduationCap size=\{16\} \/> : isCheckingLibrary \? null : <FileText size=\{16\} \/>/, 'the library button lost its glyph');
  assert.doesNotMatch(card, /institutionAccess: currentInstitutionAccess/, 'the chip is asking about the library again');
});

/**
 * The answer arrives on a button already on screen, so every change of its
 * face is the same push (asked for on 2026-10-17, replacing a fade that read
 * as a cut next to it): the words mount fresh per face and slide in while the
 * leaving face slides out, and a quick entitled answer pushes the record's
 * label straight out to the library's instead of waiting on "Checking".
 */
test('SOURCE: a quick library answer pushes the record\'s label out, like a slow one', async () => {
  const card = stripComments(await read('./PaperCard.tsx'));
  const boton = bloque(card, 'className={`pc-action-read');
  assert.match(card, /const actionFace = libraryLabel \? 'library' : isCheckingLibrary \? 'checking' : 'record';/, 'the words are no longer keyed on what the button says');
  assert.match(boton, /key=\{actionFace\} className=\{`pc-action-label\$\{actionFaceClass\}`\}/, 'the long word no longer mounts fresh per face');
  assert.match(boton, /key=\{`\$\{actionFace\}-short`\} className=\{`pc-action-label--short\$\{actionFaceClass\}`\}/, 'the short word no longer mounts fresh per face');
  assert.match(
    card,
    /if \(checkingSince\) push\('checking', entitled \? 'forward' : 'back'\);\s*else if \(entitled\) push\('record', 'forward'\);/,
    'a quick entitled answer no longer pushes, so it lands with a different movement than a slow one',
  );
  const css = stripComments(await read('./PaperCard.css'));
  assert.doesNotMatch(css, /pc-action-swap/, 'the fade that the push replaced is back');
});

/**
 * A library that takes a while to answer says so (2026-10-17): "Checking"
 * pushes the record's label out, and the answer pushes "Checking" out to the
 * library or back to the record's label. Once up, "Checking" stays for a
 * minimum before the answer replaces it, so a late-but-quick answer does not
 * flash it (asked for on 2026-10-17). "Checking" is the resting label for
 * that while, so it is also the button's name (2.5.3, checked above), on the
 * phone too. The leaving face is a decorative copy, and under reduced motion
 * the faces only cross-fade and the band stops.
 */
test('SOURCE: a slow library lookup says "Checking", named and pushed', async () => {
  const card = stripComments(await read('./PaperCard.tsx'));
  assert.match(
    card,
    /const restingActionLabel = libraryLabel\s*\?\s*`Via \$\{libraryLabel\}`\s*:\s*isCheckingLibrary\s*\?\s*\(?'Checking'\)?\s*:\s*recordActionLabel;/,
    '"Checking" is no longer the resting label while the library is asked, so the name can stop containing it',
  );
  assert.match(
    card,
    /if \(checkingSince\) settle = setTimeout\(answer, Math\.max\(0, LIBRARY_CHECKING_MIN_MS - \(Date\.now\(\) - checkingSince\)\)\);\s*else answer\(\);/,
    'the answer replaces "Checking" however briefly it has been on screen',
  );
  assert.match(card, /clearTimeout\(settle\);/, 'a held answer still lands after the card is left or another paper takes its place');
  const boton = bloque(card, 'className={`pc-action-read');
  assert.match(boton, /data-push=\{actionPush\?\.dir\}/, 'the button no longer says which way it is pushing');
  assert.match(boton, /className="pc-action-out"\s*aria-hidden="true"/, 'the leaving face is read out again by assistive tech');

  const css = stripComments(await read('./PaperCard.css'));
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {', css.indexOf('.pc-action-checking {')));
  assert.match(reduced, /\.pc-action-read\[data-push\] > :not\(\.pc-action-out, \.spinning\) \{\s*animation: fadeIn [^;]*;\s*\}/, 'reduced motion still slides the arriving face');
  assert.match(reduced, /\.pc-action-out \{\s*animation: fadeOut [^;]*;\s*\}/, 'reduced motion still slides the leaving face');
  assert.match(reduced, /\.pc-action-checking \{\s*animation: none;/, 'reduced motion still sweeps the band across "Checking"');
  const movil = css.slice(css.indexOf('@media (max-width: 640px)'), css.indexOf('@media (max-width: 420px)'));
  assert.match(movil, /\.pc-action-read svg:not\(\.spinning\) \{\s*display: none;\s*\}/,
    'on the phone the leaving face shows the glyph the arriving one hides');
});

test('SOURCE: el botón de reescritura se llama por lo que dibuja, sin aria-label que lo contradiga', async () => {
  const card = stripComments(await read('./PaperCard.tsx'));
  const boton = bloque(card, '<Button\n                variant="brand"');

  assert.doesNotMatch(
    boton,
    /aria-label=/,
    'volvió el `aria-label` al botón de reescritura. Este botón dibuja DOS rótulos y '
    + 'enseña uno u otro según el ancho, así que ningún `aria-label` fijo puede '
    + 'contener a los dos: el que había («Leer este paper en simple») no contenía a '
    + 'ninguno y fallaba 2.5.3 a 1440 y a 390. La landing ya cerró este mismo defecto '
    + 'en su copia del botón de la misma forma — ver `landing/a11y.test.js`.',
  );
  const largo = boton.match(/<span className="pc-action-label">\{([\s\S]*?)\}<\/span>/)?.[1];
  const corto = boton.match(/<span className="pc-action-label--short">\{([\s\S]*?)\}<\/span>/)?.[1];
  assert.ok(largo && corto, 'el botón de reescritura ya no dibuja sus dos rótulos');
  assert.ok(idiomas(largo).length === 1, 'the long label lost its text');
  assert.ok(idiomas(corto).length >= 1, 'el rótulo corto dejó de tener texto');
});

test('SOURCE: el nombre del botón de autores empieza por lo que el botón enseña', async () => {
  const card = stripComments(await read('./PaperCard.tsx'));
  const boton = bloque(card, 'pc-authors-more"', '</button>');

  // Lo único escrito en los puntos es el «+N»; las iniciales son decoración.
  // El nombre accesible arranca por esa misma plantilla (criterio 2.5.3:
  // quien navega por voz dice lo que ve).
  const dibujado = boton.match(/aria-hidden="true">\s*\{`(\+[^`]+)`\}/)?.[1];
  assert.ok(dibujado, 'el botón de autores dejó de dibujar el «+N»');
  const nombre = boton.match(/\? `(\+[^`]+)`/)?.[1];
  assert.ok(nombre?.startsWith(dibujado), `el nombre accesible no empieza por «${dibujado}»`);
  assert.match(boton, /aria-expanded=\{authorsExpanded\}/);
});

/**
 * El porqué del `aria-label` del botón principal, sostenido aparte: si algún
 * día el rótulo deja de esconderse en móvil, esta prueba cae y con ella la
 * excusa del atributo. Y al revés: si alguien esconde también el rótulo corto,
 * el botón de reescritura se queda mudo igual que se quedó el principal.
 */
test('el rótulo largo se esconde en móvil y el corto lo releva, que es de donde viene todo', async () => {
  const css = stripComments(await read('./PaperCard.css'));
  const movil = css.slice(css.indexOf('@media (max-width: 640px)'), css.indexOf('@media (max-width: 420px)'));
  assert.ok(movil.includes('@media (max-width: 640px)'), 'no encuentro el bloque de 640 px en PaperCard.css');

  assert.match(
    movil,
    /\.pc-action-label \{\s*display: none;\s*\}/,
    'el rótulo largo dejó de esconderse en móvil. No es un fallo por sí mismo, pero '
    + 'es la única razón por la que el botón principal necesita `aria-label`: si esto '
    + 'cambia, revisa el atributo en vez de dejarlo repitiendo texto ya visible.',
  );
  assert.match(
    movil,
    /\.pc-action-label--short \{\s*display: inline;\s*\}/,
    'el rótulo corto dejó de aparecer en móvil. Es el nombre accesible del botón de '
    + 'reescritura en esa anchura: sin él el botón se queda con el icono y sin nombre.',
  );
});

test('SOURCE: with no abstract, the read button sits in the no-abstract empty state, a size down, and leaves the bar', async () => {
  const card = stripComments(await read('./PaperCard.tsx'));
  assert.match(card, /size=\{abstractText \? 'default' : 'sm'\}/);
  assert.match(card, /title=\{'No abstract'\}\s*actions=\{readAction\}/);
  assert.match(card, /<div className="pc-action-primary">\s*\{abstractText && readAction\}/);
  assert.equal((card.match(/className=\{`pc-action-read/g) || []).length, 1, 'one button, placed in one of two spots');
});
