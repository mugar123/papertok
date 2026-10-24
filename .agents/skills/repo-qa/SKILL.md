---
name: repo-qa
description: >
  Choose and report verification for a PaperTok change before handoff, commit
  or publication. Covers existing checks, behavior tests, UI accessibility,
  frontend and Worker contracts, and documentation or skill validation.
  Use after repository edits or when asked to verify a change.
---

# Repo QA

Choose checks from what changed and what could break. Inspect the actual
package scripts and CI rather than reconstructing commands from memory.
Use the existing environment and the setup documented in the repository.
Before any commit or publication, run `npm run check`. An uncommitted
instructions-only handoff can use the documentation checks below.

## Select checks

| Change | Required evidence |
| --- | --- |
| Instructions, skills or prose only | Review activation and instruction conflicts; validate skill frontmatter and local links; run `git diff --check` and `npm run security:secrets`. Application builds do not verify prose. |
| Runtime behavior | Run the closest existing tests first, then `npm run check` before commit or publication. Shared feed or routing changes need the full check before handoff too. |
| Executable tooling or quality gate | Exercise the actual invoked command and a concrete invalid case it must reject. Verify its caller and intended file coverage. A script nobody invokes is not a gate. |
| Firestore rules or permissions | Run `npm run test:rules` as well as the relevant application checks; `npm run check` does not include the rules emulator. Test allowed and denied ownership cases. |
| Worker route or frontend/Worker contract | Check valid and invalid requests and affected callers, documentation, `npm run check` and Worker packaging. State whether live configuration was verified separately. |
| UI behavior or styling | Check relevant states in the browser and manual keyboard behavior as described below, plus the applicable code checks. |

`npm run check` runs the secret scan, ESLint (including the type-aware rules), knip,
TypeScript checks, Node tests, Vite build and `npm run worker:deploy:dry-run`. A dry-run
packages the Worker without deploying. Do not report it as a live API or production check.
In Claude Code, a Stop hook also lints the files changed on the branch and in the working
tree; it does not replace the full check.

For a focused Node test, use `node --test <affected-file.test.ts>` with exact
paths found in the checkout. Add tests only when the task changes behavior
that needs coverage. Call the module the way its users do and state the expected
output independently of the implementation; the test must be able to detect the
reported defect or broken contract. Behavior inside a `.tsx` component is tested
through the `.ts` module that owns it, never by matching the component's source.

## UI evidence

Read the accessibility rules in the root and frontend instructions, and the
design system. Walk the affected loading, empty, success, degraded, error and
retry states where applicable. Check desktop and mobile layouts when impacted.
Use Tab, Shift+Tab, activation keys and Escape where relevant; check focus
order, visibility, dialog restoration, labels and announced status changes.
Check contrast, reflow and reduced motion when affected. Use a screen reader
where available; otherwise record that limit. An axe result alone is insufficient.
Report affected flows, applicable criteria, manual checks, results and limits
in the handoff or PR.

## Preserve the verification signal

If a check fails, determine whether the task caused it or whether a missing
dependency, configuration or pre-existing defect prevents it. Do not weaken
the runner, fixture, assertions, timeout or lint coverage to obtain green.
Use documented local setup without changing production defaults. Remove
temporary debugging or verification edits and report them. A durable workaround
needs the user's approval under the root instructions.

Never count a skipped, unavailable or partially executed check as passed.
Distinguish synthetic fixtures, local packaging, browser observations and
live-provider evidence. Do not run quota-consuming diagnostics repeatedly
as a substitute for deterministic tests.

## Delivery

Review the final diff and untracked files for unrelated changes or temporary
artifacts. Report exact commands, outcomes, relevant manual interactions,
review findings and anything not verified. Evidence applies to the inspected
revision and working tree; subsequent edits require the affected checks again.
Keep findings in the response or requested PR. Do not create a report file
unless the user explicitly requests one. Keep any requested report local and unversioned.
