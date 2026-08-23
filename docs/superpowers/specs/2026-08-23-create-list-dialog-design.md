# Crear una lista: una ventana, compartida por los dos sitios que la crean

**Fecha:** 2026-08-23. **Estado:** diseño aprobado, pendiente de implementar.

## Por qué

Crear una lista se hace hoy desde dos sitios, con dos interfaces distintas
escritas por separado:

- **`ListsPage.jsx`** (pestaña «Mis listas»): un formulario **en línea, dentro
  de la propia tarjeta** de la rejilla. Iconos a 16 px, un `input` con solo
  *placeholder*, sin cabecera ni etiquetas. Todo apretado en un hueco del
  tamaño de un botón.
- **`SaveToListModal.jsx`**: un `<dialog>` nativo en condiciones, con cabecera
  y ✕, campos etiquetados, iconos a 22 px, nota de privacidad, Escape y clic
  en el fondo.

La divergencia no es solo estética, y esa es la razón de fondo para arreglarlo:
**cada una tiene algo que a la otra le falta**.

| | Pestaña de listas | Modal de guardar |
|---|---|---|
| Ventana propia, Escape, fondo | no | sí |
| Campos etiquetados, cabecera | no | sí |
| Aviso de error al fallar | **sí** | **no** — `console.error` y vuelve |
| Estado «Creando…» | **sí** | no |

Es decir: el modal de guardar **se traga los fallos en silencio**. El usuario
pulsa Crear, no pasa nada visible, y la ventana se queda abierta sin explicar
por qué. Ese defecto está justo en el componente que hay que extraer, así que
se arregla al extraerlo.

## Qué se construye

### `src/components/Lists/CreateListDialog.jsx` (+ `.css`)

Un `<dialog>` nativo, la forma que ya usa `SaveToListModal`, con:

- cabecera con título y botón de cerrar;
- campo **Nombre** etiquetado, `maxLength={80}`, Enter envía, Escape cierra;
- selector de **icono** etiquetado (`role="radiogroup"`), iconos a 22 px
  —el tamaño del modal de guardar, no los 16 px de la tarjeta—, sobre
  `AVAILABLE_ICONS` de `src/utils/icons.js`;
- nota de privacidad (la que ya tiene el modal de guardar);
- acciones Cancelar / Crear, con Crear deshabilitado si el nombre está vacío o
  hay un envío en vuelo;
- zona de error, con `role="alert"`.

Cierre por ✕, por clic en el fondo y por Escape, los tres por el mismo camino.
Conserva el `stopPropagation` en `onCancel`/`onClose` que hoy tiene el diálogo
incrustado: es lo que evita que Escape sobre esta ventana cierre además el
modal de guardar que la contiene. Anidado o no, el mismo código sirve.

**Interfaz:**

```
<CreateListDialog
  open={boolean}
  isEnglish={boolean}
  onClose={() => void}
  onCreate={async (name, icon) => void}   // lanza si no se pudo crear
/>
```

`onCreate` es del llamante. Si resuelve, la ventana se cierra sola; si lanza,
se queda abierta y pinta el error. **Eso es todo lo que hace falta para que
Guardar deje de fallar en silencio**: basta con que su handler deje de tragarse
la excepción.

El componente **no sabe escribir en ningún sitio**. Esa frontera es lo que
impide que las dos copias vuelvan a divergir: posee el formulario y nada más.

### `src/utils/createListFormModel.js`

La máquina de estados del formulario, pura y testeada, siguiendo el patrón de
la casa (`src/utils/saveOrganizeModel.js`: «la parte que puede estar mal en
silencio vive aquí, pura y con tests, en vez de en línea en el componente»).

Aquí lo que puede estar mal en silencio son tres cosas:

1. **Un nombre en blanco no envía** (ni vacío ni solo espacios).
2. **Un segundo envío mientras el primero está en vuelo no crea dos listas.**
   La escritura usa `list_${Date.now()}` como id, así que dos envíos en el
   mismo milisegundo colisionarían y en distinto milisegundo crearían dos
   listas idénticas.
3. **Al reabrir no reaparecen** el nombre, el icono ni el error de la vez
   anterior.

