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
  // Step 3 has its own finish button in the `existingProfile` branch, which
  // calls handleFinish directly and never consults canProceed. The cap closes
  // at the function too, so no entry point can finish over it.
  assert.match(code, /const handleFinish = async \(\) => \{\s*if \(overCap\) return;/, 'handleFinish refuses over the cap whatever called it');
  assert.match(code, /onClick=\{handleFinish\}\s*disabled=\{saving \|\| overCap\}/, 'the step-3 finish button is disabled over the cap');
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
