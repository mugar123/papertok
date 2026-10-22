import type { WorkerEnv } from './env.ts';

import { runEmailNotificationSchedule } from './email-notifications.ts';
import { OPENALEX_PREFETCH_CRON, prefetchOpenAlexFeedLanes } from './openalex-prefetch.ts';
import { PAPER_HARVEST_CRON } from './paper-harvest.ts';
import { handleRequest, routeForLog } from './router.ts';
import { captureWorkerResponseFailure } from './error-tracking.ts';

// Unbound and unused. Kept only so that a later, separate change can delete the
// class with a `deleted_classes` migration.
export { KimiBudgetLedger } from './kimi-budget-ledger.ts';
export { EmailDeliveryLedger } from './email-delivery-ledger.ts';
export { RequestQuotaLedger } from './request-quota-ledger.ts';
export { PaperRewriteSession } from './ai-rewrite-session.ts';

export default {
  // Workers Logs keeps console lines only (wrangler.toml turns invocation logs
  // off), so every refusal and failure leaves this one line. Some route
  // handlers log their own console.error line with the detail.
  async fetch(request: Request, env: WorkerEnv, context?: Pick<ExecutionContext, 'waitUntil'>) {
    // An uncaught throw reaches the reader as Cloudflare's 500 page, so it is
    // logged as a 500 too.
    let status = 500;
    try {
      const response = await handleRequest(request, env, context);
      status = response.status;
      captureWorkerResponseFailure(status);
      return response;
    } finally {
      if (status === 429 || status >= 500) {
        console.warn(JSON.stringify({ route: routeForLog(new URL(request.url).pathname), status }));
      }
    }
  },
  // `cron` names the trigger. The 00:05 UTC one prefetches the feed's OpenAlex
  // lanes and the 02:30 UTC one starts the paper harvest; neither runs a digest.
  // Every other trigger runs the email schedule.
  async scheduled(controller: Pick<ScheduledController, 'scheduledTime'> & Partial<Pick<ScheduledController, 'cron'>>, env: WorkerEnv, context: Pick<ExecutionContext, 'waitUntil'>) {
    if (controller.cron === OPENALEX_PREFETCH_CRON) {
      context.waitUntil(prefetchOpenAlexFeedLanes(env, controller.scheduledTime));
      return;
    }
    if (controller.cron === PAPER_HARVEST_CRON) {
      // One instance per UTC day: a repeated trigger finds the id taken.
      const id = `harvest-${new Date(controller.scheduledTime).toISOString().slice(0, 10)}`;
      if (env.PAPER_HARVEST) context.waitUntil(env.PAPER_HARVEST.create({ id }).then(() => undefined, (error: unknown) => console.error('Paper harvest did not start', error)));
      else console.error('Paper harvest did not start: PAPER_HARVEST is not bound');
      return;
    }
    context.waitUntil(runEmailNotificationSchedule(env, controller.scheduledTime));
  },
};
