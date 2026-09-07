# Color de lista admitido por las rules — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que crear y editar una lista vuelva a guardarse en producción: las rules de Firestore admiten el campo `color` que el cliente envía desde la 0.2.

**Architecture:** El cliente ya escribe `color` en `users/{uid}/lists/{listId}` desde tres sitios (`handleCreateList` y `handleEditList` en ListsPage, `handleCreateList` en SaveToListModal) y no cambia. La regla `allow create, update` de esa colección tiene una lista cerrada de claves (`hasOnly`) sin `color`, así que rechaza las tres escrituras con `permission-denied`. Se añade `color` a la lista de claves, se valida contra los ocho ids de la paleta, se fija con tests de rules, y se despliegan las rules. El frontend no necesita despliegue.

**Tech Stack:** Firestore security rules v2, `@firebase/rules-unit-testing` con el emulador (`npm run test:rules`, necesita Java), firebase-tools 15.26.0 para desplegar.

**Spec:** La auditoría de esta misma sesión (07-09-2026). Hechos que sustentan el plan:
- Reproducido en el emulador: `updateDoc` con `name`, `emoji`, `color`, `updatedAt` → PERMISSION_DENIED en `firestore.rules:828`; la misma escritura sin `color` → permitida; `setDoc` de creación con `color` → PERMISSION_DENIED.
- Ninguno de los cuerpos de lista de `tests/firestore.rules.test.js` lleva `color`, por eso la suite pasaba.
- El `catch` de `CreateListDialog.jsx:172` descarta el error sin registrarlo.

## Global Constraints

- Los ocho ids válidos de color son exactamente los de `LIST_COLORS` en `src/utils/listColors.js`: `ochre`, `olive`, `green`, `teal`, `blue`, `indigo`, `violet`, `crimson`. Las rules no pueden importar JS; la lista se repite a mano y un test la ata a la fuente.
- `color` es OPCIONAL en el documento: las listas anteriores a la 0.2 no lo tienen y el cliente deriva uno del id (`resolveListColorId`). La regla debe seguir el patrón de `onProfile`: `!('color' in data) || <validación>`.
- Presupuesto de expresiones de las rules: una clave más en `hasOnly` y un `in [...]` de ocho valores son dos expresiones; no hay `get()` nuevos. No desenrollar bucles ni añadir `exists()`.
- Los tests de rules corren con `export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"` delante (el openjdk de Homebrew es keg-only). El comando es `npm run test:rules`; tarda unos dos minutos arrancar el emulador.
- Orden de despliegue: rules primero. El frontend ya envía `color`; no hay nada que subir a Vercel.
- El comando de despliegue está documentado en `docs/ARCHITECTURE.md:145`: `npx --yes firebase-tools@15.26.0 deploy --only firestore:rules --project papertok-168df`. Lo ejecuta el usuario (necesita su sesión de Firebase); el plan solo lo prepara y lo verifica después.
- Commits en español, tono del repo (`fix(rules): …`, `test(rules): …`), con el pie `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Las rules admiten y validan `color`

**Files:**
- Modify: `firestore.rules:828-850` (bloque `match /lists/{listId}`, regla `allow create, update`)
- Test: `tests/firestore.rules.test.js` (nuevos tests junto a los de listas, después del test `an unpublished list is created and deleted freely, as before`, línea ~2384)

**Interfaces:**
- Consumes: `reset()`, `seedPublished()`, `asAlice()`, `ALICE`, `ALICE_SHARE`, `assertFails`, `assertSucceeds`, `setDoc`, `updateDoc`, `doc`, `serverTimestamp` ya importados en el fichero de tests. `LIST_COLORS` de `src/utils/listColors.js` (import nuevo).
- Produces: la regla acepta `color` como string opcional restringido a los ocho ids. Nada más depende de ello.

- [ ] **Step 1: Escribir los tests que fallan**

Añadir al final del bloque de listas de `tests/firestore.rules.test.js` (tras el test `an unpublished list is created and deleted freely, as before`). Añadir también el import al bloque de imports de `../src/...`:

```js
import { LIST_COLORS } from '../src/utils/listColors.js';
```

Tests:

```js
// =========================================================================
// Colour of a list (0.2 palette). The client has written `color` since the
// palette landed; these are the writes it actually makes.
// =========================================================================

