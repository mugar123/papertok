# Worker decisions

## Trust boundaries

- Browser-safe normalization can be shared with the frontend; secret-dependent requests,
  authorization, quotas and delivery stay server-side. Do not import browser-only modules
  into the Worker to reuse one helper.
- Validate origins, methods, payload size, identifiers and remote URLs before fetching.
  A crawler share route may legitimately have no Origin; that exception does not make a
  protected route public. CORS does not authenticate a request.
- Require verified Firebase identity for protected user-specific AI and notification routes.
  Derive the notification email and other sensitive identity fields from verified claims,
  not from request JSON. Fail closed for invalid credentials and degrade for provider downtime.

## Caches, quotas and delivery

- Cache keys describe the normalized, clamped and filtered parameters actually sent to the
  provider, plus output-affecting provider, model, prompt version, level, language and
  normalized paper identity where applicable.
  Raw request variations must not create new quota spend for the same upstream request.
- Include user identity in personal caches or avoid caching those responses globally.
  Cache an outage-driven fallback briefly rather than giving it the healthy result's TTL;
  recovery must not wait behind a long-lived degraded answer.
- Respect Retry-After and the total request deadline. Bound fan-out and retries across the
  whole operation, not only each fetch. Missing provider data must not become fabricated data.
- Shared and paid-provider quotas use the existing atomic ledger. Keep hard budget caps and
  reserve before spending; one process's counter or KV read-then-write is not an atomic limit.
- Digest delivery must remain idempotent and deduplicate papers by stable identity. Preserve
  unsubscribe state and resumable progress; retries must not resend successful deliveries.

## Contracts and AI

- All active AI providers implement the same response contract. Switching providers must not
  change the browser's parser or bypass budget enforcement. Inspect configured providers
  rather than assuming an old provider list is still current.
- Prompts, structured output, emails and generated copy are English. Accept and ignore legacy
  `language: 'es'` input rather than rejecting old clients.
- State the available evidence honestly: an abstract is not full text. Preserve LaTeX
  delimiters and the endpoint's structured JSON or streaming contract; do not flatten a
  stream or add prose outside JSON to accommodate a provider.
- A route change includes method and CORS handling, normalized input, stable error mapping,
  focused behavior tests and compatible callers. Update its public contract and environment
  documentation when those change, then verify the Worker dry-run as well as frontend callers.
- Worker dry-run proves packaging, not production secrets, origin configuration, live quota
  behavior or delivery. Mark those separately in verification evidence.
