import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * vercel.json sends crawlers of public pages to the Worker's share pages
 * (worker/share-pages.js), and leaves people on the static app.
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

async function shareRewrite() {
  const config = JSON.parse(await readFile(VERCEL, 'utf8'));
  const index = config.rewrites.findIndex(rule => String(rule.destination).startsWith('https://api.papertok.app/share/'));
  return { config, index, rule: config.rewrites[index] };
}

test('public pages reach the Worker share route, one path for all four kinds', async () => {
  const { rule } = await shareRewrite();
  assert.ok(rule, 'the crawler rewrite is gone');
  assert.equal(rule.source, '/public/:kind(paper|list|user|entity)/:rest*');
  assert.equal(rule.destination, 'https://api.papertok.app/share/:kind/:rest*');
});

test('the crawler rewrite comes before the SPA catch-all, which would otherwise take it', async () => {
  const { config, index } = await shareRewrite();
  assert.ok(index >= 0, 'the crawler rewrite is gone');
  const spa = config.rewrites.findIndex(rule => rule.source.startsWith('/:path('));
  assert.ok(spa >= 0, 'the SPA rewrite is gone');
  assert.ok(index < spa, 'Vercel takes the first rewrite that matches');
});

test('only a crawler user agent is rewritten; a person gets the static app', async () => {
  const { config, rule } = await shareRewrite();
  const conditions = rule.has || [];
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0].type, 'header');
  assert.equal(conditions[0].key, 'user-agent');
  assert.equal(
    config.rewrites.filter(candidate => String(candidate.destination).includes('api.papertok.app')).length,
    1,
    'no second, unconditional way to the Worker',
  );
});

test('the user-agent pattern matches the crawlers and not the browsers, anchored or not', async () => {
  const { rule } = await shareRewrite();
  const value = rule.has[0].value;
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
