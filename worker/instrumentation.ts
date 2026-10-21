import { DurableObject } from 'cloudflare:workers';
import { instrumentDurableObjectWithSentry, withSentry } from '@sentry/cloudflare';
import type { WorkerEnv } from './env.ts';
import handler from './index.ts';
import { EmailDeliveryLedger as EmailLedger } from './email-delivery-ledger.ts';
import { RequestQuotaLedger as QuotaLedger } from './request-quota-ledger.ts';
import { PaperRewriteSession as RewriteSession } from './ai-rewrite-session.ts';
import { workerSentryOptions } from './error-tracking.ts';

export { KimiBudgetLedger } from './kimi-budget-ledger.ts';

// The SDK requires native DurableObject subclasses. Storage and quota behavior
// stay in the existing implementations; these adapters own instrumentation only.
class InstrumentedEmailLedger extends DurableObject<WorkerEnv> {
  private readonly ledger: EmailLedger;
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.ledger = new EmailLedger(ctx);
  }
  fetch(request: Request) { return this.ledger.fetch(request); }
  alarm() { return this.ledger.alarm(); }
}

class InstrumentedQuotaLedger extends DurableObject<WorkerEnv> {
  private readonly ledger: QuotaLedger;
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.ledger = new QuotaLedger(ctx);
  }
  fetch(request: Request) { return this.ledger.fetch(request); }
  alarm() { return this.ledger.alarm(); }
}

class InstrumentedRewriteSession extends DurableObject<WorkerEnv> {
  private readonly session: RewriteSession;
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.session = new RewriteSession(ctx, env);
  }
  fetch(request: Request) { return this.session.fetch(request); }
}

export const EmailDeliveryLedger = instrumentDurableObjectWithSentry(workerSentryOptions, InstrumentedEmailLedger);
export const RequestQuotaLedger = instrumentDurableObjectWithSentry(workerSentryOptions, InstrumentedQuotaLedger);
export const PaperRewriteSession = instrumentDurableObjectWithSentry(workerSentryOptions, InstrumentedRewriteSession);
export default withSentry(workerSentryOptions, handler);
