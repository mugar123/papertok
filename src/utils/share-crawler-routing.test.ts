import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * vercel.json sends crawlers of public pages to the Worker's share pages
 * (worker/share-pages.ts), and leaves people on the static app.
 *
 * Measured 2026-09-23 (audit, issue 5): WhatsApp, Twitterbot,
 * facebookexternalhit and Googlebot all received the one static index.html
 * for a shared paper. The rest are the other preview bots and search engines
 * a shared link meets. A browser that matched by mistake would still get the
 * app — the Worker answers the same shell — so the list errs towards bots.
 */

const VERCEL = new URL('../../vercel.json', import.meta.url);

const CRAWLERS = [
  'WhatsApp/2.23.20.0 A',
  'WhatsApp/2.2335.8 i',
  'Twitterbot/1.0',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  // iMessage fetches previews under this one.
  'facebookexternalhit/1.1 Facebot Twitterbot/1.0',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.126 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
  'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
  'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  'TelegramBot (like TwitterBot)',
  'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
  'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
  'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
  'Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)',
  'http.rb/5.1.1 (Mastodon/4.2.10; +https://mastodon.social/)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com',
  'redditbot/1.0',
  'Pinterestbot/1.0 (+http://www.pinterest.com/bot.html)',
];

const BROWSERS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  // In-app browsers are people, whatever app they sit in.
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.97;FBDV/iPhone14,5;FBSN/iOS;FBSV/17.5;FBLC/es_ES]',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 340.0.0.22.109 (iPhone14,5; iOS 17_5; es_ES; es; scale=3.00)',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.29.8',
  // The headless Chrome our own measurements drive.
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/129.0.0.0 Safari/537.36',
];

type Condition = { type: string; key?: string; value: string };
type Rule = { source: string; destination: string; has?: Condition[]; permanent?: boolean };

async function vercelConfig(): Promise<{ redirects: Rule[]; rewrites: Rule[] }> {
  return JSON.parse(await readFile(VERCEL, 'utf8'));
}

async function shareRewrites() {
  const config = await vercelConfig();
  const rules = config.rewrites.filter(rule => rule.destination.startsWith('https://api.papertok.app/share/'));
  return { config, rules };
}

// Enough of path-to-regexp, which Vercel compiles `source` with, for the
// redirects and the Worker rewrites: `:name` is one segment, `:name*` any
// number of them, `:name(pattern)` a pattern of its own.
function applyRule(rule: Rule, path: string, userAgent: string) {
  const conditionsHold = (rule.has || []).every(condition => (
    condition.type === 'header' && condition.key === 'user-agent' && new RegExp(`^${condition.value}$`).test(userAgent)
  ));
  if (!conditionsHold) return null;
  const names: string[] = [];
  const pattern = rule.source.replace(/\/:(\w+)(\*|\(([^()]*)\))?/g, (_match, name: string, modifier?: string, custom?: string) => {
    names.push(name);
    return modifier === '*' ? '(?:/(.*))?' : `/(${custom ?? '[^/]+'})`;
  });
  const match = path.match(new RegExp(`^${pattern}$`));
  if (!match) return null;
  return names.reduce((destination, name, index) => destination.replace(new RegExp(`:${name}\\*?`), match[index + 1] ?? ''), rule.destination);
}

// Vercel's order: the first redirect that matches answers on its own, and
// only a request no redirect took goes on to the first matching rewrite.
async function route(path: string, userAgent: string) {
  const { config, rules } = await shareRewrites();
  for (const rule of config.redirects) {
    const location = applyRule(rule, path, userAgent);
    if (location) return { redirect: location, permanent: rule.permanent === true };
  }
  for (const rule of rules) {
    const destination = applyRule(rule, path, userAgent);
    if (destination) return { rewrite: destination };
  }
  return {};
}

const KEY = 'ZG9pOjEwLjExNDUvMzU1NTE3NA';
const CRAWLER = CRAWLERS[0];
const BROWSER = BROWSERS[0];

test('public pages reach the Worker share route: a paper at /paper/, the other kinds under /public/', async () => {
  assert.deepEqual(await route(`/paper/${KEY}`, CRAWLER), { rewrite: `https://api.papertok.app/share/paper/${KEY}` });
  assert.deepEqual(await route('/public/list/x7Kq2mPz', CRAWLER), { rewrite: 'https://api.papertok.app/share/list/x7Kq2mPz' });
  assert.deepEqual(
    await route('/public/entity/author/A5018713931', CRAWLER),
    { rewrite: 'https://api.papertok.app/share/entity/author/A5018713931' },
  );
});

/**
 * ENG-44: paper links were minted as /public/paper/<key> until the page moved
 * to /paper/<key>, and the old ones are in messages, bookmarks and indexes.
 * The redirect runs before any rewrite, so a crawler is moved too and then
 * reaches the Worker at the new address. The query string is not modelled
 * here: Vercel passes the request's query on to a redirect's destination by
 * default (Vercel KB, "How do I perform Vercel redirects based on query
 * strings?"), so `?utm_source=…` survives the move.
 */
test('an old /public/paper/ link is moved permanently to /paper/, for people and crawlers alike', async () => {
  for (const userAgent of [BROWSER, CRAWLER]) {
    assert.deepEqual(await route(`/public/paper/${KEY}`, userAgent), { redirect: `/paper/${KEY}`, permanent: true });
  }
  assert.deepEqual(await route(`/paper/${KEY}`, BROWSER), {}, 'a person on the new address gets the static app');
  assert.deepEqual(await route('/public/list/x7Kq2mPz', BROWSER), {}, 'lists keep their address');
});

test('the crawler rewrites come before the SPA catch-all, which would otherwise take them', async () => {
  const { config, rules } = await shareRewrites();
  assert.ok(rules.length > 0, 'the crawler rewrites are gone');
  const spa = config.rewrites.findIndex(rule => rule.source.startsWith('/:path('));
  assert.ok(spa >= 0, 'the SPA rewrite is gone');
  for (const rule of rules) {
    assert.ok(config.rewrites.indexOf(rule) < spa, `${rule.source}: Vercel takes the first rewrite that matches`);
  }
});

test('only a crawler user agent is rewritten; a person gets the static app', async () => {
  const { config, rules } = await shareRewrites();
  const workerRules = config.rewrites.filter(candidate => candidate.destination.includes('api.papertok.app'));
  assert.deepEqual(workerRules, rules, 'no other way to the Worker');
  for (const rule of rules) {
    const conditions = rule.has || [];
    assert.equal(conditions.length, 1, `${rule.source} is not conditional on the user agent alone`);
    assert.equal(conditions[0].type, 'header');
    assert.equal(conditions[0].key, 'user-agent');
    assert.equal(conditions[0].value, rules[0].has![0].value, `${rule.source} lists different crawlers`);
  }
});

test('the user-agent pattern matches the crawlers and not the browsers, anchored or not', async () => {
  const { rules } = await shareRewrites();
  const value = rules[0].has![0].value;
  // Written for JavaScript's RegExp, the engine Vercel's routing compiles
  // `has` values with: no inline flags, so case is spelled out per token.
  assert.doesNotMatch(value, /\(\?[a-z]/i, 'no inline flag group');
  const loose = new RegExp(value);
  const anchored = new RegExp(`^${value}$`);
  for (const agent of CRAWLERS) {
    assert.ok(loose.test(agent) && anchored.test(agent), `crawler not matched: ${agent}`);
  }
  for (const agent of BROWSERS) {
    assert.ok(!loose.test(agent) && !anchored.test(agent), `browser matched: ${agent}`);
  }
});