Forma: un reductor `createListFormReducer(state, action)` con estado
`{ name, icon, busy, error }` y acciones `open`, `name`, `icon`, `submit`,
`failed`. `canSubmit(state)` resuelve la condición de habilitado.

No hay acción de éxito: cuando `onCreate` resuelve, el componente llama a
`onClose` y el siguiente `open` reinicia el estado. Un `failed` limpia `busy` y
enciende `error`; escribir en el nombre apaga el error, para que el reintento no
arrastre el mensaje del intento anterior.

## Qué conserva cada llamante

La escritura, entera. El componente compartido no toca Firestore.

- **`ListsPage.jsx`**: `setDoc` en `users/{uid}/lists/{listId}` (o `demoSet` en
  modo demo) y añade la lista a su estado. Se queda solo con el booleano
  `creating`; `newListName`, `newListIcon`, `createBusy` y `createError` pasan
  al componente.
- **`SaveToListModal.jsx`**: lo mismo, y además revisa su caché de sesión con
  `reviseOwnLists` y auto-marca la lista recién creada. Ese cuidado es suyo:
  `ListsPage` no lee esa caché.

## CSS

El bloque `.save-modal-create-*` de `SaveToListModal.css` (líneas ~293-440, más
la consulta de medios de ~723) se traslada al `.css` del componente nuevo con
nombres propios. El bloque `.list-card--create-form` / `.list-card-icon-*` /
`.list-card-create-*` de `ListsPage.css` (líneas ~259-340) se retira: queda
muerto.

## Tests

`node:test`, junto al módulo, como el resto del repo. No hay entorno de DOM ni
`@testing-library` en el proyecto: la lógica se prueba pura y la estructura con
guardas de texto fuente, que es el patrón ya establecido en
`src/services/publicListSync.test.js`.

- `src/utils/createListFormModel.test.js`: envío bloqueado con nombre vacío y
  con solo espacios; envío bloqueado mientras `busy`; `open` limpia nombre,
  icono y error; un `failed` seguido de escribir vuelve a habilitar el envío.
- Guarda de texto fuente: ni `ListsPage.jsx` ni `SaveToListModal.jsx` vuelven a
  declarar su propio formulario — ambos importan `CreateListDialog` y ninguno
  contiene ya `AVAILABLE_ICONS.map`.

Cada test se verifica **por mutación**: se revierte su arreglo y debe ponerse
rojo.

## Lo que deliberadamente no se toca

- **`firestore.rules`.** No se añade descripción a las listas privadas:
  `hasOnly([...])` no admite `description` hoy, y ampliarlo obliga a
  redesplegar las rules y a vigilar su presupuesto de expresiones. Decisión
  tomada con el usuario.
- **El flujo de publicar / sincronizar / despublicar.** Intacto.
- **Las dos guardas vivas de `publicListSync.test.js`**: la que prohíbe
  `updatePublicList` y `RefreshCw` en la pestaña de listas, y la que exige que
  el número de `updatedAt: serverTimestamp()` iguale al de `arrayUnion(` /
  `arrayRemove(` en ambos ficheros. La creación escribe un documento entero con
  `setDoc` y no toca la pertenencia, así que esos recuentos no se mueven — pero
  hay que comprobarlo, no suponerlo.

## Verificación

1. `npm run check` en verde y la suite bajo Node 22 (lo que corre CI).
2. Mutación de cada test nuevo.
3. En vivo, en producción: crear una lista desde la pestaña y otra desde el
   modal de guardar; comprobar Escape, clic en el fondo y ✕ en las dos; y
   comprobar que Escape sobre la ventana de crear **no** cierra el modal de
   guardar que la contiene.

## Riesgo conocido

Otra sesión de Claude está editando este mismo árbol (G3:
`worker/ai-explanation.js`, `worker/kimi-budget-ledger.js`,
`worker/request-quota-ledger.js`, `src/services/aiExplanationService.js`,
`src/components/Feed/AIExplanationSheet.jsx`). Ninguno de esos ficheros entra
en este diseño, pero **hay que commitear por nombre de fichero y revisar el
diff antes**: `git add -A` se llevaría su trabajo a medias. Está documentado en
`STATE.md` como algo que ya rompió `main` una vez.
