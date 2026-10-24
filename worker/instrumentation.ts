import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { WorkerEnv } from './env.ts';
import handler from './index.ts';
import { EmailDeliveryLedger as EmailLedger } from './email-delivery-ledger.ts';
import { RequestQuotaLedger as QuotaLedger } from './request-quota-ledger.ts';
import { PaperRewriteSession as RewriteSession } from './ai-rewrite-session.ts';
import { runPaperHarvest } from './paper-harvest.ts';
import { trackErrors } from './error-tracking.ts';

// Storage and quota behavior stay in the existing implementations; these
// adapters only report what escapes them.
export class EmailDeliveryLedger extends DurableObject<WorkerEnv> {
  private readonly ledger: EmailLedger;
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.ledger = new EmailLedger(ctx);
  }
  fetch(request: Request) { return trackErrors(this.env, this.ctx, 'durable_object', () => this.ledger.fetch(request)); }
  alarm() { return trackErrors(this.env, this.ctx, 'durable_object', () => this.ledger.alarm()); }
}

export class RequestQuotaLedger extends DurableObject<WorkerEnv> {
  private readonly ledger: QuotaLedger;
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.ledger = new QuotaLedger(ctx);
  }
  fetch(request: Request) { return trackErrors(this.env, this.ctx, 'durable_object', () => this.ledger.fetch(request)); }
  alarm() { return trackErrors(this.env, this.ctx, 'durable_object', () => this.ledger.alarm()); }
}

export class PaperRewriteSession extends DurableObject<WorkerEnv> {
  private readonly session: RewriteSession;
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.session = new RewriteSession(ctx, env);
  }
  fetch(request: Request) { return trackErrors(this.env, this.ctx, 'durable_object', () => this.session.fetch(request)); }
}

export class PaperHarvestWorkflow extends WorkflowEntrypoint<WorkerEnv, { lanes?: string[] } | undefined> {
  run(event: Readonly<WorkflowEvent<{ lanes?: string[] } | undefined>>, step: WorkflowStep) {
    return trackErrors(this.env, this.ctx, 'workflow', () => runPaperHarvest(this.env, event, step));
  }
}

export default {
  fetch(request, env, context) { return trackErrors(env, context, 'http', () => handler.fetch(request, env, context)); },
  scheduled(controller, env, context) { return trackErrors(env, context, 'schedule', () => handler.scheduled(controller, env, context)); },
} satisfies ExportedHandler<WorkerEnv>;
