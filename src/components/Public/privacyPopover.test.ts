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

test('a visitor reaches the analytics switch and the policy from the welcome bar', async () => {
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

test('a visitor reaches the same switch from the header of every page a shared link opens', async () => {
  // Each page keeps it in its own visitor chrome and only there: a session
  // has Settings, and the switch's own words say "without an account".
  const paper = await read('./PublicPaperPage.tsx');
  const nav = paper.slice(paper.indexOf('<nav className="public-paper-nav"'), paper.indexOf('</nav>'));
  assert.match(nav, /<PrivacyPopover className="public-paper-nav-button" \/>/);

  const list = await read('../Lists/PublicListPage.tsx');
  const brand = list.slice(list.indexOf('<header className="public-list-brand">'), list.indexOf('</header>'));
  assert.match(brand, /\{!user && <PrivacyPopover \/>\}/);

  // The explorer's bar: in the live hero and in the skeleton before it.
  const explorer = await read('../Explorer/EntityExplorer.tsx');
  assert.equal(explorer.match(/\{publicMode && <PrivacyPopover \/>\}/g)?.length, 2);

  const notFound = await read('../Layout/NotFoundPage.tsx');
  assert.match(notFound, /\{!user && \(\s*<div className="not-found-bar">\s*<PrivacyPopover \/>/);
});

test('the policy says where the button is, and names the pages that have it', async () => {
  const policy = await readFile(new URL('../../../privacy.html', import.meta.url), 'utf8');
  const where = policy.match(/with the Privacy\s+button at the top of ([^.]*)\./)?.[1]?.replace(/\s+/g, ' ');
  assert.ok(where, 'the policy no longer says where the Privacy button is');
  assert.match(where, /the welcome screens/);
  // The pages the test above holds the button to. No feed: the welcome became
  // a page and there has been no guest feed since.
  for (const page of ['a paper', 'a list', 'an author or a topic', 'no longer works']) assert.match(where, new RegExp(page));
  assert.doesNotMatch(where, /\bthe feed\b/);
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
  assert.match(popover, /checked=\{consent !== ANALYTICS_CONSENT\.DENIED\}/);
  assert.match(popover, /updateConsent\(checked \? ANALYTICS_CONSENT\.ANONYMOUS : ANALYTICS_CONSENT\.DENIED\)/);
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
