# Onboarding de intereses — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un usuario nuevo vea, nada más registrarse, qué intereses le han quedado y cómo afinarlos; que esa siembra sea un subconjunto acotado por área que el feed sepa repartir; que ninguna lista pueda superar el tope de las rules ni dejar el onboarding en bucle; y que registrarse desde una página pública también pase por el onboarding.

**Architecture:** La respuesta del invitado (áreas) se convierte en `guestSeedCategoriesForAreas` (cinco por área, intercaladas) en vez de en todas las subcategorías. El paso 4 del onboarding muestra el recibo de esas áreas con un botón «Ajustar intereses» que abre el paso 2; el recibo se extrae a un componente `InterestsReceipt` compartido con el paso 3. `USER_PREFERENCES_MAX = 100` (el número de `firestore.rules`) cierra el paso 2, el «Empezar a explorar» y el modal de Ajustes. `completeOnboarding` escribe antes de marcar el onboarding como hecho, así que un rechazo llega a la pantalla. En el feed, `rankPreferences` rompe los empates de afinidad intercalando áreas, de modo que la ventana de cinco cubre lo que el usuario eligió. En `App.jsx`, una sesión sin onboarding en una ruta pública navega a `/onboarding` con esa página como vuelta.

**Tech Stack:** React 19 + react-router (HashRouter), Firebase Auth/Firestore, `node --test` (CI en Node 22), emulador de Firestore para las rules (`npm run test:rules`, necesita el JRE de Homebrew), Vite. Frontend desplegado por Vercel al hacer push a `main`.

**Spec:** `docs/AUDITORIA-ONBOARDING-INTERESES-2026-09-16.md` (hallazgos 1–4 y opciones A y D).

## Global Constraints

- **No repetir la pantalla de áreas** a quien ya respondió como invitado (petición de Samuel, 13-09): el onboarding sigue abriendo en el paso 4 (`useState(guestSeed ? 4 : 1)`); las áreas y categorías se alcanzan desde el botón nuevo o desde «Atrás».
- **`completeOnboarding` sigue siendo la única escritura** de las preferencias desde el onboarding; el onboarding no toca `saveGuestInterests`/`clearGuestInterests` (test SOURCE existente en `OnboardingFlow.test.js`).
- **El tope es el de las rules:** `firestore.rules:663` dice `preferences.size() <= 100`. La constante del cliente se llama `USER_PREFERENCES_MAX` y vale 100; un test la contrasta con el fichero de rules.
- **Trabajar en un worktree desde `origin/main`** (`.claude/worktrees/onboarding-intereses`, rama `feat/onboarding-intereses`): otra sesión edita el checkout principal (`feat/arxiv-compas`). Copiar `.env.local` al worktree a mano si se va a arrancar Vite (memoria `papertok-worktree-env-trap`).
- **`IS_DEMO` nunca se toca en el árbol.** Para la verificación en demo, el config de Vite del scratchpad de la Tarea 7.
- Tests: `node --test <fichero>` para uno, `npm test` para todos los de `src/`, `PATH="$(brew --prefix openjdk)/bin:$PATH" npm run test:rules` para las rules. CI corre Node 22: sin `await` colgados (memoria `papertok-node22-test-gotchas`).
- Los tests SOURCE despojan comentarios antes de casar (convención de `ce139ce`): nada de lo que se afirme puede vivir solo en un comentario.
- Comentarios en el idioma del fichero que se toca (`OnboardingFlow.jsx` mezcla; `AuthContext.jsx`, `App.jsx`, `guestInterests.js`, `FeedContext.jsx` van en inglés). Mensajes de commit en castellano, estilo del historial, con `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Sin `console.log` de depuración. Sin cambios de comportamiento fuera de lo listado (nada de «ya que estoy»).

---

### Task 1: la respuesta del invitado se convierte en cinco categorías por área, intercaladas

**Files:**
- Modify: `src/utils/guestInterests.js` (añadir tras `guestCategoriesForAreas`)
- Test: `src/utils/guestInterests.test.js`

**Interfaces:**
- Consumes: `normalizeGuestAreas(areas)` y `CATEGORIES` (ya en el fichero).
- Produces: `export const GUEST_SEED_PER_AREA = 5` y `export function guestSeedCategoriesForAreas(areas, perArea = GUEST_SEED_PER_AREA): string[]` — para cada área conocida, sus `perArea` primeras subcategorías (orden del esquema), intercaladas entre áreas: `areaA[0], areaB[0], …, areaA[1], areaB[1], …`. Áreas desconocidas se ignoran; `null` da `[]`.

- [ ] **Step 1: Write the failing tests** (añadir `GUEST_SEED_PER_AREA` y `guestSeedCategoriesForAreas` al `import { … } from './guestInterests.js'` del test, y estos dos tests al final del fichero)

```js
test('the seed takes the first five of each area, interleaved across areas', () => {
  const firstN = (area, n) => Object.keys(CATEGORIES[area].subcategories).slice(0, n);
  const seed = guestSeedCategoriesForAreas(['mech', 'physics', 'eess']);
  assert.equal(GUEST_SEED_PER_AREA, 5);
  assert.equal(seed.length, 15);
  // Taxonomy order for the areas (physics before eess before mech), and the
  // first of every area before any area's second.
  assert.deepEqual(seed.slice(0, 3), [firstN('physics', 1)[0], firstN('eess', 1)[0], firstN('mech', 1)[0]]);
  assert.deepEqual(seed.slice(3, 6), [firstN('physics', 2)[1], firstN('eess', 2)[1], firstN('mech', 2)[1]]);
  assert.deepEqual(seed.filter(id => id in CATEGORIES.physics.subcategories), firstN('physics', 5));
  assert.equal(new Set(seed).size, 15);
});

