import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * A visitor without an account is measured until they object, and Settings,
 * the only other place to object, needs an account. These hold the wiring
 * that gives them the switch and the policy: source tests, like the rest of
 * the guest chrome, because the bars are not something a harness mounts here.
 */

const read = async (path: string|URL) => (await readFile(new URL(path, import.meta.url), 'utf8'))
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('a visitor reaches the analytics switch and the policy from both guest bars', async () => {
  const feed = await read('./GuestFeedPage.tsx');
  const header = feed.slice(feed.indexOf('<header className="guest-feed-header"'), feed.indexOf('</header>'));
  assert.match(header, /<ThemeToggle className="guest-header-button" \/>\s*<PrivacyPopover className="guest-header-button" \/>/);

  // From the first screen of the welcome on, and only for a visitor: account
  // onboarding shares the shell and has Settings.
  const welcome = await read('./GuestWelcome.tsx');
  const barAction = welcome.slice(welcome.indexOf('barAction={('), welcome.indexOf(')}', welcome.indexOf('barAction={(')));
  assert.match(barAction, /<PrivacyPopover className=\{`gw-bar-button\$\{onLanding \? ' btn-halftone' : ''\}`\} \/>/);
  assert.doesNotMatch(await read('./WelcomeShell.tsx'), /PrivacyPopover/);

  // The policy is a page of its own, opened beside the app so the welcome keeps
  // its place, and a link rather than a Button (which Base UI would announce as
  // a button). Nothing else in the app links a visitor to it.
  const popover = await read('./PrivacyPopover.tsx');
  assert.match(popover, /<a\s+href="\/privacy\.html"\s+target="_blank"\s+rel="noopener noreferrer"/);
  assert.match(popover, /<span className="visually-hidden">\{COPY\.newTab\}<\/span>/);
});

test('arrow keys in the Privacy panel stay in the panel on the feed', async () => {
  // The feed turns ArrowUp/ArrowDown into a card change unless focus is in
  // something interactive; a non-modal popup is, whatever inside it has focus.
  const feed = await read('../Feed/FeedContainer.tsx');
  const exempt = feed.match(/activeTarget\?\.closest\(\s*'([^']+)'/)?.[1];
  assert.ok(exempt, 'the feed no longer says which targets keep their keys');
  assert.match(exempt, /\[role="dialog"\]/);
});

test('the switch reads and writes the one stored choice through the analytics context', async () => {
  const popover = await read('./PrivacyPopover.tsx');
  assert.match(popover, /const \{ consent, updateConsent \} = useAnalyticsConsent\(\);/);
  assert.match(popover, /checked=\{consent === ANALYTICS_CONSENT\.GRANTED\}/);
  assert.match(popover, /updateConsent\(checked \? ANALYTICS_CONSENT\.GRANTED : ANALYTICS_CONSENT\.DENIED\)/);
  // A second way to store the choice would be a second owner of it.
  assert.doesNotMatch(popover, /setAnalyticsConsent|persistAnalyticsConsent|localStorage|document\.cookie|papertok_analytics/);
  // Named by the label it sits in; an aria-label too is read out twice.
  assert.doesNotMatch(popover, /<Switch[^>]*aria-label/);
});

test('a choice the browser refused to store is said, every time, not just left unswitched', async () => {
  const popover = await read('./PrivacyPopover.tsx');
  // The live region holds only the failure, and is emptied before each try:
  // it speaks when its text changes, so a second refusal must change it too.
  assert.match(popover, /setSaveFailed\(false\);\s*const saved = await updateConsent\(/);
  assert.match(popover, /setSaveFailed\(!saved\)/);
  assert.match(popover, /<span role="status">\{saveFailed \? COPY\.saveFailed : ''\}<\/span>/);
});
