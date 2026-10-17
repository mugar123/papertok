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
  // a button).
  const popover = await read('./PrivacyPopover.tsx');
  assert.match(popover, /<a\s+href="\/privacy\.html"\s+target="_blank"\s+rel="noopener noreferrer"/);
  assert.match(popover, /<span className="visually-hidden">\{COPY\.newTab\}<\/span>/);
});

// The policy link as the popover draws it: a new tab, and a hidden hint that
// says so, since the visible text alone does not.
const POLICY_LINK = /<a\s+href="\/privacy\.html"\s+target="_blank"\s+rel="noopener noreferrer"[\s\S]*?<span className="visually-hidden">[^<]+<\/span>\s*<\/a>/;

// Where the link is, and that it comes after (under, and later in the tab
// order than) every one of the providers.
function policyLinkAfter(block: string, providers: string[]) {
  const linkAt = block.search(POLICY_LINK);
  assert.ok(linkAt >= 0, 'no policy link here');
  for (const provider of providers) {
    const at = block.indexOf(provider);
    assert.ok(at >= 0, `${provider} not found`);
    assert.ok(linkAt > at, `the policy link comes before ${provider}`);
  }
}

test('whoever is about to sign in can open the policy under the providers', async () => {
  const prompt = await read('./AuthPrompt.tsx');
  const dialog = prompt.slice(prompt.indexOf('<DialogContent'), prompt.indexOf('</DialogContent>'));
  policyLinkAfter(dialog, ['id="google-sign-in-btn"', 'id="github-sign-in-btn"']);

  // On the landing it belongs to the stack that is inert while closed, so the
  // keyboard reaches it only once the providers show.
  const welcome = await read('./GuestWelcome.tsx');
  const stack = welcome.slice(welcome.indexOf('id="gw-providers"'), welcome.indexOf("{step === 'how'"));
  policyLinkAfter(stack, ['copy.welcome.github', 'copy.welcome.google']);
});

// The link is the last control in both places, so it is the first thing lost
// when the screen is short or the text is large.
test('the policy link stays reachable on a short screen and at large text', async () => {
  // The sign-in sheet is fixed over a locked page: past the screen's height
  // it has to scroll, or its ends are out of reach.
  const sheet = (await read('./AuthPrompt.css')).match(/\.auth-modal\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(sheet, /max-height:[^;]*\d[sdl]?vh/, 'the sheet is not held to the screen');
  assert.match(sheet, /overflow-y:\s*(?:auto|scroll)/, 'the sheet does not scroll');

  // The landing's stack opens into room kept under the hero, and is sized in
  // rem: room in px stays put while larger text grows the stack past it.
  const reserve = (await read('./GuestWelcome.css')).match(/\.gw--landing \.gw-stage\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(reserve, /padding-bottom:\s*[\d.]+rem;/, 'the room under the hero does not grow with the text');
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