test('a small area contributes what it has, and the seed never reaches the rules cap', () => {
  assert.deepEqual(guestSeedCategoriesForAreas(['econ']), Object.keys(CATEGORIES.econ.subcategories));
  const everything = guestSeedCategoriesForAreas(Object.keys(CATEGORIES));
  assert.ok(everything.length <= 100, `${everything.length} preferences would be refused by firestore.rules`);
  assert.deepEqual(guestSeedCategoriesForAreas(['nope']), []);
  assert.deepEqual(guestSeedCategoriesForAreas(null), []);
  assert.deepEqual(guestSeedCategoriesForAreas(['cs'], 2), Object.keys(CATEGORIES.cs.subcategories).slice(0, 2));
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `node --test src/utils/guestInterests.test.js`
Expected: FAIL — `SyntaxError: The requested module './guestInterests.js' does not provide an export named 'GUEST_SEED_PER_AREA'`.

- [ ] **Step 3: Write the implementation** (en `src/utils/guestInterests.js`, justo después de `guestCategoriesForAreas`)

```js
/**
 * What a guest answer becomes when it turns into an account's `preferences`.
 *
 * Not every category of every area: the signed-in feed only sends its first
 * five preferences to arXiv and OpenAlex (three to PubMed), ranked by an
 * affinity a new account does not have yet, and its exploration step draws
 * from the siblings the preferences left out. Handing it all 26 physics
 * categories gave a physics-only first page and nothing left to explore
 * (docs/AUDITORIA-ONBOARDING-INTERESES-2026-09-16.md, hallazgo 3). So: the
 * first GUEST_SEED_PER_AREA subcategories of each area, interleaved across
 * areas — physics[0], eess[0], mech[0], physics[1], … — so that a ranking
 * with nothing to go on still spreads its window over every area picked.
 * All twelve areas make 58, well under the rules' cap of 100.
 */
export const GUEST_SEED_PER_AREA = 5;

export function guestSeedCategoriesForAreas(areas, perArea = GUEST_SEED_PER_AREA) {
  const lists = normalizeGuestAreas(areas)
    .map(key => Object.keys(CATEGORIES[key].subcategories).slice(0, perArea));
  const picked = [];
  for (let index = 0; ; index += 1) {
    let added = false;
    for (const list of lists) {
      if (index < list.length) {
        picked.push(list[index]);
        added = true;
      }
    }
    if (!added) break;
  }
  return picked;
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `node --test src/utils/guestInterests.test.js`
Expected: PASS, todos los tests del fichero (los existentes y los dos nuevos).

- [ ] **Step 5: Commit**

```bash
git add src/utils/guestInterests.js src/utils/guestInterests.test.js
git commit -m "feat(invitado): la respuesta del invitado siembra cinco categorías por área, intercaladas

No todas las subcategorías de cada área: el feed solo manda las cinco
primeras preferencias a arXiv y OpenAlex, y su exploración necesita
hermanas fuera de la lista. Doce áreas dan 58, por debajo del tope de 100
de las rules. Auditoría: docs/AUDITORIA-ONBOARDING-INTERESES-2026-09-16.md.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: el paso 4 muestra el recibo de intereses y un botón «Ajustar intereses»

**Files:**
- Modify: `src/components/Onboarding/OnboardingFlow.jsx`
- Modify: `src/components/Onboarding/OnboardingFlow.css` (sustituir las reglas `.onboarding-seed-note`)
- Test: `src/components/Onboarding/OnboardingFlow.test.js` (reescribir el test «the onboarding opens on the profile step…»)

**Interfaces:**
- Consumes: `guestSeedCategoriesForAreas` (Task 1).
- Produces: componente de módulo `InterestsReceipt({ rows, total, available, isEnglish })` en `OnboardingFlow.jsx` (no exportado), usado por los pasos 3 y 4; función `adjustInterests` en `OnboardingFlow` que hace `setSeedAdjusted(true); setStep(2);`.

- [ ] **Step 1: Rewrite the SOURCE test** (sustituir entero el test cuyo nombre empieza por `SOURCE: the onboarding opens on the profile step` en `OnboardingFlow.test.js`)

```js
test('SOURCE: the onboarding opens on the profile step, seeded from the guest answer, with the receipt in view', async () => {
  const source = await readFile(new URL('./OnboardingFlow.jsx', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /readGuestInterests\(\)/);
  // The guest already answered the interests question; the only step left
  // for them is the profile. Back still reaches the receipt and the pickers.
  assert.match(code, /useState\(guestSeed \? 4 : 1\)/, 'a guest with an answer skips straight to the profile step');
  assert.match(code, /new Set\(guestSeed \?\? \[\]\)/, 'the areas are pre-selected');
  // A bounded seed per area, not every category of the area: the feed's
  // window is five wide and its exploration needs siblings left over.
  assert.match(code, /new Set\(guestSeedCategoriesForAreas\(guestSeed \?\? \[\]\)\)/, 'the seed is the bounded per-area pick');
  assert.doesNotMatch(code, /guestCategoriesForAreas\(/, 'the full union belongs to the guest feed plan, not to the onboarding');
  // The profile step shows what came along and names the way to change it.
  assert.doesNotMatch(code, /onboarding-seed-note/, 'the one-line note is gone');
  assert.match(code, /guestSeed && \(\s*<section className="onboarding-seed-receipt"[\s\S]*?<InterestsReceipt/, 'the profile step shows the receipt of the seeded interests');
  assert.match(code, /const adjustInterests = \(\) => \{\s*setSeedAdjusted\(true\);\s*setStep\(2\);\s*\};/, 'Adjust interests opens the categories step with the areas kept');
  assert.match(code, /onClick=\{adjustInterests\}/, 'and the button is wired to it');
  // One receipt, drawn twice: the confirm step and the profile step render
  // the same component, so what the profile gets is what both show.
  assert.equal((code.match(/<InterestsReceipt/g) || []).length, 2, 'both steps use the shared receipt');
  assert.doesNotMatch(code, /className="onboarding-receipt-row"[\s\S]*className="onboarding-receipt-row"/, 'the rows are rendered in one place only');
  // The receipt is still a receipt: `completeOnboarding` is the only write,
  // so what it shows is what the profile gets.
  assert.doesNotMatch(code, /saveGuestInterests|clearGuestInterests/, 'the onboarding reads the answer; AuthContext owns its end');
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `node --test src/components/Onboarding/OnboardingFlow.test.js`
Expected: FAIL en ese test («the seed is the bounded per-area pick»); el resto del fichero en verde.

- [ ] **Step 3: Change the import and the seed** (en `OnboardingFlow.jsx`)

Sustituir

```js
import { guestCategoriesForAreas, readGuestInterests } from '../../utils/guestInterests.js';
```

por

```js
import { guestSeedCategoriesForAreas, readGuestInterests } from '../../utils/guestInterests.js';
```

y

```js
  const [selectedSubcategories, setSelectedSubcategories] = useState(() => new Set(guestCategoriesForAreas(guestSeed ?? [])));
```

por

```js
  const [selectedSubcategories, setSelectedSubcategories] = useState(() => new Set(guestSeedCategoriesForAreas(guestSeed ?? [])));
```

Actualizar también el comentario del bloque `guestSeed` (el que empieza «What this visitor said they were into…»): la frase «every category of every area they picked» pasa a «the first five categories of every area they picked (`guestSeedCategoriesForAreas`)».

- [ ] **Step 4: Extract `InterestsReceipt`** (componente de módulo, colocarlo justo antes de `export default function OnboardingFlow()`)

```jsx
/**
 * El recibo: una fila por área con cuántas categorías entran, y el total.
 * Lo pintan el paso 3 (confirmación) y el paso 4 (perfil, cuando los
 * intereses vinieron de la respuesta de invitado): un solo componente para
 * que ambos enseñen exactamente lo que `completeOnboarding` va a escribir.
 */
function InterestsReceipt({ rows, total, available, isEnglish }) {
  return (
    <div className="onboarding-receipt">
      <div className="onboarding-receipt-head">
        <span>{isEnglish ? 'Area' : 'Área'}</span>
        <span>{isEnglish ? 'Categories' : 'Categorías'}</span>
      </div>
      {rows.map(({ key, area, count, total: areaTotal, sample, rest }) => (
        <div key={key} className="onboarding-receipt-row" style={{ '--area-accent': area.gradient }}>
          <span className="onboarding-receipt-icon"><area.icon size={19} strokeWidth={1.75} /></span>
          <div className="onboarding-receipt-main">
            <div className="onboarding-receipt-name">{isEnglish ? area.labelEn : area.label}</div>
            <div className="onboarding-receipt-sample">
              {sample.join(' · ')}
              {rest > 0 && ` · +${rest} ${isEnglish ? 'more' : 'más'}`}
            </div>
          </div>
          <div className="onboarding-receipt-count">
            {count}<small>{isEnglish ? `of ${areaTotal}` : `de ${areaTotal}`}</small>
          </div>
        </div>
      ))}
      <div className="onboarding-receipt-total">
        <span>{isEnglish ? 'Total' : 'Total'}</span>
        <span className="onboarding-receipt-total-n">
          {total}<i> / {available}</i>
        </span>
      </div>
    </div>
  );
}
```

En el paso 3, sustituir el bloque que va desde `<div className="onboarding-receipt">` hasta su `</div>` de cierre (el que precede a `<span className="onboarding-receipt-note">`) por:

```jsx
              <InterestsReceipt
                rows={receipt}
                total={selectedSubcategories.size}
                available={availableSubcategories || TOTAL_SUBCATEGORIES}
                isEnglish={isEnglish}
              />
```

- [ ] **Step 5: Add `adjustInterests` and the step-4 receipt**

Añadir junto a `handleBack`:

```js
  // «Ajustar intereses» desde el paso del perfil: la selección pasa a ser
  // suya (la copia del recibo lo dice) y se abre el paso de categorías con
  // las áreas de la respuesta de invitado ya marcadas.
  const adjustInterests = () => {
    setSeedAdjusted(true);
    setStep(2);
  };
```

En el paso 4, **borrar** el bloque `{guestSeed && !seedAdjusted && (<p className="onboarding-seed-note">…</p>)}` (con su comentario «The interests were answered before the account existed…») de dentro de `.onboarding-head-copy`, y añadir esta sección entre el `</div>` que cierra `.onboarding-head` y `<VisibilityChoice`:

```jsx
            {/* Lo que vino de la respuesta de invitado, a la vista y con su
                botón: la nota de una línea que había aquí nadie la
                relacionaba con «elige tus intereses» (auditoría del 16-09). */}
            {guestSeed && (
              <section className="onboarding-seed-receipt" aria-labelledby="onboarding-seed-title">
                <div className="onboarding-seed-receipt-head">
                  <div>
                    <span className="onboarding-eyebrow" id="onboarding-seed-title">
                      {isEnglish ? 'Your interests' : 'Tus intereses'}
                    </span>
                    <p className="onboarding-seed-receipt-lede">
                      {seedAdjusted
                        ? (isEnglish
                          ? 'What you chose. Adjust it here, or any time from Settings.'
                          : 'Lo que has elegido. Ajústalo aquí, o cuando quieras desde Ajustes.')
                        : (isEnglish
                          ? `From the ${selectedAreas.size} ${selectedAreas.size === 1 ? 'area' : 'areas'} you picked as a guest: the ${selectedSubcategories.size} categories your feed starts from. Adjust them here, or any time from Settings.`
                          : `De ${selectedAreas.size === 1 ? 'el área que marcaste' : `las ${selectedAreas.size} áreas que marcaste`} como invitado: las ${selectedSubcategories.size} categorías con las que arranca tu feed. Ajústalas aquí, o cuando quieras desde Ajustes.`)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="onboarding-btn onboarding-btn--ghost"
                    onClick={adjustInterests}
                    disabled={saving}
                  >
                    {isEnglish ? 'Adjust interests' : 'Ajustar intereses'}
                  </button>
                </div>
                <InterestsReceipt
                  rows={receipt}
                  total={selectedSubcategories.size}
                  available={availableSubcategories}
                  isEnglish={isEnglish}
                />
              </section>
            )}
```

- [ ] **Step 6: Replace the CSS** (en `OnboardingFlow.css`, sustituir las dos reglas `.onboarding-seed-note` y `.onboarding-seed-note svg` por estas)

```css
/* El recibo en el paso del perfil: lo que vino de la respuesta de invitado,
   con su botón para afinarlo. Sustituye a la nota de una línea, que nadie
   relacionaba con «elige tus intereses». Reusa .onboarding-receipt del
   paso 3; aquí solo va la cabecera con el botón. */
.onboarding-seed-receipt {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.onboarding-seed-receipt-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
}

.onboarding-seed-receipt-lede {
  margin: var(--space-2) 0 0;
  max-width: 52ch;
  font-size: var(--fs-sm);
  line-height: 1.55;
  color: var(--text-secondary);
  text-wrap: pretty;
}

.onboarding-seed-receipt-head .onboarding-btn {
  flex: 0 0 auto;
}

@media (max-width: 600px) {
  .onboarding-seed-receipt-head {
    flex-direction: column;
    align-items: stretch;
  }
}
```

- [ ] **Step 7: Verify nothing else names the old note, and run the tests**

Run: `grep -rn "onboarding-seed-note" src` → sin resultados.
Run: `node --test src/components/Onboarding/OnboardingFlow.test.js src/utils/guestInterests.test.js`
Expected: PASS.
Run: `npm run lint`
Expected: sin errores nuevos (el fichero ya pasaba).

- [ ] **Step 8: Commit**

```bash
git add src/components/Onboarding/OnboardingFlow.jsx src/components/Onboarding/OnboardingFlow.css src/components/Onboarding/OnboardingFlow.test.js
git commit -m "feat(onboarding): el paso del perfil enseña el recibo de intereses y un botón para ajustarlos

Quien respondió como invitado seguía cayendo en «¿Quieres un perfil
público?» con una nota de una línea que nadie relacionaba con elegir
intereses. Ahora ve sus áreas, cuántas categorías entran de cada una, y
«Ajustar intereses» abre el paso de categorías. El recibo se extrae a
InterestsReceipt, compartido con el paso 3.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: el tope de 100 preferencias, en los dos selectores y en las rules

**Files:**
- Modify: `src/utils/accountOnboarding.js`
- Modify: `src/components/Onboarding/OnboardingFlow.jsx`
- Modify: `src/components/Settings/EditInterestsModal.jsx`
- Test: `src/utils/accountOnboarding.test.js` (añadir)
- Create: `src/components/Onboarding/interestsCap.test.js`
- Test: `tests/firestore.rules.test.js` (añadir, junto a «an old account can make every write…»)

**Interfaces:**
- Produces: `export const USER_PREFERENCES_MAX = 100` en `src/utils/accountOnboarding.js`.
- Consumes en `OnboardingFlow.jsx`: `selectedSubcategories`, `handleNext`, `canProceed`, `hint` (existentes).

- [ ] **Step 1: Write the failing tests**

Añadir a `src/utils/accountOnboarding.test.js` (import de `readFile` desde `node:fs/promises`, y `USER_PREFERENCES_MAX` al import de `./accountOnboarding.js`):

```js
test('the client cap is the rules cap, read from the rules file itself', async () => {
  const rules = await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8');
  assert.equal(USER_PREFERENCES_MAX, 100);
  assert.match(rules, new RegExp(`preferences\\.size\\(\\) <= ${USER_PREFERENCES_MAX}\\)`));
});
```

Crear `src/components/Onboarding/interestsCap.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Comments are stripped first (convention of ce139ce): a matcher that reads
// comments would be satisfied by the explanation alone.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('SOURCE: the onboarding refuses to leave the categories step, or to finish, over the cap', async () => {
  const code = stripComments(await read('./OnboardingFlow.jsx'));
  assert.match(code, /import \{ USER_PREFERENCES_MAX \} from '\.\.\/\.\.\/utils\/accountOnboarding\.js';/);
  assert.match(code, /const overCap = selectedSubcategories\.size > USER_PREFERENCES_MAX;/);
  assert.match(code, /else if \(step === 2 && selectedSubcategories\.size > 0 && !overCap\)/, 'Next on the categories step is gated');
  assert.match(code, /\(step === 2 && selectedSubcategories\.size > 0 && !overCap\)/, 'and so is canProceed');
  assert.match(code, /\(step === 4 && !overCap && \(/, 'Start exploring is gated too');
  assert.match(code, /Como mucho \$\{USER_PREFERENCES_MAX\} categorías: quita \$\{selectedSubcategories\.size - USER_PREFERENCES_MAX\}\./, 'the hint says how many to drop');
});

test('SOURCE: the settings picker refuses to save over the cap, before the write', async () => {
  const code = stripComments(await read('../Settings/EditInterestsModal.jsx'));
  assert.match(code, /import \{ USER_PREFERENCES_MAX \} from '\.\.\/\.\.\/utils\/accountOnboarding\.js';/);
  const guard = code.match(/if \(selected\.size > USER_PREFERENCES_MAX\) \{[\s\S]*?return;\s*\}/);
  assert.ok(guard, 'the save handler has no cap guard');
  assert.match(guard[0], /Como mucho \$\{USER_PREFERENCES_MAX\} intereses: quita \$\{selected\.size - USER_PREFERENCES_MAX\}\./);
  const save = code.indexOf('await updatePreferences(Array.from(selected))');
  assert.ok(save > -1 && code.indexOf('if (selected.size > USER_PREFERENCES_MAX)') < save, 'the guard runs before the write');
});
```

Añadir a `tests/firestore.rules.test.js`, tras el test «an old account can make every write the app makes to its user document» (y `import { USER_PREFERENCES_MAX } from '../src/utils/accountOnboarding.js';` junto a los otros imports de `../src/`):

```js
test('a preference list is capped at 100, and the cap is where the client says it is', async () => {
  // USER_PREFERENCES_MAX (src/utils/accountOnboarding.js) is what the pickers
  // enforce; this is the rules engine agreeing with them. One over is refused
  // outright, which is why the onboarding must never let a list that long
  // reach the write (audit of 2026-09-16, hallazgo 4).
  await reset();
  await seedLegacyUserDoc();
  const ref = doc(asAlice(), 'users', ALICE);
  const list = (n) => Array.from({ length: n }, (_, i) => `cat.${i}`);
  await assertSucceeds(setDoc(ref, { onboardingComplete: true, preferences: list(USER_PREFERENCES_MAX) }, { merge: true }));
  await assertFails(setDoc(ref, { onboardingComplete: true, preferences: list(USER_PREFERENCES_MAX + 1) }, { merge: true }));
  await assertFails(setDoc(ref, { preferences: list(USER_PREFERENCES_MAX + 1) }, { merge: true }));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/utils/accountOnboarding.test.js src/components/Onboarding/interestsCap.test.js`
Expected: FAIL — `does not provide an export named 'USER_PREFERENCES_MAX'` y los dos SOURCE.

- [ ] **Step 3: Add the constant** (al final de `src/utils/accountOnboarding.js`)

```js
/**
 * The most preferences a `users/{uid}` document may hold. The number is the
 * rules' (`firestore.rules`, `preferences.size() <= 100`): a longer list is
 * refused by the server, and a refusal the pickers do not prevent surfaces as
 * "could not save" at best — and, before the write order in AuthContext was
 * fixed, as an onboarding that came back on every reload
 * (docs/AUDITORIA-ONBOARDING-INTERESES-2026-09-16.md, hallazgo 4). The guest
 * seed stays far below it (58 for all twelve areas); "select all" twelve
 * times does not (142).
 */
export const USER_PREFERENCES_MAX = 100;
```

- [ ] **Step 4: Gate the onboarding** (en `OnboardingFlow.jsx`)

Import, junto a los demás de `../../utils/`:

```js
import { USER_PREFERENCES_MAX } from '../../utils/accountOnboarding.js';
```

Declarar, justo después de `const resolvedDisplayName = …;`:

```js
  // Más de esto lo rechazan las rules; el pie lo dice antes de que el botón
  // se apague, y el paso del perfil no puede acabar con una lista así.
  const overCap = selectedSubcategories.size > USER_PREFERENCES_MAX;
```

En `handleNext`, sustituir `} else if (step === 2 && selectedSubcategories.size > 0) {` por `} else if (step === 2 && selectedSubcategories.size > 0 && !overCap) {`.

En `canProceed`, sustituir

```js
    (step === 2 && selectedSubcategories.size > 0) ||
    step === 3 ||
    (step === 4 && (
```

por

```js
    (step === 2 && selectedSubcategories.size > 0 && !overCap) ||
    step === 3 ||
    (step === 4 && !overCap && (
```

En `hint`, sustituir la rama del paso 2 (`: (selectedSubcategories.size > 0 ? … : …)`) por:

```js
    : overCap
      ? (isEnglish
        ? `At most ${USER_PREFERENCES_MAX} categories: drop ${selectedSubcategories.size - USER_PREFERENCES_MAX}.`
        : `Como mucho ${USER_PREFERENCES_MAX} categorías: quita ${selectedSubcategories.size - USER_PREFERENCES_MAX}.`)
      : (selectedSubcategories.size > 0
        ? (isEnglish ? 'That is enough to build your feed.' : 'Con esto ya podemos armar tu feed.')
        : (isEnglish ? 'Select at least one category to continue.' : 'Marca al menos una categoría para continuar.'));
```

- [ ] **Step 5: Gate the settings modal** (en `EditInterestsModal.jsx`)

Import, junto a `import { CATEGORIES } from '../../data/categories';`:

```js
import { USER_PREFERENCES_MAX } from '../../utils/accountOnboarding.js';
```

En `handleSave`, después del bloque `if (selected.size === 0) { … return; }` y antes de `setFormError('');`:

```js
    if (selected.size > USER_PREFERENCES_MAX) {
      // Same tick-deferral as the empty case above, for the same reason: a
      // repeat click must re-announce the error, not be swallowed by the diff.
      setFormError('');
      setTimeout(() => {
        setFormError(isEnglish
          ? `At most ${USER_PREFERENCES_MAX} interests: drop ${selected.size - USER_PREFERENCES_MAX}.`
          : `Como mucho ${USER_PREFERENCES_MAX} intereses: quita ${selected.size - USER_PREFERENCES_MAX}.`);
      }, 0);
      return;
    }
```

- [ ] **Step 6: Run the unit tests, then the rules test**

Run: `node --test src/utils/accountOnboarding.test.js src/components/Onboarding/interestsCap.test.js src/components/Onboarding/OnboardingFlow.test.js`
Expected: PASS.
Run: `PATH="$(brew --prefix openjdk)/bin:$PATH" npm run test:rules`
Expected: PASS, incluido «a preference list is capped at 100…». Si el emulador rechaza el documento de 100 por «expression budget» (memoria `papertok-emulator-expression-counting`), anotarlo en el commit y bajar el caso positivo a 60 (`list(60)`), que es lo que alcanza la siembra; el caso negativo se queda en 101.

- [ ] **Step 7: Commit**

```bash
git add src/utils/accountOnboarding.js src/utils/accountOnboarding.test.js src/components/Onboarding/OnboardingFlow.jsx src/components/Onboarding/interestsCap.test.js src/components/Settings/EditInterestsModal.jsx tests/firestore.rules.test.js
git commit -m "fix(intereses): los dos selectores conocen el tope de 100 de las rules

Con «seleccionar todo» en varias áreas la lista pasaba de 100, las rules
la rechazaban y ningún selector lo decía. USER_PREFERENCES_MAX vive en
accountOnboarding.js, un test lo contrasta con firestore.rules y otro con
el emulador; el onboarding no sale del paso de categorías ni acaba por
encima, y Ajustes no guarda.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `completeOnboarding` escribe antes de dar el onboarding por hecho

**Files:**
- Modify: `src/context/AuthContext.jsx` (`completeOnboarding`)
- Test: `src/context/authContextRollback.test.js` (añadir)

**Interfaces:**
- Consumes: nada nuevo.
- Produces: misma firma `completeOnboarding(preferences): Promise<void>`; ahora **rechaza sin haber cambiado el estado** si `setDoc` falla. `OnboardingFlow.handleFinish` ya lo captura y pinta «No se pudo guardar. Inténtalo de nuevo.» (sin cambios allí).

- [ ] **Step 1: Write the failing test** (al final de `src/context/authContextRollback.test.js`)

```js
test('completeOnboarding flips the flag only after the document write has landed', async () => {
  // Flipping first sent the onboarding on its way (its effect navigates the
  // moment the flag is true) while the write was in flight: a refused write
  // failed against an unmounted page, left no local memory, and the next
  // reload asked everything again (audit of 2026-09-16, hallazgo 4).
  const src = stripComments(await readFile(new URL('./AuthContext.jsx', import.meta.url), 'utf8'));
  const fn = src.match(/const completeOnboarding = useCallback\(async \(preferences\) => \{[\s\S]*?\n {2}\}, \[user\?\.uid\]\);/);
  assert.ok(fn, 'completeOnboarding is gone or reshaped');
  const body = fn[0];
  const flips = [...body.matchAll(/setOnboardingComplete\(true\)/g)].map(m => m.index);
  assert.equal(flips.length, 2, 'one flip per branch: demo and live');
  const demoReturn = body.indexOf('return;');
  const write = body.indexOf('await setDoc(');
  assert.ok(write > -1, 'the live branch writes the document');
  assert.ok(flips[0] < demoReturn, 'the demo branch still flips before it returns');
  assert.ok(flips[1] > write, 'the live branch flips after the write, never before');
  assert.ok(body.indexOf('saveStoredOnboarding(userId') > write, 'and the local memory is written after it too');
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `node --test src/context/authContextRollback.test.js`
Expected: FAIL en «the live branch flips after the write, never before».

- [ ] **Step 3: Reorder the function** (sustituir `completeOnboarding` entero en `AuthContext.jsx`)

```js
  // The flag flips only once the document holds it. Flipping first sent the
  // onboarding on its way (its effect navigates the moment the flag is true)
  // while the write was still in flight, so a refused write — a list over the
  // rules' cap, a rule that changed under the client — failed against an
  // unmounted page, left no local memory either, and the next reload asked
  // the same questions again: an onboarding that never ended
  // (docs/AUDITORIA-ONBOARDING-INTERESES-2026-09-16.md, hallazgo 4). Now the
  // failure reaches handleFinish's catch, on screen, with the pick intact.
  const completeOnboarding = useCallback(async (preferences) => {
    if (IS_DEMO) {
      demoSet('selectedCategories', preferences);
      demoSet('onboardingComplete', true);
      clearGuestInterests();
      setUserPreferences(preferences);
      setOnboardingComplete(true);
      return;
    }

    const userId = user?.uid;
    if (userId) {
      await setDoc(doc(db, 'users', userId), {
        onboardingComplete: true,
        preferences
      }, { merge: true });
      saveStoredOnboarding(userId, { complete: true, preferences });
      // The interests a guest picked before signing up have now reached the
      // profile (the onboarding pre-selects from them); the bridge is done.
      clearGuestInterests();
    }
    setUserPreferences(preferences);
    setOnboardingComplete(true);
  }, [user?.uid]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/context/authContextRollback.test.js src/components/Onboarding/OnboardingFlow.test.js src/context/authProfileLoad.test.js`
Expected: PASS (el test SOURCE «the guest answer is cleared where the profile takes over» sigue casando: la escritura precede a `clearGuestInterests()`).

- [ ] **Step 5: Commit**

```bash
git add src/context/AuthContext.jsx src/context/authContextRollback.test.js
git commit -m "fix(auth): el onboarding se da por hecho después de escribirlo, no antes

Marcar el flag antes del setDoc navegaba al feed con la escritura en
vuelo; si las rules la rechazaban, el error caía en una página desmontada,
no quedaba memoria local, y la siguiente recarga volvía a preguntar todo.
Ahora un rechazo se ve en el propio onboarding, con la selección intacta.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: la ventana de cinco del feed se reparte entre áreas cuando la afinidad empata

**Files:**
- Create: `src/utils/preferenceRanking.js`
- Create: `src/utils/preferenceRanking.test.js`
- Modify: `src/context/FeedContext.jsx` (import + `rankedPreferences`)
- Modify: `src/context/feedFirstPaint.test.js` (la aserción sobre `rankedPreferences`)

**Interfaces:**
- Consumes: `getCategoryArea(id): string | null` de `src/data/categories.js`.
- Produces: `export function rankPreferences(preferences: string[] | null, affinities?: Record<string, number>): string[]` — sin duplicados, afinidad descendente; empates intercalados por área en el orden en que cada área aparece; ids sin área forman su propio grupo; valores no-string se descartan.

- [ ] **Step 1: Write the failing tests** (`src/utils/preferenceRanking.test.js`)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES } from '../data/categories.js';
import { rankPreferences } from './preferenceRanking.js';

const firstN = (area, n) => Object.keys(CATEGORIES[area].subcategories).slice(0, n);

test('with no affinities, the window is spread across the areas picked', () => {
  const seeded = [...firstN('physics', 5), ...firstN('eess', 5), ...firstN('mech', 5)];
  const ranked = rankPreferences(seeded, {});
  assert.equal(ranked.length, 15);
  assert.deepEqual(ranked.slice(0, 5), [
    firstN('physics', 1)[0], firstN('eess', 1)[0], firstN('mech', 1)[0],
    firstN('physics', 2)[1], firstN('eess', 2)[1],
  ]);
  // Within an area the list's own order is kept.
  assert.deepEqual(ranked.filter(id => id in CATEGORIES.physics.subcategories), firstN('physics', 5));
});

test('affinity outranks area, and ties are still interleaved below it', () => {
  const seeded = [...firstN('physics', 3), ...firstN('eess', 3)];
  const liked = firstN('eess', 3)[2];
  const disliked = firstN('physics', 1)[0];
  const ranked = rankPreferences(seeded, { [liked]: 4, [disliked]: -2 });
  assert.equal(ranked[0], liked);
  assert.equal(ranked.at(-1), disliked);
  assert.deepEqual(ranked.slice(1, 3), [firstN('physics', 2)[1], firstN('eess', 1)[0]]);
});

test('duplicates fold, unknown ids keep their order in a group of their own, and garbage is dropped', () => {
  const ranked = rankPreferences(['cs.AI', 'topic:x', 'cs.AI', 'topic:y', null, 42, ''], {});
  assert.deepEqual(ranked, ['cs.AI', 'topic:x', 'topic:y']);
  assert.deepEqual(rankPreferences(null), []);
  assert.deepEqual(rankPreferences(['cs.AI'], { 'cs.AI': 'nope' }), ['cs.AI']);
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `node --test src/utils/preferenceRanking.test.js`
Expected: FAIL — `Cannot find module '…/preferenceRanking.js'`.

- [ ] **Step 3: Write the module** (`src/utils/preferenceRanking.js`)

```js
import { getCategoryArea } from '../data/categories.js';

/**
 * The order the feed asks its sources in — and, since each source only takes
 * the first few (five for arXiv and OpenAlex, three for PubMed), the order
 * that decides what a page is about.
 *
 * Affinity first, highest on top. Among equals — and on a new account every
 * preference is an equal, at zero — the tie is broken by interleaving areas:
 * the first preference of each area in the order the areas first appear,
 * then the second of each, and so on. A plain stable sort kept the list's
 * own order, which is the taxonomy's, so an account seeded with physics,
 * electrical and mechanical engineering asked for five physics categories
 * and no engineering at all until its interactions said otherwise
 * (docs/AUDITORIA-ONBOARDING-INTERESES-2026-09-16.md, hallazgo 3).
 *
 * Ids outside the schema (a followed topic that maps to no area) keep their
 * relative order in a group of their own.
 */
export function rankPreferences(preferences, affinities = {}) {
  const ids = [...new Set((preferences || []).filter(id => typeof id === 'string' && id))];
  const score = (id) => Number(affinities?.[id]) || 0;
  const tiers = new Map();
  for (const id of ids) {
    const value = score(id);
    if (!tiers.has(value)) tiers.set(value, []);
    tiers.get(value).push(id);
  }
  return [...tiers.keys()]
    .sort((a, b) => b - a)
    .flatMap(value => interleaveByArea(tiers.get(value)));
}

function interleaveByArea(ids) {
  const byArea = new Map();
  for (const id of ids) {
    const area = getCategoryArea(id) ?? '';
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(id);
  }
  const lists = [...byArea.values()];
  const out = [];
  for (let index = 0; ; index += 1) {
    let added = false;
    for (const list of lists) {
      if (index < list.length) {
        out.push(list[index]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `node --test src/utils/preferenceRanking.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Update the first-paint SOURCE test, run it to see it fail** (en `src/context/feedFirstPaint.test.js`, dentro de «SOURCE: followed topics rank the main query again, inside a budget», sustituir la última aserción)

```js
  assert.match(
    code,
    /const rankedPreferences = rankPreferences\(\[\.\.\.userPreferences, \.\.\.followedTopicIds\], categoryAffinities\.current\);/,
    'and the ids actually widen the ranked preferences, ranked with ties spread across areas',
  );
  assert.doesNotMatch(code, /const rankedPreferences = \[\.\.\.new Set\(/, 'the inline stable sort is gone: it kept taxonomy order on a flat profile');
```

Run: `node --test src/context/feedFirstPaint.test.js`
Expected: FAIL en esa aserción.

- [ ] **Step 6: Wire it into FeedContext** (en `src/context/FeedContext.jsx`)

Import, junto a los demás de `../utils/`:

```js
import { rankPreferences } from '../utils/preferenceRanking.js';
```

Sustituir

```js
        const rankedPreferences = [...new Set([...userPreferences, ...followedTopicIds])].sort((a, b) => {
          const affA = categoryAffinities.current[a] || 0;
          const affB = categoryAffinities.current[b] || 0;
          return affB - affA;
        });
```

por

```js
        // Ties are spread across areas (preferenceRanking.js): on a flat
        // profile the five slots below used to go to the first five of the
        // first area, whatever else the account had picked.
        const rankedPreferences = rankPreferences([...userPreferences, ...followedTopicIds], categoryAffinities.current);
```

- [ ] **Step 7: Run the feed tests**

Run: `node --test src/context/feedFirstPaint.test.js src/context/feedFollowChange.test.js src/context/feedReRankAnchor.test.js src/utils/preferenceRanking.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/utils/preferenceRanking.js src/utils/preferenceRanking.test.js src/context/FeedContext.jsx src/context/feedFirstPaint.test.js
git commit -m "fix(feed): los empates de afinidad se reparten entre áreas antes de recortar a cinco

Una cuenta nueva tiene afinidad cero en todo, el sort estable dejaba el
orden de la taxonomía, y la ventana de cinco de arXiv y OpenAlex se iba
entera a la primera área. rankPreferences intercala áreas en cada empate:
Física + Eléctrica + Mecánica arranca con las tres.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: registrarse desde una página pública lleva al onboarding, con la página como vuelta

**Files:**
- Modify: `src/App.jsx` (helper `isPublicRoute` junto a `isInAppPath`; efecto nuevo tras el de `travelledReturnRef`)
- Create: `src/components/Public/publicSignupOnboarding.test.js`

**Interfaces:**
- Consumes: `user`, `authLoading`, `onboardingComplete`, `profileLoadError` (ya desestructurados de `useAuth()` en `AppContent`), `navigate`, `location`.
- Produces: `const PUBLIC_ROUTE_PREFIXES = ['/public/', '/explorer/']` y `function isPublicRoute(path)` en `App.jsx` (no exportados). `OnboardingFlow` ya acepta `state.returnTo` con cualquier ruta interna que empiece por `/`.

- [ ] **Step 1: Write the failing SOURCE test** (`src/components/Public/publicSignupOnboarding.test.js`)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Comments are stripped first (convention of ce139ce).
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: a new account that signed in from a public page is sent to the onboarding, with the page as the way back', async () => {
  // The public routes are not behind ProtectedRoute, and their doors (like,
  // save, follow) only open the AuthPrompt: nothing used to take a brand-new
  // account from there to choose its interests (audit of 2026-09-16,
  // hallazgo 2).
  const code = stripComments(await readFile(new URL('../../App.jsx', import.meta.url), 'utf8'));
  assert.match(code, /const PUBLIC_ROUTE_PREFIXES = \['\/public\/', '\/explorer\/'\]/);
  assert.match(code, /function isPublicRoute\(path\) \{\s*return PUBLIC_ROUTE_PREFIXES\.some\(prefix => path\.startsWith\(prefix\)\)\s*\}/);
  const effect = code.match(
    /useEffect\(\(\) => \{\s*if \(!user \|\| authLoading \|\| onboardingComplete \|\| profileLoadError\) return\s*if \(!isPublicRoute\(location\.pathname\)\) return\s*navigate\('\/onboarding', \{ replace: true, state: \{ returnTo: `\$\{location\.pathname\}\$\{location\.search\}` \} \}\)\s*\}, \[user, authLoading, onboardingComplete, profileLoadError, location\.pathname, location\.search, navigate\]\)/,
  );
  assert.ok(effect, 'the public-page arrival effect is missing or reshaped');
  // Every public route the router declares is covered by the prefixes.
  const publicPaths = [...code.matchAll(/path="(\/(?:public|explorer)\/[^"]*)"/g)].map(m => m[1]);
  assert.ok(publicPaths.length >= 5, `expected the five public routes, found ${publicPaths.length}`);
  for (const path of publicPaths) {
    assert.ok(path.startsWith('/public/') || path.startsWith('/explorer/'), `${path} is not covered by PUBLIC_ROUTE_PREFIXES`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/components/Public/publicSignupOnboarding.test.js`
Expected: FAIL en la primera aserción (`PUBLIC_ROUTE_PREFIXES`).

- [ ] **Step 3: Add the helper and the effect** (en `src/App.jsx`; el fichero no usa punto y coma)

Justo después de `function isInAppPath(path) { … }`:

```js
// The routes a guest can reach without a session. A sign-in from one of their
// doors (like, save, follow) leaves the new account right there, and none of
// them is behind ProtectedRoute, so App itself has to take it to the
// onboarding (the effect below).
const PUBLIC_ROUTE_PREFIXES = ['/public/', '/explorer/']
function isPublicRoute(path) {
  return PUBLIC_ROUTE_PREFIXES.some(prefix => path.startsWith(prefix))
}
```

Justo después del efecto que empieza `// Once the session exists, the trip ends where it began — once per trip.` (el que usa `travelledReturnRef`):

```js
  // A new account created from a public page's door has nowhere to go: those
  // routes are not behind ProtectedRoute, so nothing asked it to choose its
  // interests, and the bar (which needs `onboardingComplete`) never came. The
  // onboarding opens with this page as the way back. `replace`, because a
  // Back into an un-onboarded public page would only bring the account here
  // again. Not while the profile is loading or failed to: the route's own
  // handling covers those, and a redirect on a guess would be wrong.
  useEffect(() => {
    if (!user || authLoading || onboardingComplete || profileLoadError) return
    if (!isPublicRoute(location.pathname)) return
    navigate('/onboarding', { replace: true, state: { returnTo: `${location.pathname}${location.search}` } })
  }, [user, authLoading, onboardingComplete, profileLoadError, location.pathname, location.search, navigate])
```

- [ ] **Step 4: Run the tests that read App.jsx**

Run: `node --test src/components/Public/publicSignupOnboarding.test.js src/routerTransitions.test.js src/accessibilityStructure.test.js src/utils/appPrefetch.test.js src/components/Explorer/explorerAppChrome.test.js`
Expected: PASS.
Run: `npm run lint`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx src/components/Public/publicSignupOnboarding.test.js
git commit -m "fix(app): registrarse desde una página pública lleva al onboarding, y de vuelta

Las rutas públicas no van dentro de ProtectedRoute y su modal de acceso
solo se cierra al llegar la sesión: la cuenta nueva se quedaba en el
paper, sin barra y sin elegir intereses, hasta pisar el feed. Ahora un
efecto la lleva a /onboarding con la página como returnTo.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: suite completa, verificación en demo y STATE.md

**Files:**
- Modify: `STATE.md` (entrada nueva arriba del todo)
- Modify: `docs/AUDITORIA-ONBOARDING-INTERESES-2026-09-16.md` (una línea al principio: «Ejecutado el …, ver STATE.md»)
- Scratchpad (fuera del repo): `vite.demo.config.mjs`, `onboarding-probe.mjs`; entrada temporal en `.claude/launch.json` que se quita al acabar.

**Interfaces:**
- Consumes: todo lo anterior.

- [ ] **Step 1: Run the whole unit suite**

Run: `npm test`
Expected: PASS. Si algún test SOURCE ajeno casa texto que estas tareas movieron (`OnboardingFlow.jsx`, `AuthContext.jsx`, `FeedContext.jsx`, `App.jsx`), leer el test antes de tocarlo: la aserción describe un invariante, y lo que hay que decidir es si el invariante sigue en pie con otra forma o si la tarea lo rompió.

- [ ] **Step 2: Demo server without touching the tree** (config en el scratchpad de la sesión; `<S>` es esa ruta absoluta)

`<S>/vite.demo.config.mjs`:

```js
// Flips IS_DEMO at transform time so the working tree stays untouched.
import base from '/Users/nicolasmunozgarcia/Developer/papertok/.claude/worktrees/onboarding-intereses/vite.config.js';

export default async (env) => {
  const cfg = await base(env);
  cfg.root = '/Users/nicolasmunozgarcia/Developer/papertok/.claude/worktrees/onboarding-intereses';
  cfg.plugins = [
    {
      name: 'papertok-demo-flag',
      enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('/src/services/firebase.js')) return null;
        if (!code.includes('export const IS_DEMO = false;')) throw new Error('IS_DEMO line not found');
        return code.replace('export const IS_DEMO = false;', 'export const IS_DEMO = true;');
      },
    },
    ...cfg.plugins,
  ];
  return cfg;
};
```

Entrada en `.claude/launch.json` del checkout principal (añadir; quitar al terminar):

```json
{
  "name": "onboarding-demo-5185",
  "runtimeExecutable": "sh",
  "runtimeArgs": ["-c", "cd /Users/nicolasmunozgarcia/Developer/papertok/.claude/worktrees/onboarding-intereses && exec npx vite --config <S>/vite.demo.config.mjs --port 5185 --strictPort"],
  "port": 5185,
  "url": "http://localhost:5185"
}
```

Arrancar con `preview_start {name: "onboarding-demo-5185"}` y comprobar: `curl -s http://localhost:5185/src/services/firebase.js | grep IS_DEMO` → `export const IS_DEMO = true;`.

- [ ] **Step 3: Probe** (`<S>/onboarding-probe.mjs`, Chrome headless por CDP; `node onboarding-probe.mjs seeded` y `node onboarding-probe.mjs fresh`)

```js
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9224;
const ORIGIN = process.env.ORIGIN || 'http://localhost:5185';
const OUT = process.env.SHOTS_DIR || process.cwd();
const scenario = process.argv[2] || 'seeded';
const PROFILE = join(tmpdir(), `papertok-onb-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

async function pageTarget() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('no page target');
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`); return r.result.value; }
}
async function pollUntil(cdp, expression, timeoutMs, every = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const v = await cdp.eval(expression); if (v) return v; await sleep(every); }
  return null;
}
const STATE = `({
  hash: location.hash,
  stepcount: document.querySelector('.onboarding-stepcount')?.textContent || null,
  title: document.querySelector('.onboarding-title')?.textContent || null,
  receiptRows: document.querySelectorAll('.onboarding-seed-receipt .onboarding-receipt-row').length,
  receiptTotal: document.querySelector('.onboarding-seed-receipt .onboarding-receipt-total-n')?.textContent || null,
  adjust: !!document.querySelector('.onboarding-seed-receipt button'),
  areaCards: document.querySelectorAll('.area-card').length,
  chips: document.querySelectorAll('.subcat-chip[data-pressed], .subcat-chip[aria-pressed="true"]').length,
})`;

try {
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${ORIGIN}/#/` });
  await sleep(1500);
  await cdp.eval(`(() => {
    localStorage.clear();
    localStorage.setItem('papertok_user', JSON.stringify({ uid: 'demo-new-user', displayName: 'Nuevo Tester', email: 'nuevo@papertok.app', photoURL: '', providerData: [{ providerId: 'google.com' }] }));
    ${scenario === 'seeded' ? `localStorage.setItem('papertok_guestInterests', JSON.stringify({ areas: ['physics','eess','mech'], dismissedAt: null, updatedAt: Date.now() }));` : ''}
    return true;
  })()`);
  // A hash-only navigate does not reload the document: the app keeps the pre-seed state.
  await cdp.send('Page.reload', { ignoreCache: true });
  await pollUntil(cdp, `!!document.querySelector('.onboarding-stepcount')`, 15000);
  await sleep(800);
  const landed = await cdp.eval(STATE);
  console.log(JSON.stringify({ scenario, landed }, null, 2));
  writeFileSync(join(OUT, `onboarding-${scenario}.png`), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  if (scenario === 'seeded') {
    await cdp.eval(`document.querySelector('.onboarding-seed-receipt button').click()`);
    await sleep(600);
    const adjusted = await cdp.eval(STATE);
    console.log(JSON.stringify({ afterAdjust: adjusted }, null, 2));
    writeFileSync(join(OUT, 'onboarding-adjust.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  ws.close();
} finally {
  chrome.kill();
  await sleep(1500);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* best effort */ }
}
```

Expected, `seeded`: `stepcount` «Step 04 / 04», `receiptRows` 3, `receiptTotal` «15 / 42», `adjust` true; tras el clic, `stepcount` «Step 02 / 04» y `chips` 15. Expected, `fresh`: «Step 01 / 04», `areaCards` 12, `receiptRows` 0. Mirar las tres PNG (Read) antes de darlas por buenas: el recibo debajo del texto, el botón a la derecha de la cabecera en 1280 px.

- [ ] **Step 4: Stop the server and remove the launch entry**

`preview_stop` con el `serverId` de `preview_start`; quitar la entrada `onboarding-demo-5185` de `.claude/launch.json`; `git status --short .claude/launch.json` → vacío.

- [ ] **Step 5: STATE.md entry** (al principio de `STATE.md`, encima de la entrada de arXiv del 16-09)

```markdown
## El usuario nuevo ve sus intereses al registrarse, y el feed los reparte (2026-09-17)

**«A nuevos usuarios no les carga la ventana pidiendo intereses.»** No era
un fallo de carga: desde el 13-09 (92c01f8) el invitado responde
obligatoriamente en el feed y el onboarding abre en el paso 4, con una nota de
una línea que nadie relacionaba con elegir intereses. Se mantiene el salto
(petición de Samuel) y cambia lo que se ve: el paso 4 enseña el recibo de
áreas (`InterestsReceipt`, compartido con el paso 3) y «Ajustar intereses»
abre el paso de categorías. Debajo había tres cosas más. (1) La respuesta del
invitado se convertía en **todas** las subcategorías de cada área (3 áreas =
42) y el feed solo manda las cinco primeras, en orden de taxonomía: Física +
Eléctrica + Mecánica arrancaba con cinco de Física; ahora
`guestSeedCategoriesForAreas` siembra cinco por área intercaladas, y
`rankPreferences` (feed) reparte los empates de afinidad entre áreas antes de
recortar. (2) Las rules rechazan más de 100 preferencias, seis áreas grandes
las superan, y `completeOnboarding` marcaba el onboarding hecho **antes** de
escribir: el rechazo caía en una página desmontada y la siguiente recarga
volvía a preguntar. Ahora `USER_PREFERENCES_MAX` cierra el paso 2, el final y
el modal de Ajustes (test contra `firestore.rules` y contra el emulador), y el
flag se marca después del `setDoc`. (3) Registrarse desde una página pública
no llevaba al onboarding (esas rutas no van en `ProtectedRoute`); un efecto en
`App.jsx` navega a `/onboarding` con la página como `returnTo`. Verificado en
demo con Chrome headless: paso 04 con recibo de 3 filas y 15 / 42, «Ajustar»
abre el paso 02 con 15 fichas; sin respuesta de invitado, paso 01. Auditoría
en `docs/AUDITORIA-ONBOARDING-INTERESES-2026-09-16.md`, plan en
`docs/superpowers/plans/2026-09-17-onboarding-intereses.md`.
```

Y en la auditoría, bajo el título, una línea: «**Ejecutado el 2026-09-17** (rama `feat/onboarding-intereses`); ver STATE.md.»

- [ ] **Step 6: Commit and hand over**

```bash
git add STATE.md docs/AUDITORIA-ONBOARDING-INTERESES-2026-09-16.md docs/superpowers/plans/2026-09-17-onboarding-intereses.md
git commit -m "docs(onboarding): auditoría, plan y estado del onboarding de intereses

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Después: `superpowers:finishing-a-development-branch`. Antes de fusionar, rebase sobre `origin/main` (memoria `papertok-deploy-before-rebase`); Vercel despliega al hacer push a `main`. No hay Worker ni rules que desplegar (las rules no cambian; solo se les añade un test).
