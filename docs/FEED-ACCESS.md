# Feed access

> **Superseded on 2026-10-03.** The restriction described below was reverted
> the same day: a signed-out visitor who has finished the welcome sees the guest
> feed built from the areas and topics they picked, and signing in is offered
> there rather than in the welcome. The current behavior is in
> `docs/ONBOARDING-PERSONALIZATION.md` ("Guest feed restored"). What follows is
> kept as the record of the restriction and of how it was verified.

`/feed` requires an authenticated session with completed account onboarding.
Signed-out visitors always see `GuestWelcome`, including devices with an old
`papertok_guestInterests` answer. Stored areas and topics are an onboarding draft,
not evidence of a session or completed account onboarding.

The welcome saves its choices before opening the existing sign-in dialog, both
from its final Sign in action and from the header. Cancelling or failing sign-in
leaves the welcome visible, with its choices intact and its final action usable.
It does not mount a guest paper feed or issue feed-provider requests.

Shared public paper, profile, list, and entity routes retain their existing
access rules. The change is limited to the signed-out `/feed` route.

## Verification

The regression checks cover the unconditional welcome, preserved draft choices,
the sign-in completion callback, the authenticated `ProtectedRoute` boundary,
and cancellation without hiding the welcome. Browser checks and their limits
are recorded below; they do not establish WCAG conformance.


Validation on 2026-10-03:

- `npm run check` passed: secret scanning, full ESLint, 3,192 tests, production
  build, and Worker deployment dry run. Build used the existing public repository
  variable `VITE_PAPER_API_BASE_URL=https://api.papertok.app` for this command only.
- A temporary browser preview reproduced the legacy two-area draft, completed
  the welcome using Enter, opened sign-in, cycled focus inside the dialog with
  Tab, cancelled with Escape, retried, and reloaded without revealing cards.
- The temporary preview server and test draft were removed. Axe diagnostics were
  injected only into the test tab and removed after each audit. No harness,
  environment-file, configuration, dependency, or logging changes were retained.

| Page or flow | Component | WCAG criterion | Result | Evidence | Defect or limitation | Retest |
| --- | --- | --- | --- | --- | --- | --- |
| Signed-out `/feed`, legacy interests | Welcome | 1.3.1, 2.4.6 | Cumple | Structure tests and browser reproduction showed the welcome h1 and no paper cards or provider fetches | Real screen reader not tested | Load `/feed` with a two-area legacy draft |
| Areas → Topics → Sign in → Escape → Sign in | Existing controls and Base UI dialog | 2.1.1, 2.4.3, 2.4.7, 2.4.11 | Cumple | Enter advanced the welcome; heading focus moved; dialog focus cycled; Escape returned focus to Sign in; the page stayed visible and retry worked | Real OAuth flow not exercised | Repeat with Tab, Enter and Escape |
| Final welcome step at 320 CSS px | Back and Sign in | 1.4.10, 2.5.8 | Cumple | Document width equalled the 320 px viewport; controls fit between x=16 and x=252 and were 44 px tall | Actual 400% browser zoom not tested | Repeat at 320 px |
| Final step and sign-in dialog | Automated A/AA audit | 1.4.3, 4.1.2 | No verificado | Axe reported zero violations | Manual-review items for aria-prohibited-attr / aria-hidden-focus remained; dark theme and real screen reader not tested | Complete assistive-technology review |

No full WCAG conformance claim is made. Real screen-reader use, Safari, and
account authentication were not verified during this change.
