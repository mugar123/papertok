import { getLocalTopicEntity } from './openAlexService.js';
import { getEntityWikiInfo } from './wikiService.js';

/**
 * Warms the Wikipedia summary a topic page will ask for, before the page
 * exists.
 *
 * Measured on the deployed site, signed in (2026-09-11): after a tap on a
 * topic pill the explorer mounted at ~330 ms and only then asked Wikipedia,
 * which answered at ~715 ms; the hero painted at 230 px and, once the
 * summary landed, grew 171 px over 360 ms, pushing the tabs and the list
 * down — fourteen layout shifts after a transition that had itself run at
 * 60 fps. That growth is what read as the transition "not being smooth".
 *
 * The arguments mirror EntityExplorer's own call exactly, so the answer
 * lands in `wikiService`'s cache under the key the page will look up. Local
 * topics (the arXiv areas) know their titles without a request; anything
 * else falls back to the pill's own label, which is what the page shows
 * before its entity resolves.
 */
const inFlight = new Map();

export function topicWikiRequest(topic, language = 'es') {
  if (!topic) return null;
  const type = topic.type === 'concept' ? 'concept' : topic.type;
  if (type !== 'topic' && type !== 'concept') return null;
  const local = getLocalTopicEntity(topic.id, language);
  const title = local?.display_name || topic.display_name || topic.label || '';
  if (!title) return null;
  return {
    title,
    alternateTitle: local ? (language === 'en' ? local.labelEs : local.labelEn) || '' : '',
    language,
    strictTitleMatch: Boolean(topic._queryTopic),
  };
}

export function prefetchTopicWiki(topic, language = 'es') {
  const request = topicWikiRequest(topic, language);
  if (!request) return Promise.resolve(null);
  const key = `${request.language}:${request.strictTitleMatch ? 'strict' : 'fuzzy'}:${request.title}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const job = getEntityWikiInfo(request)
    .catch(() => null)
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, job);
  return job;
}
