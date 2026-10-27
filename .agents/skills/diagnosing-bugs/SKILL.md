---
name: diagnosing-bugs
description: >
  Diagnose a PaperTok bug, failing check or regression before patching it.
  Establish an observable failure, trace the owning layer, test the cause
  and verify the original symptom. Use for reports of broken, throwing,
  stuck, stale or unexpectedly slow behavior; not for ordinary feature work.
---

# Diagnosing bugs

Fix the owner of the wrong behavior. A guard in each caller, a forced rerender
or a longer timeout may hide the symptom while leaving the defect intact.

## Establish the failure

Identify the user's trigger and expected versus observed result. Prefer an
existing focused test, recorded input, local request or browser interaction
that exercises that path. Reading an error may guide investigation, but does
not establish that the proposed fix works.

Keep the reproduction small and observable. A check that only says "did not
crash" cannot catch missing results, stale account data or an incorrect paper.
If live behavior cannot be reproduced locally, label that limitation and use
available evidence; do not silently replace it with a different bug.

## Locate and test the cause

- Read producers and consumers across the affected contract. Identify whether
  the failure begins in provider input, normalization, shared state, ranking,
  rendering, Worker policy or persistence before choosing the edit.
- For account changes or restart failures, inspect stored and in-flight state
  as well as code. Clearing a cache may identify a cause; it is not a production
  fix by itself.
- State a hypothesis and the observation that would disprove it. Change one
  relevant variable at a time, then rerun the original reproduction.
- Temporary instrumentation must answer a specific question. Keep probes
  outside the checkout where possible, redact credentials and personal data,
  and remove temporary source logging before handoff.
- Search callers for the same defect. Repair affected callers within the task,
  without turning the search into an unrelated refactor.

## Prove the repair

Show that the original symptom changed as expected. For behavioral regression
tests, confirm the assertion can detect the old failure, then verify the fix.
Preserve trust-boundary validation and valid degraded-provider behavior.
Use [Repo QA](../repo-qa/SKILL.md) for remaining checks and
[Review](../review/SKILL.md) for the final diff.

If evidence requires unavailable access or a user decision, explain the exact
missing fact and continue independent work. Do not weaken checks or claim a
root cause from a plausible explanation alone.
