import type { WorkerEnv } from './env.ts';

import { runEmailNotificationSchedule } from './email-notifications.ts';
import { handleRequest, routeForLog } from './router.ts';

// Unbound and unused. Kept only so that a later, separate change can delete the
// class with a `deleted_classes` migration.
export { KimiBudgetLedger } from './kimi-budget-ledger.ts';
export { EmailDeliveryLedger } from './email-delivery-ledger.ts';
export { RequestQuotaLedger } from './request-quota-ledger.ts';

export default {
  // Workers Logs keeps console lines only (wrangler.toml turns invocation logs
  // off), so every refusal and failure leaves this one line. Some route
  // handlers log their own console.error line with the detail.
  async fetch(request: Request, env: WorkerEnv) {
    // An uncaught throw reaches the reader as Cloudflare's 500 page, so it is
    // logged as a 500 too.
    let status = 500;
    try {
      const response = await handleRequest(request, env);
      status = response.status;
      return response;
    } finally {
      if (status === 429 || status >= 500) {
        console.warn(JSON.stringify({ route: routeForLog(new URL(request.url).pathname), status }));
      }
    }
  },
  async scheduled(controller: Pick<ScheduledController, 'scheduledTime'>, env: WorkerEnv, context: Pick<ExecutionContext, 'waitUntil'>) {
    context.waitUntil(runEmailNotificationSchedule(env, controller.scheduledTime));
  },
};
