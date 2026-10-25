---
name: review
description: >
  Review a PaperTok diff for wrong behavior, unsafe contracts, weak tests and
  code that should not exist. Runs in a fresh context that did not write the
  change. Use before handing off or publishing a repository change, for PR
  review, or when asked to review, deslop or simplify a diff. Reports findings;
  the caller decides and edits.
---

# Review

Find what is wrong or unproven in the change, then what can be deleted.
Correctness, security, data integrity and accessibility come before size.

## Who reviews

The author's own context is self-review: it remembers the intent and reads the
diff as it meant it. Run the review in a fresh context that receives only the
diff, the request and the repository: the `reviewer` subagent in Claude Code,
or a new session in another tool. Its findings go back to the author, who fixes
or answers each one. Say which kind of review ran.

## Scope

Review the complete task: commits on the branch against its base, staged and
unstaged changes, and the contents of untracked files. Take the purpose from
the request, not from the diff. Check that every changed file serves it and
separate the task's changes from user-owned work and earlier debt.

Read the callers, consumers and contracts the diff can affect. Lint, types and
knip already run in `npm run check`; do not spend findings on what they catch.
For behavior changes, use [the documentation owners](../../../ARCHITECTURE.md#documentation-owners)
and [maintenance workflow](../../../CONTRIBUTING.md#documentation-maintenance) to
review existing claims and Mermaid diagrams against the final diff, even when
the author left those documents unchanged. Report contradictions with the claim,
source location and smallest correction; verify any no-impact explanation.

## Behavior

- Trace concrete inputs through output, storage, errors and retries. Missing,
  empty, zero and unknown are different values; check each one that applies.
- Look for cross-account state, unverified identity, personal data in shared
  caches, unbounded provider calls, lost metadata provenance and callers the
  change broke.
- A risky change is usually safe because of one fact ("the rules reject that
  write", "the provider retries 5xx"). Name that fact and say how far it is
  established: claimed, cited at `file:line`, traced step by step, run in a
  test, or reproduced in the app. A claim alone establishes nothing.

## Tests

For each changed or added test, ask whether it would still pass if every
function it imports returned `undefined`. If so, it observes nothing: the
assertion is missing, only checks a mock was called, restates a constant, or
compares the code's output with itself. The expected value must be written in
the test, independently of the implementation. A test that reads source text
is not a test (the lint rule rejects it).

## What should not exist

- Comments that narrate the next line, restate a name, describe history or
  promise behavior the code does not have. Keep comments that state a reason
  or constraint the code cannot show.
- Defensive checks and `try`/`catch` on trusted internal paths, fallbacks that
  turn invalid data or unexpected errors into success, and guards added in each
  caller instead of fixing the owner.
- Casts, `!` and widened types used to get past the compiler.
- Wrappers, options, registries and state with a single use and no boundary to
  protect; values derivable from route, query or existing state; a second
  shape for the paper contract.
- Code the change made obsolete and did not delete.

## Each pass must be able to fail

A pass that reports nothing states what it checked: the callers it read, the
inputs it traced, the tests it questioned. A pass that could not have found
anything did not run.

## Output

List findings most severe first, each with `file:line`, the concrete failure
(input and wrong result) and the smallest fix. Mark each one blocking or not.
Then list what is unverified. No praise, no summary of the diff, no style
findings the tools already enforce. Zero findings is a valid review.
