---
name: correct
description: >
  Turn a mistake that agents or contributors keep making in PaperTok into a
  check that makes it impossible. Use when the user corrects the same kind of
  mistake a second time, when a review finding repeats an earlier one, or when
  asked to "correct", "encode" or "stop this from happening again".
---

# Correct

A rule in prose fails whenever a reader skips it. Make the next contributor,
who reads only the files in front of them and copies the nearest example,
unable to repeat the mistake.

## Find the class

Collect the instances: the correction in this conversation, earlier commits,
reverts and review comments, and `docs/agents/papercuts.md`. A class exists
once it has happened twice. State it as one sentence that a check could test.

## Fix it at the highest level that works

1. **Structure.** Give the state one owner, delete the old way of doing it and
   the dead code an agent would copy, hide internals so the wrong import fails.
2. **Types.** Make the bad value impossible to write.
3. **Lint.** Add a rule to `eslint.config.ts` whose message names what to do
   instead. Every existing violation is fixed in the same change; the repository
   keeps no baseline of known findings.
4. **Test.** Assert the observable behavior that broke, with a literal expected
   value.
5. **AGENTS.md.** Only for a judgment call no check can express. Nothing fails
   when it is skipped, so say so in the papercuts ledger as well.

Changing `eslint.config.ts`, `knip.jsonc`, tsconfig files or `.github/` needs
the user's approval; propose the change and its evidence.

## Prove it

Show the new check failing on a real past instance (revert one fix locally or
use the original code as a fixture), then passing on the repaired tree. Run it
through the command CI runs, not a one-off invocation.

## Keep the ledger current

`docs/agents/papercuts.md` lists classes that no check enforces yet. Remove an
entry when its check lands; add one when you find a class you cannot encode in
this change. A rule in AGENTS.md that a check now enforces names that check.

Reply with each class, its evidence, the level chosen and why a higher level
did not work.
