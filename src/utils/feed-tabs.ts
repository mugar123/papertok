/** The navbar's feed tabs, in the order the bar shows them. */
export const FEED_TABS = [
  { key: 'home', path: '/feed', label: 'For you', scrollKey: 'forYou' },
  { key: 'following', path: '/following', label: 'Following', scrollKey: 'following' },
] as const;

export type FeedTab = (typeof FEED_TABS)[number];
export type FeedTabKey = FeedTab['key'];
