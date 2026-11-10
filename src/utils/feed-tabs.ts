/** The navbar's feed tabs, in the order the bar shows them. */
export const FEED_TABS = [
  { key: 'home', path: '/feed', label: 'For you', scrollKey: 'forYou' },
  { key: 'following', path: '/following', label: 'Following', scrollKey: 'following' },
] as const;

export type FeedTab = (typeof FEED_TABS)[number];
export type FeedTabKey = FeedTab['key'];

/** A tab in the bar: a fixed one, or one of the reader's custom feeds. */
export interface FeedTabEntry { key: string; path: string; label: string }

const CUSTOM_FEED_PATH = /^\/feeds\/([^/]+)\/?$/;

export function customFeedPath(id: string): string {
  return `/feeds/${id}`;
}

/** The custom feed a path addresses, or null when it addresses none. */
export function customFeedIdFromPath(pathname: string): string | null {
  return CUSTOM_FEED_PATH.exec(pathname)?.[1] ?? null;
}

/** The fixed tabs, then one per custom feed in the reader's order. */
export function allFeedTabs(feeds: ReadonlyArray<{ id: string; name: string }>): FeedTabEntry[] {
  return [
    ...FEED_TABS.map(({ key, path, label }) => ({ key, path, label })),
    ...feeds.map(feed => ({ key: `feed:${feed.id}`, path: customFeedPath(feed.id), label: feed.name })),
  ];
}
