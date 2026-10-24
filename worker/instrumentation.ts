import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { instrumentDurableObjectWithSentry, instrumentWorkflowWithSentry, withSentry } from '@sentry/cloudflare';
import type { WorkerEnv } from './env.ts';
import handler from './index.ts';
import { EmailDeliveryLedger as EmailLedger } from './email-delivery-ledger.ts';
import { RequestQuotaLedger as QuotaLedger } from './request-quota-ledger.ts';
import { PaperRewriteSession as RewriteSession } from './ai-rewrite-session.ts';
import { runPaperHarvest } from './paper-harvest.ts';
import { workerSentryOptions } from './error-tracking.ts';

// Unbound and unused. Kept only so that a later, separate change can delete the
// class with a `deleted_classes` migration.
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

class HarvestWorkflow extends WorkflowEntrypoint<WorkerEnv, { lanes?: string[] } | undefined> {
  run(event: Readonly<WorkflowEvent<{ lanes?: string[] } | undefined>>, step: WorkflowStep) { return runPaperHarvest(this.env, event, step); }
}

export const EmailDeliveryLedger = instrumentDurableObjectWithSentry(workerSentryOptions, InstrumentedEmailLedger);
export const RequestQuotaLedger = instrumentDurableObjectWithSentry(workerSentryOptions, InstrumentedQuotaLedger);
export const PaperRewriteSession = instrumentDurableObjectWithSentry(workerSentryOptions, InstrumentedRewriteSession);
export const PaperHarvestWorkflow = instrumentWorkflowWithSentry(workerSentryOptions, HarvestWorkflow);
export default withSentry(workerSentryOptions, handler);
