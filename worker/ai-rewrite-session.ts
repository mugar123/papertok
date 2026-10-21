import { captureWorkerException } from './error-tracking.ts';
import type { WorkerEnv } from './env.ts';
import { AIExplanationError } from './ai-explanation.ts';
import { handlePaperRewrite } from './ai-rewrite.ts';
import { corsHeaders, json } from './http.ts';

/**
 * Runs one rewrite with the Durable Object CPU budget. The edge Worker relays
 * the response body without decoding it; identity, quota and cache decisions
 * stay in the existing rewrite handler. No state is persisted by this object.
 */
export class PaperRewriteSession {
  declare env: WorkerEnv;

  constructor(_state: unknown, env: WorkerEnv) {
    this.env = env;
  }

  async fetch(request: Request) {
    const headers = corsHeaders(request.headers.get('origin') || '', this.env);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);
    try {
      return await handlePaperRewrite(request, this.env, headers);
    } catch (error) {
      captureWorkerException(error, 'rewrite');
      const known = error instanceof AIExplanationError;
      return json(
        {
          code: known ? error.code : 'AI_UNAVAILABLE',
          ...(known && error.quota ? { quota: error.quota } : {}),
        },
        known ? error.status : 502,
        { ...headers, 'cache-control': 'no-store' },
      );
    }
  }
}
