import { createContext } from 'react';
import type { CustomFeed, CustomFeedInput } from '../utils/custom-feeds.ts';

export interface CustomFeedsValue {
  /** The account's feeds as the server last confirmed them. */
  feeds: CustomFeed[];
  /** `ready` only once the feeds are an answer: from the server, or a document the cache holds. */
  status: 'loading' | 'ready' | 'unavailable';
  /**
   * Creates a feed and resolves with it. With `id`, a feed that already has
   * that id, left by an earlier attempt that outran its deadline but landed,
   * is the result instead of a second feed.
   */
  createFeed(input: CustomFeedInput, id?: string): Promise<CustomFeed>;
  updateFeed(id: string, input: CustomFeedInput): Promise<void>;
  deleteFeed(id: string): Promise<void>;
  moveFeed(id: string, delta: -1 | 1): Promise<void>;
  openFeedEditor(target?: { feedId?: string; preset?: Partial<CustomFeedInput> }): void;
  /**
   * Asks before deleting the feed. `focusAfterDelete` names where focus goes
   * once it is deleted, when the control that asked leaves with the feed;
   * without it, or when it finds nothing, focus goes back as after Cancel.
   */
  confirmDeleteFeed(id: string, options?: { focusAfterDelete?: () => HTMLElement | null }): void;
  /** The reader's latest press on the tab they are on, by the tab's key (`FeedTabEntry.key`). */
  refreshRequest: { tab: string; n: number } | null;
  requestRefresh(tab: string): void;
  /** Listens again after an error or a wait that ran out; `loading` until the next answer or the grace. */
  retry(): void;
}

// Apart from the provider so Fast Refresh never re-creates it (see contexts.ts).
export const CustomFeedsContext = createContext<CustomFeedsValue | null>(null);
