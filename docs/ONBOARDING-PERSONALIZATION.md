# Feed onboarding personalization

The guest first visit stays on `/feed` and uses `GuestWelcome` throughout:
Welcome → How it works → Areas → Specific topics → Reading → Inbox → Support.
Its last screen's action, "Start exploring papers", stores the answer and opens
the guest feed: a signed-out visitor with a stored answer sees the feed built
from those areas and topics, and the welcome is shown only until one exists.
The welcome asks for no account and carries no sign-in control; signing in is
offered in the guest feed (its header button, its end card, and the actions
that need an account). The stored choices also prefill account onboarding.

The three new screens reuse the existing wordmark, theme control, centered
headline, progress dots, Back action, and primary action. They do not introduce
a second route or an account-profile step.

## Preferences and account boundaries

The reading level travels in the existing guest-interests bridge as optional
`readingLevel`. Old stored answers remain valid. Changing interests through the
welcome preserves the level. New account onboarding saves the level atomically
with interests into `users/{uid}.readingPreferences.aiExplanationLevel`, then
clears the guest bridge. The reader starts from that account preference; its
per-paper level control remains available. Existing onboarded accounts discard
waiting guest data as before.

Email is opt-in. The Inbox screen offers one switch, off by default: "Email me
the daily digest". A yes travels in the guest bridge as `emailDigest: true`
(anything else reads as no) and does not collect an address: the welcome never
asks for one. Account onboarding saves it as `users/{uid}.emailDigestOptIn: true`
(allowed by `firestore.rules` as a bool) in a write of its own, after the
interests and not awaited by them: the frontend and the rules deploy separately,
so a refusal there loses the opt-in (email can still be enabled in Settings) and
never blocks the account.

The digest is built from follows and the Worker refuses an empty subscription
(`EMAIL_FOLLOWS_REQUIRED`), and a new account follows nothing. So the
subscription starts with the first follow: `EmailNotificationsContext` waits
until the account has a follow and the email provider reports available, then
enables the subscription through `savePreferences` (so `newsletter_change`
reports it) to the address the account signs in with, and deletes the flag. An
account that already has email on just has the flag deleted. A failure keeps
the flag and the next session tries again; once deleted, a later unsubscribe in
Settings is never undone. While the flag waits, the email modal's
"Nothing followed yet" notice says the digest starts with the first follow.
Demo mode never records the opt-in.

The Inbox screen's primary action reads "Continue" whether the switch is on or
off, and reaches optional GitHub support, whose own action is "Start exploring
papers". The GitHub link opens a new tab and does not submit a star.

## Verification, 2026-10-01

- Targeted ESLint passed for all changed source and test files.
- Full tests: 3,203 passed after updating the lifecycle assertion to cover the
  additional reading-preference write.
- Production build passed; existing bundle-size warnings remain.
- `npm run check` stops at lint errors in generated `landing/dist` JavaScript.
  No build configuration, dependency, or harness changes were made to bypass it.
- No production deployment or real sign-up/email subscription was performed.
- Axe was loaded temporarily in the browser for diagnostics; its global was
  removed after each audit. No diagnostic code was added to the application.

| Page or flow | Component | WCAG criterion | Result | Evidence | Defect or limitation | Retest |
| --- | --- | --- | --- | --- | --- | --- |
| `/feed` reading | Native radio cards | 2.1.1, 4.1.2 | Cumple | Up selected Beginner from University; sample and checked state changed; Tab reached Back | Real screen reader not tested | Repeat with arrows and Tab |
| Reading → Inbox → Support → Inbox → Reading | Shared controls and headings | 2.1.1, 2.4.3 | Cumple | Enter advanced/backtracked; each new h1 received focus | Full reverse Tab traversal pending | Repeat with Enter |
| Reading, Inbox, Support | Layout | 1.4.10 | Cumple | At 320 CSS px document width equals viewport width | Actual 400% zoom and text-spacing overrides not tested | Repeat at 320 px |
| Reading, Inbox, Support, dark theme | Names, contrast, semantics | 1.4.3, 4.1.2 | Cumple | Settled-screen axe WCAG A/AA audits reported no violations | Automated evidence is not complete conformance evidence; light-theme manual audit pending | Audit both themes |
| Reading | Status region | 4.1.3 | No verificado | Role=status contains selected level and sample update | No real VoiceOver announcement test | Test with VoiceOver |
| New steps | Focus visibility and target sizes | 2.4.7, 2.4.11, 2.5.8 | No verificado | Card-sized labels, existing 44px actions, focus outlines, scroll margins | Complete manual focus-visibility and target-size audit pending | Traverse at narrow widths |
| Welcome | Skip link | 2.4.1 | Cumple | Welcome now provides `id="main-content"` matching the app skip link | Source inspection only | Activate Skip to content |

This evidence does not establish WCAG conformance. Screen-reader behavior,
authenticated persistence against live Firestore, real email setup/delivery, and
real GitHub starring remain unverified. Temporary viewport overrides were reset.


## Feed access correction, 2026-10-03 (superseded the same day, see the last section)

The signed-out `/feed` route no longer mounts `FeedContainer` or `useGuestFeed`.
Legacy area choices, and drafts saved when sign-in starts, remain onboarding
inputs only. A fresh visit, a revisit with old interests, and a reload after
finishing the welcome all show the welcome until an authenticated, onboarded
session exists. The final Sign in action uses the existing Base UI dialog;
cancelling it keeps the support screen visible and restores focus to that action.

Verification:

