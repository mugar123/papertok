# Cloudflare Worker Guide

This file applies to `worker/` and the Worker configuration in `wrangler.toml`.

## Responsibilities

The Worker protects secrets, applies quotas, validates requests, caches provider responses,
proxies APIs that are unsuitable for direct browser access, generates AI explanations, and
sends notification digests.

Keep browser-safe normalization in `src/` when it is shared by frontend and Worker code.
Keep secret-dependent behavior in `worker/`.

## Security

- Secrets must be Cloudflare secrets, never literals in source, `wrangler.toml`, or frontend
  environment variables.
- Validate origins, methods, payload size, identifiers, and remote URLs before fetching.
- Require and verify Firebase identity for user-specific AI and notification routes.
- Derive sensitive user fields, such as notification email, from verified identity rather
  than trusting request JSON.
- Fail closed for invalid credentials and fail gracefully for provider downtime.

## Caching and Quotas

- Include every output-affecting input in cache keys: language, model, prompt version, level,
  provider, and normalized paper identity where applicable.
- Do not cache personal responses under globally reusable keys.
- Respect provider `Retry-After` and avoid retry storms.
- Keep AI and email limits explicit. Paid fallback providers must retain hard budget caps.
- Scheduled email delivery must remain idempotent and deduplicate papers by stable identity.

## Route Changes

When adding or changing a route:

1. Add method and CORS handling.
2. Validate and normalize input.
3. Map provider errors to stable PaperTok error codes.
4. Add focused Worker tests.
5. Update `worker/README.md`, `.env.example` when relevant, and `docs/ARCHITECTURE.md`.
6. Verify both local tests and `npx wrangler deploy --dry-run` or a real authorized deploy.

## AI Output

- Gemini and Kimi must share the same output contract.
- PaperTok is English-only: prompts, schemas, system instructions, and generated copy are
  English. Accept and ignore a legacy `language: 'es'` input rather than rejecting it.
- Never claim full-text access when only an abstract was supplied.
- Preserve LaTeX delimiters and return structured JSON only.

