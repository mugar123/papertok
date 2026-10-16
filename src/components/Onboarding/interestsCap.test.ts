import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Comments are stripped first (convention of ce139ce): a matcher that reads
// comments would be satisfied by the explanation alone.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('SOURCE: the onboarding refuses to leave the topics screen, or to finish, over the cap', async () => {
  const code = stripComments(await read('./OnboardingFlow.tsx'));
  assert.match(code, /import \{ USER_PREFERENCES_MAX \} from '\.\.\/\.\.\/utils\/accountOnboarding\.ts';/);
  // guestSeedCategoriesForAreas cuts at the cap by itself, so the cap is
  // judged on the count before that cut: every ticked topic, and the first
  // few of each area left whole.
  // The size comes from the bridge's own rule, uncapped, so the onboarding
  // never re-derives how many categories an answer stands for.
  assert.match(code, /const preferenceCount = guestSeedSizeForAreas\(Array\.from\(selectedAreas\), GUEST_SEED_PER_AREA, Array\.from\(selectedTopics\)\);/);
  assert.doesNotMatch(code, /Math\.min\(GUEST_SEED_PER_AREA/);
  // Judged on the pickers' path only, where the reader can drop topics; a
  // guest answer never shows the pickers and its seed is cut at the cap.
  assert.match(code, /const overCap = asksTopics && preferenceCount > USER_PREFERENCES_MAX;/);
  assert.doesNotMatch(code, /overCap = preferences\.length/, 'the capped list can never be over the cap');
  // Every screen after the areas is held, not only the topics where the
  // cap is reached.
  assert.match(code, /\|\|\s*\(step !== 'topics' && overCap\)/, 'the primary button is disabled past the areas');
  assert.match(code, /disabled: primaryDisabled,/, 'and that is what the shell\'s button gets');
  assert.match(code, /At most \$\{USER_PREFERENCES_MAX\} categories: drop \$\{preferenceCount - USER_PREFERENCES_MAX\}\./, 'the note says how many to drop');
  // The live region is on every screen of that path, empty until the cap is
  // passed, so its text arrives in a region that already exists.
  assert.match(code, /\{asksTopics && \(\s*<p className="gw-preference-note" aria-live="polite">/, 'and is announced when it appears');
  // The cap closes at the function too, so no entry point can finish over it.
  assert.match(code, /const handleFinish = async \(\) => \{\s*if \(overCap\) return;/, 'handleFinish refuses over the cap whatever called it');
});

test('SOURCE: the settings picker refuses to save over the cap, before the write', async () => {
  const code = stripComments(await read('../Settings/EditInterestsModal.tsx'));
  assert.match(code, /import \{ USER_PREFERENCES_MAX \} from '\.\.\/\.\.\/utils\/accountOnboarding\.ts';/);
  const guard = code.match(/if \(selected\.size > USER_PREFERENCES_MAX\) \{[\s\S]*?return;\s*\}/);
  assert.ok(guard, 'the save handler has no cap guard');
  assert.match(guard[0], /At most \$\{USER_PREFERENCES_MAX\} interests: drop \$\{selected\.size - USER_PREFERENCES_MAX\}\./);
  const save = code.indexOf('await updatePreferences(Array.from(selected))');
  assert.ok(save > -1 && code.indexOf('if (selected.size > USER_PREFERENCES_MAX)') < save, 'the guard runs before the write');
});
