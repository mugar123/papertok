# Security Policy

## Reporting a vulnerability

Please do not open a public issue for an unpatched vulnerability or include credentials,
personal data, or exploit details in a public discussion.

Report security concerns privately through
[GitHub's private vulnerability reporting](https://github.com/mugar123/papertok/security/advisories/new).
Include the affected component, reproduction steps, expected impact, and any suggested
mitigation. You should receive an acknowledgement within seven days.

## Supported version

PaperTok is currently supported from the latest commit deployed from `main`. Security fixes
are applied to `main` and the Cloudflare Worker; older static deployments are not maintained.

## Credential handling

Provider credentials belong in Cloudflare Worker secrets. Never include a live credential in
an issue, pull request, browser-visible `VITE_*` variable, diagnostic script, or public proxy.

Firebase web configuration is an intentional public identifier, not an authorization secret.
Access control must remain enforced by Firebase Authentication and the deployed Firestore rules.