test('creating a list with a palette colour is allowed, from both create paths', async () => {
  await reset();
  const db = asAlice();
  // ListsPage.handleCreateList and SaveToListModal.handleCreateList write this
  // exact shape: createdAt as an ISO string, colour as a palette id.
  await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'lists', 'list_1'), {
    id: 'list_1', name: 'Nueva', emoji: 'folder', color: 'indigo',
    paperIds: [], createdAt: new Date().toISOString(),
  }));
});

test('editing name, icon and colour together is allowed, on a plain and on a published list', async () => {
  await reset();
  await seedPublished();
  const db = asAlice();
  // ListsPage.handleEditList: a partial update, `updatedAt` from the server.
  await assertSucceeds(updateDoc(doc(db, 'users', ALICE, 'lists', 'l1'), {
    name: 'Papers de mugar', emoji: 'folder', color: 'indigo', updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'lists', 'plain'), {
    id: 'plain', name: 'Sin publicar', emoji: '📚', paperIds: [], createdAt: new Date(),
  }));
  await assertSucceeds(updateDoc(doc(db, 'users', ALICE, 'lists', 'plain'), {
    name: 'Renombrada', emoji: 'star', color: 'teal', updatedAt: serverTimestamp(),
  }));
});

test('every id of the palette is accepted, and nothing outside it', async () => {
  await reset();
  const db = asAlice();
  // Ties the hand-copied list in the rules to the one the picker offers: a
  // colour added to LIST_COLORS without touching the rules fails here.
  for (const color of LIST_COLORS) {
    await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'lists', `c-${color}`), {
      id: `c-${color}`, name: 'Color', emoji: 'folder', color,
      paperIds: [], createdAt: new Date().toISOString(),
    }));
  }
  await assertFails(setDoc(doc(db, 'users', ALICE, 'lists', 'bad-1'), {
    id: 'bad-1', name: 'Color', emoji: 'folder', color: '#ff0000',
    paperIds: [], createdAt: new Date().toISOString(),
  }));
  await assertFails(setDoc(doc(db, 'users', ALICE, 'lists', 'bad-2'), {
    id: 'bad-2', name: 'Color', emoji: 'folder', color: 7,
    paperIds: [], createdAt: new Date().toISOString(),
  }));
  await assertFails(updateDoc(doc(db, 'users', ALICE, 'lists', 'c-teal'), { color: 'magenta' }));
});