- The 106 targeted tests passed; the full suite passed all 3,204 tests.
- ESLint passed for the changed frontend and test files. Production build passed,
  with existing bundle-size warnings.
- `npm run check` passed secret scanning and stopped at 2,178 lint errors in the
  existing generated files under `landing/dist`. No harness, configuration,
  dependency, or environment changes were made to bypass them.
- Browser reproduction used a temporary server on port 5174 and a test-only
  two-area legacy draft. No cards or backend requests appeared before sign-in,
  including after completing the welcome and reloading.
- The temporary server and draft were removed. Axe was injected for diagnostics
  and removed after each audit; no diagnostic code remains in the application.
- No real account sign-in, registration, screen reader, Safari session, or
  production deployment was tested. Authenticated routing is covered by existing
  tests and the unchanged `ProtectedRoute` boundary.

| Page or flow | Component | WCAG criterion | Result | Evidence | Defect or limitation | Retest |
| --- | --- | --- | --- | --- | --- | --- |
| Signed-out `/feed`, old interests | Welcome landmark and heading | 1.3.1, 2.4.6 | Cumple | Fresh load and reload rendered the welcome h1, no paper cards; structure tests passed | Real screen reader not tested | Reload with a legacy two-area draft |
| Areas → Topics → Reading → Inbox → Support | Shared controls | 2.1.1, 2.4.3 | Cumple | Enter advanced each step and moved focus to its h1 | Existing intro animations were not fully re-audited | Repeat with keyboard |
| Support → Sign in → Escape → Sign in | Existing Base UI dialog | 2.1.1, 2.4.3, 2.4.7, 2.4.11 | Cumple | Tab reached the visibly outlined action; focus entered Close, cycled inside the dialog, and returned to Sign in on Escape; retry worked | Provider authentication itself not exercised | Repeat Tab, Enter, Escape |
| Support at 320 CSS px | Final action and Back | 1.4.10, 2.5.8 | Cumple | Document and viewport both 320 px; controls fit between x=16 and x=252 and were 44 px tall | Actual 400% browser zoom not tested | Repeat at 320 px |
| Support and sign-in dialog, light theme | Semantics and contrast | 1.4.3, 4.1.2 | No verificado | Axe WCAG A/AA audits reported zero violations | Manual review items remained for aria-prohibited-attr / aria-hidden-focus; dark theme and a real screen reader not tested | Complete assistive-technology review |

This evidence does not establish WCAG conformance.


## Email digest opt-in, 2026-10-03

The Inbox screen replaced its "Sign in to set up email updates" button with an
opt-in switch, and its illustration with an envelope that opens once (seal,
flap, a real paper rising, under three seconds; drawn open with reduced
motion). Its copy now names institutions rather than journals, which are not a
followable type.

Verification:

- Full suite: 3,207 tests passed. ESLint passed for the changed files.
- In the browser: the whole row toggles the switch; Space toggles it from the
  keyboard; the primary action and the envelope's label follow it; the header
  Sign in stored `emailDigest: true` in the draft and opened the dialog, and
  Escape closed it. The test draft was removed afterwards.
- Not verified: `firestore.rules` is changed but not deployed, so on production
  the onboarding write carrying `emailDigestOptIn` is refused until the rules
  are deployed. The end-to-end path (account creation, first follow, Worker
  subscription, delivery) has not been run against live Firebase or the Worker.
  No screen-reader test; reduced motion checked from source only.

Later the same day the Reading screen lost its illustrative sample and the
status region that announced it (the row above about 4.1.3 no longer applies):
the native radios announce the chosen level themselves. The Inbox screen lost
its lede, and the envelope's letter its field-and-year line.

The welcome's header no longer carries a Sign in button; the last screen's
action is the only way into the sign-in dialog from the welcome, so someone who
already has an account passes the screens (the areas have to be answered)
before reaching it.

The Support screen's GitHub mark became a browser illustration of the
repository: a cursor crosses to the Star button, the page zooms into it, the
star fills, and the page zooms back, once, in four seconds, on a single motion
value (drawn starred and at rest with reduced motion). It is decoration
(`aria-hidden`) and stars nothing; the "Star on GitHub" link under it is
unchanged. It shows no star count, and the optional-note line was removed.
From 761 px up the browser sits beside its sentence and link in a row, enlarged;
narrower viewports stack them.


## Guest feed restored, 2026-10-03

The feed access correction above was reverted on request. `GuestFeedPage` again
shows the welcome only while no answer is stored (`interests === null`) and
otherwise mounts `FeedContainer` over `useGuestFeed` in public mode, with the
theme control, the interests chip, and a Sign in button in its header. The
welcome's last action is "Start exploring papers": the page leaves (or, with
reduced motion, hands over at once) and its answer, including `readingLevel`
and `emailDigest`, is stored; the header's areas sheet keeps both when it
rewrites the areas. The welcome has no sign-in control. The earlier notes that
the header Sign in was removed and that the last action opens the sign-in
dialog describe the welcome before this change.

Verification:

- Full suite: 3,207 tests passed after restoring the guest-feed assertions the
  correction had inverted. ESLint passed for the changed files.
- In the browser, from an empty draft: the welcome's header held only the theme
  control; the actions read Continue through Inbox and "Start exploring papers"
  on Support; pressing it mounted the guest feed with twelve physics papers and
  the header's interests chip and Sign in; Sign in opened the dialog; a reload
  stayed on the feed. The stored draft held the area and the reading level.
- Not verified: keyboard-only traversal of the restored guest feed, a
  screen-reader pass, and the leave transition's feel (the preview pane was
  hidden and throttled animation frames).
