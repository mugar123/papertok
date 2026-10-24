# Rules tests

`tests/firestore.rules.test.ts` runs the real `firestore.rules` against the
Firestore emulator and asserts on what the rules engine actually decides.

`npm test` runs Node tests under `src/`, `worker/`, `proxy/`, `scripts/`
and `eslint-rules/`. This suite separately checks Firestore authorization.

## Running

```bash
npm run test:rules
```

That wraps `firebase emulators:exec`, so the emulator starts and stops around
the run. It is deliberately outside the `npm test` glob,
because it needs the emulator and would otherwise fail in environments without
one. If `FIRESTORE_EMULATOR_HOST` is unset the file throws rather than
reporting a pass without evaluating a single rule.

## Requirements

The emulator needs a JRE. firebase-tools 15 refuses anything older than Java 21.
On this machine it was installed with:

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

## The expression limit

The rules engine evaluates at most 1000 expressions per request. A request over
that budget fails with an expression-limit error rather than a clean denial, and
denial messages can mention the limit for unrelated reasons, so only `allowed`
is a reliable signal when a test measures headroom.

Publishing a list exceeded this budget with one realistic paper, which is why
the Worker writes public lists. `P19: the heaviest highlight a reader can write is a clean allow`
and `P20: an AI annotation at full length is still a clean allow` write the
largest highlight the rules admit. If a change to `firestore.rules` makes either
fail, the highlights rule has run out of budget.
