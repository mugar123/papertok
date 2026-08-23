// Deploy flags whose value is a product decision rather than an environment
// detail. Such a flag has no reviewable home when it lives only in a GitHub
// Actions repository variable: it can be flipped, or silently lost, without a
// commit, and the bundle that ships then disagrees with the decision on record
// with nothing in the pipeline to notice. That has already happened to
// `VITE_SCOPUS_ENABLED` twice, in both directions, and a later audit read the
// resulting state backwards because the decision only existed in prose.
//
// Declaring the intent here gives it a versioned home next to its reason, and
// lets `vite build` refuse a bundle that disagrees with it.
export const DECLARED_DEPLOY_FLAGS = Object.freeze({
  // Off by measurement, not by omission. STATE.md, «Scopus: estudio cerrado»
  // (2026-08-22): of 75 Scopus papers across three fields, OpenAlex already
  // held 75, so Scopus contributes nothing as a discovery source. Without an
  // institutional token it is also served the STANDARD view, so its records
  // arrive with no abstract — `/health/scopus` reports `hasAbstract: false` —
  // which means no summary on the card and no AI explanation either.
  //
  // Turning it on is a product decision, so it is made here, in the commit
  // that records why, not in a repository variable nobody reviews.
  VITE_SCOPUS_ENABLED: false,
});

// Mirrors how the app itself reads these flags. `ScopusAdapter.js` coerces with
// a bare `=== 'true'`: it does not trim, and it does not accept 'TRUE' or '1'.
// The guard has to coerce identically — normalizing more than the app would
// reject builds the app would have run correctly, and normalizing less would
// pass a bundle that disagrees with the declared intent. It also makes an
// absent variable and 'false' the same state, which is what they are.
export function isDeployFlagEnabled(value) {
  return (value ?? '') === 'true';
}

export function findDeployFlagDrift(env = {}, declared = DECLARED_DEPLOY_FLAGS) {
  return Object.entries(declared)
    .map(([name, expected]) => ({ name, expected, actual: isDeployFlagEnabled(env[name]) }))
    .filter(({ expected, actual }) => expected !== actual);
}

export function describeDeployFlagDrift(drift) {
  return drift
    .map(({ name, expected, actual }) => (
      `- ${name}: declared ${expected}, this build would ship ${actual}`
    ))
    .join('\n');
}
