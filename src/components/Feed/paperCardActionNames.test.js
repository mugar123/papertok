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

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
// Los comentarios de este mismo fichero de origen explican los `aria-label`
// que se buscan abajo. Sin despojarlos, una prosa que promete el atributo
// bastaría para que la aserción pasara con el atributo borrado.
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

/** El trozo de JSX de un botón, desde su apertura hasta su `</Button>`. */
const bloque = (jsx, ancla, cierre = '</Button>') => {
  const desde = jsx.indexOf(ancla);
  assert.notEqual(desde, -1, `no encuentro «${ancla}» en PaperCard.jsx`);
  const hasta = jsx.indexOf(cierre, desde);
  assert.notEqual(hasta, -1, `«${ancla}» ya no está dentro de un ${cierre}`);
  return jsx.slice(desde, hasta);
};

/** Los literales de un ternario `isEnglish ? '…' : '…'`, o el literal suelto. */
const idiomas = (expresion) => {
  const ternario = expresion.match(/isEnglish \? '([^']*)' : '([^']*)'/);
  if (ternario) return [ternario[1], ternario[2]];
  const suelto = expresion.match(/'([^']*)'/);
  return suelto ? [suelto[1]] : [];
};

test('SOURCE: el botón principal se llama como su rótulo, que en móvil no se ve', async () => {
  const card = stripComments(await read('./PaperCard.jsx'));
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
    /<span className="pc-action-label">\{primaryActionLabel\}<\/span>/,
    'el rótulo dibujado dejó de ser `primaryActionLabel`.',
  );
  // La promesa no es «tiene aria-label», es «el nombre y el rótulo son LA MISMA
  // expresión». Así el 2.5.3 se cumple por construcción en escritorio, donde
  // el rótulo sí se lee, y no por que hoy coincidan dos literales.
  const nombre = boton.match(/aria-label=\{([^}]+)\}/)?.[1];
  const rotulo = boton.match(/<span className="pc-action-label">\{([^}]+)\}<\/span>/)?.[1];
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
  const card = stripComments(await read('./PaperCard.jsx'));
  const boton = bloque(card, 'className={`pc-action-read');
  assert.match(
    boton,
    /<span className="pc-action-label--short">\{primaryActionShortLabel\}<\/span>/,
    'el botón principal dejó de dibujar su rótulo corto en móvil',
  );
  assert.match(
    card,
    /const primaryActionLabel = isResolvingAccess\s*\?\s*\(isEnglish \? '[^']*' : '[^']*'\)\s*:\s*restingActionLabel;\s*const primaryActionShortLabel = restingActionLabel\.split\(' '\)\[0\];/,
    'la palabra corta ya no es la primera del rótulo en reposo, así que el nombre '
    + 'accesible puede dejar de contenerla (2.5.3)',
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

test('SOURCE: el botón de reescritura se llama por lo que dibuja, sin aria-label que lo contradiga', async () => {
  const card = stripComments(await read('./PaperCard.jsx'));
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
  assert.ok(idiomas(largo).length === 2, 'el rótulo largo dejó de estar en los dos idiomas');
  assert.ok(idiomas(corto).length >= 1, 'el rótulo corto dejó de tener texto');
});

test('SOURCE: el nombre del botón de autores empieza por lo que el botón enseña', async () => {
  const card = stripComments(await read('./PaperCard.jsx'));
  const boton = bloque(card, 'className="pc-authors-more"', '</button>');

  const dibujado = boton.slice(boton.lastIndexOf('>') + 1).trim();
  assert.ok(dibujado.length > 0, 'el botón de autores dejó de dibujar texto');

  const nombres = idiomas(boton.match(/aria-label=\{([\s\S]*?)\}\s*\n/)?.[1] || '');
  assert.equal(nombres.length, 2, 'el botón de autores perdió su `aria-label` en los dos idiomas');
  for (const nombre of nombres) {
    assert.ok(
      nombre.toLowerCase().includes(dibujado.toLowerCase()),
      `el nombre accesible «${nombre}» no contiene «${dibujado}», que es lo único `
      + 'escrito en el botón. Es el criterio 2.5.3: quien navega por voz dice lo que '
      + 've. Antes ponía sólo «Ver todos los autores» y axe lo cantaba como '
      + '`label-content-name-mismatch`.',
    );
  }
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