test('a list without colour is still valid: the ones made before the palette', async () => {
  await reset();
  const db = asAlice();
  await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'lists', 'old'), {
    id: 'old', name: 'De antes', emoji: '📚', paperIds: [], createdAt: new Date(),
  }));
  await assertSucceeds(updateDoc(doc(db, 'users', ALICE, 'lists', 'old'), {
    name: 'Renombrada sin color', updatedAt: serverTimestamp(),
  }));
});
```

- [ ] **Step 2: Ejecutar y comprobar que fallan por la razón esperada**

```bash
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH" && npm run test:rules 2>&1 | grep -E "^(✔|✖|ℹ (pass|fail))|palette|colour"
```

Esperado: los tres primeros tests nuevos fallan con `PERMISSION_DENIED … false for 'create' @ L828` o `'update' @ L828`; el cuarto (`a list without colour…`) pasa. El resto de la suite sigue en verde. Si el cuarto falla, parar: la suite arranca de un estado distinto al esperado.

- [ ] **Step 3: Cambiar la regla**

En `firestore.rules`, dentro de `match /lists/{listId}`, regla `allow create, update`:

1. Añadir `'color'` a la lista de `hasOnly`, entre `'emoji'` y `'paperIds'`:

```
          && request.resource.data.keys().hasOnly([
            'id', 'name', 'emoji', 'color', 'paperIds', 'createdAt', 'publicShareId',
```

2. Añadir la validación justo después de la de `emoji` (`&& validString(request.resource.data.emoji, 40)`):

```
          // The 0.2 palette. Optional: lists made before it carry no colour and
          // the client derives one from the id. Ids, not hex values, and only
          // the eight the picker offers — mirrored by hand from LIST_COLORS in
          // src/utils/listColors.js; the rules test ties the two lists together.
          && (!('color' in request.resource.data)
            || request.resource.data.color in [
              'ochre', 'olive', 'green', 'teal', 'blue', 'indigo', 'violet', 'crimson'
            ])
```

- [ ] **Step 4: Ejecutar la suite entera y comprobar que pasa**

```bash
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH" && npm run test:rules 2>&1 | grep -E "^(✖|ℹ (tests|pass|fail))"
```

Esperado: `ℹ fail 0`, ningún `✖`. Si algún test anterior de listas pasa a fallar, la lista de `hasOnly` se editó mal (una coma o una comilla); revisar antes de tocar nada más.

- [ ] **Step 5: Prueba por mutación (convención del repo)**

Comprobar que los tests muerden: quitar temporalmente `'color'` de `hasOnly` con una copia de las rules y apuntar la suite a ella.

```bash
sed "s/'emoji', 'color', 'paperIds'/'emoji', 'paperIds'/" firestore.rules > /private/tmp/claude-501/-Users-nicolasmunozgarcia-Documents-papertok/88bbb53e-5674-4ddc-b177-0e1ae96d75ca/scratchpad/rules-sin-color.rules
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH" && PAPERTOK_RULES_PATH=/private/tmp/claude-501/-Users-nicolasmunozgarcia-Documents-papertok/88bbb53e-5674-4ddc-b177-0e1ae96d75ca/scratchpad/rules-sin-color.rules npm run test:rules 2>&1 | grep -E "^(✖|ℹ fail)"
```

Esperado: exactamente los tres tests nuevos con color en `✖`, `ℹ fail 3`. Si sale `fail 0`, los tests no están comprobando la regla real.

- [ ] **Step 6: Commit**

```bash
git add firestore.rules tests/firestore.rules.test.js
git commit -m "fix(rules): las listas admiten el color de la paleta que el cliente escribe desde la 0.2

Desde el 27-08 crear o editar una lista fallaba en producción con
permission-denied: el cliente envía \`color\` y la lista de claves de
users/{uid}/lists no lo tenía. Se admite como opcional, restringido a los
ocho ids de LIST_COLORS, y un test ata las dos listas.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: El diálogo registra el error que descarta

**Files:**
- Modify: `src/components/Lists/CreateListDialog.jsx:160-176` (función `submit`)
- Test: `src/components/Lists/createListDialogAccessibility.test.js` (test de fuente con `node:test`; no renderiza el componente)

**Interfaces:**
- Consumes: `stripComments` y `read` ya definidos en ese fichero de tests.
- Produces: el mismo comportamiento visible (ventana abierta con mensaje), y una línea `console.error` con el error real para que un `permission-denied` deje de disfrazarse de fallo de red.

- [ ] **Step 1: Escribir el test que falla**

El diálogo no tiene tests de render; el convenio del repo para este componente es leer la fuente despojada de comentarios y asertar sobre ella (ver el test existente en ese fichero y la memoria «endurecer los tests de fuente»). Añadir al final de `src/components/Lists/createListDialogAccessibility.test.js`:

```js
test('a failed create/save reaches the console with the real error, not only the screen', async () => {
  const jsx = await read('./CreateListDialog.jsx');
  // The catch of `submit`: it must bind the error and hand it to console.error.
  // A permission-denied from the rules and a dead connection paint the same
  // "try again"; the console is the only place that tells them apart.
  const submitCatch = jsx.match(/catch \((\w+)\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(submitCatch, 'submit() no longer has a `catch (err) {` block; update this test alongside it');
  const [, errName, body] = submitCatch;
  assert.match(body, new RegExp(`console\\.error\\([^)]*\\b${errName}\\b`));
  assert.match(body, /dispatch\(\{ type: 'failed' \}\)/);
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

```bash
node --test src/components/Lists/createListDialogAccessibility.test.js 2>&1 | grep -E "^(✔|✖|not ok|ok)|catch \(err\)" | head
```

Esperado: el test nuevo falla con `submit() no longer has a \`catch (err) {\` block` porque hoy el bloque es `catch {` sin binding.

- [ ] **Step 3: Cambiar el `catch`**

En `src/components/Lists/CreateListDialog.jsx`, función `submit`:

```js
    } catch (err) {
      // The window says "try again"; the console says why. A permission-denied
      // from the rules and a dead connection look identical on screen.
      console.error('The list could not be saved', err);
      inFlight.current = false;
      dispatch({ type: 'failed' });
    }
```

- [ ] **Step 4: Ejecutar el test de fuente y lint**

```bash
node --test src/components/Lists/createListDialogAccessibility.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npx eslint src/components/Lists/CreateListDialog.jsx
```

Esperado: `ℹ fail 0` y eslint sin salida. No hay regla `no-console` en la configuración del repo, y ListsPage ya usa `console.error` en sus propios catch.

- [ ] **Step 5: Commit**

```bash
git add src/components/Lists/CreateListDialog.jsx src/components/Lists/createListDialogAccessibility.test.js
git commit -m "fix(listas): el diálogo registra el error real cuando no puede guardar

Un permission-denied de las rules y una conexión caída se veían igual: un
«inténtalo de nuevo» sin nada en consola. Once días así.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Desplegar las rules y verificar en producción

**Files:**
- Ninguno del repo. Despliegue y verificación en vivo.

**Interfaces:**
- Consumes: `firestore.rules` del Task 1 en `main`.
- Produces: rules desplegadas; edición y creación de listas verificadas con la sesión del usuario.

- [ ] **Step 1: Confirmar que el árbol a desplegar es el bueno**

```bash
git status --short firestore.rules && git log --oneline -1 -- firestore.rules && grep -n "'emoji', 'color', 'paperIds'" firestore.rules
```

Esperado: sin cambios pendientes, el commit del Task 1 arriba, una línea con la clave `color`.

- [ ] **Step 2: Pedir el despliegue al usuario**

El despliegue necesita la sesión de Firebase del usuario; no ejecutarlo desde el agente. Entregarle el comando tal cual está en `docs/ARCHITECTURE.md`:

```bash
npx --yes firebase-tools@15.26.0 deploy --only firestore:rules --project papertok-168df
```

Esperado en su terminal: `✔ firestore: released rules firestore.rules to cloud.firestore` y `✔ Deploy complete!`. Leer su terminal con `read_terminal` si lo corre desde el panel de la app.

- [ ] **Step 3: Verificar en vivo (la sesión la pone el usuario)**

Con el usuario logueado en la app de producción, y sin pedirle credenciales:

1. Abrir una lista propia → «Edit list» → cambiar solo el nombre → Save. Esperado: la ventana se cierra y la cabecera muestra el nombre nuevo sin recargar.
2. Recargar la página. Esperado: el nombre nuevo persiste.
3. En la misma ventana cambiar icono y color → Save. Esperado: lomo de la tarjeta y cabecera con el color nuevo tras recargar.
4. Crear una lista nueva desde «Nueva lista». Esperado: aparece y persiste tras recargar.
5. Consola del navegador durante 1-4: ningún `permission-denied`.

Si el paso 1 sigue fallando: comprobar en la consola de Firebase (Firestore → Reglas) que la versión publicada contiene `'color'`; si no, el despliegue no llegó y hay que repetir el Step 2.

- [ ] **Step 4: Dejar constancia**

`STATE.md` en la raíz del repo va de más nuevo a más viejo: insertar una sección `## …` justo debajo del título `# Estado / pendientes`, por encima de la entrada del 2026-09-06, con este contenido y lo observado en el Step 3:

```markdown
## Crear y editar listas vuelve a guardarse: las rules admiten `color` (2026-09-07)

**«Al editar el nombre de una lista no me deja guardar.»** No era el nombre:
desde la 0.2 (27-08) el cliente escribe `color` en `users/{uid}/lists/{id}` y la
regla `allow create, update` tenía una lista cerrada de claves sin él, así que
Firestore contestaba `permission-denied` a crear (dos caminos) y a editar
nombre, icono o color. Reproducido en el emulador: la escritura del diálogo con
`color` cae en `firestore.rules:828`; sin `color`, pasa. La suite de rules
estaba en verde porque ningún cuerpo de lista llevaba `color`. Arreglo: `color`
admitido como opcional y restringido a los ocho ids de `LIST_COLORS`, con un
test que recorre la lista desde la fuente; el diálogo registra ahora el error
real en consola. Rules desplegadas el 07-09 y verificado en producción con la
sesión del usuario: [rellenar con lo observado en el Step 3].
```

Commit:

```bash
git add STATE.md
git commit -m "docs(estado): las rules admiten el color de lista; crear y editar listas vuelve a funcionar en producción

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- **Cobertura:** causa raíz (Task 1), mensaje sin diagnóstico (Task 2), despliegue y verificación en vivo (Task 3). Los tres caminos de escritura del cliente quedan cubiertos por los tests del Task 1 (creación con `createdAt` ISO, edición parcial con `serverTimestamp`, lista publicada vía `seedPublished`).
- **Sin placeholders:** el Task 2 Step 2 deja el render del diálogo a los helpers del fichero de tests existente porque ese fichero no se ha localizado en la auditoría; el Step 1 lo localiza primero y, si no existe, se salta el test explícitamente.
- **Consistencia:** los ocho ids en la regla coinciden letra a letra con `LIST_COLORS`; el test los recorre desde la fuente, así que una divergencia falla en vez de pasar en silencio.
