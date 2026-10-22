import type { WorkerEnv } from './env.ts';

import { OPENALEX_TOPIC_LEAVES } from '../src/utils/areaAccent.ts';
import { openAlexTopicLaneUrl, openAlexWorkingPapersUrl } from '../src/utils/openAlexFeedLanes.ts';
import { handleOpenAlex } from './openalex-api.ts';

// The trigger in wrangler.toml that runs this instead of the email schedule:
// five minutes after both the ledger's day and OpenAlex's budget reset at
// 00:00 UTC. Change both together.
export const OPENALEX_PREFETCH_CRON = '5 0 * * *';
// The pages a reader opening the feed reaches first.
const PREFETCH_PAGES = 3;

/**
 * The first pages of the feed's two OpenAlex lanes, fetched once a day into the
 * shared store (PAP-88): the single-leaf topic lane for each measured leaf, and
 * the working-paper series. A reader whose ranked interests hold exactly one of
 * those leaves sends the same URL (`openAlexTopicLaneUrl` reads only the leaves
 * with a topic list), so those pages are served all day without a reservation,
 * also once the feed tier has closed. Readers with two or more such leaves
 * send an interleaved filter this does not cover.
 *
 * It saves almost no units: since the shared store, a page costs one unit a
 * day however many readers ask for it, and this pays that unit for pages
 * nobody may read. What it buys is pages that stay served after the feed tier
 * closes, and no wait for the first reader of the day.
 *
 * Each URL goes through the relay itself, so the cache keys, the reservation
 * (`feed.list`) and the store write are a reader's. Sequential and never
 * retried; the run stops at the first answer other than 200 or 404, since a
 * refusal or an outage would refuse the rest too. A page already stored costs
 * nothing. One log line, with counts only.
 */
export async function prefetchOpenAlexFeedLanes(env: WorkerEnv, scheduledTime: number) {
  if (!env.NOTIFICATION_STORE?.getWithMetadata) {
    console.log(JSON.stringify({ job: 'openalex-prefetch', skipped: 'NO_SHARED_STORE' }));
    return;
  }
  const pages = Array.from({ length: PREFETCH_PAGES }, (_, index) => index + 1);
  const urls = [
    ...OPENALEX_TOPIC_LEAVES.flatMap(leaf => pages.map(page => openAlexTopicLaneUrl([leaf], page, scheduledTime)!)),
    ...pages.map(page => openAlexWorkingPapersUrl(page, scheduledTime)),
  ];
  let answered = 0;
  let stoppedAt: number | string | null = null;
  for (const url of urls) {
    try {
      const response = await handleOpenAlex(new Request(`https://papertok.internal/openalex${url.pathname}${url.search}`), env);
      await response.text();
      if (response.status !== 200 && response.status !== 404) {
        stoppedAt = response.status;
        break;
      }
      answered += 1;
    } catch {
      stoppedAt = 'error';
      break;
    }
  }
  console.log(JSON.stringify({ job: 'openalex-prefetch', pages: urls.length, answered, stoppedAt }));
}
