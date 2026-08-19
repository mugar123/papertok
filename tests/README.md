# Rules tests

`tests/firestore.rules.test.js` runs the real `firestore.rules` against the
Firestore emulator and asserts on what the rules engine actually decides.

The assertions in `src/services/userProfileService.test.js` read the rules file
as text. Those catch a clause being deleted; they cannot catch a clause that was
never written — which is exactly how the pinned-list ownership check, the
`followerCount` freeze and the handle-freeing delete were all missing while the
text tests stayed green. This suite exists to close that gap.

## Running

```bash
npm run test:rules
```

That wraps `firebase emulators:exec`, so the emulator starts and stops around
the run. It is deliberately outside the `npm test` glob (`src/**`, `worker/**`),
because it needs the emulator and would otherwise fail in environments without
one. If `FIRESTORE_EMULATOR_HOST` is unset the file throws rather than
reporting a pass without evaluating a single rule.

## Requirements

The emulator needs a JRE (Java 11+). On this machine it was installed with:

```bash
brew install openjdk
```

`openjdk` is keg-only, so it is not on `PATH` by default. Either add it once:

```bash
echo 'export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"' >> ~/.zshrc
```

or prefix a single run with `PATH="/opt/homebrew/opt/openjdk/bin:$PATH"`.

The `temurin` cask also works but its installer needs `sudo`; the formula above
does not.

## Two limits shape these rules

Both were found by running this suite, not by reading documentation:

- **10 document accesses** per single-document request. Each pinned list costs
  one `get()` for its ownership check.
- **1000 expressions** per rule evaluation. This is the binding one: at eight
  pinned entries a profile write fails with an expression-limit error rather
  than a clean denial. Seven pass. The cap is six, one entry of slack, so the
  next clause added to `firestore.rules` does not start rejecting saves for
  users sitting at the cap.

If a change to `firestore.rules` makes `FIX A: the cap sits below the expression
budget, not on it` fail, the pinned-list cap has to come down.
