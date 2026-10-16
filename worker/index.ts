import type { WorkerEnv } from './env.ts';

import { runEmailNotificationSchedule } from './email-notifications.ts';
import { handleRequest } from './router.ts';

// Unbound and unused. Kept only so that a later, separate change can delete the
// class with a `deleted_classes` migration.
export { KimiBudgetLedger } from './kimi-budget-ledger.ts';
export { EmailDeliveryLedger } from './email-delivery-ledger.ts';
export { RequestQuotaLedger } from './request-quota-ledger.ts';

export default {
  fetch: handleRequest,
  async scheduled(controller: Pick<ScheduledController, 'scheduledTime'>, env: WorkerEnv, context: Pick<ExecutionContext, 'waitUntil'>) {
    context.waitUntil(runEmailNotificationSchedule(env, controller.scheduledTime));
  },
};
