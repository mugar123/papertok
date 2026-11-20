import './dom-environment.ts';
import { createElement, useEffect, type Context, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, render } from '@testing-library/react';
import type { writeFeedSnapshot as WriteFeedSnapshot } from '../../context/feed-snapshot.ts';
import type { Paper } from '../../models/paper.ts';
import { startAppModules } from './app-modules.ts';
import { stubWorker } from './worker-stub.ts';

export { waitFor } from '@testing-library/react';

/**
 * The feed's provider tree for a signed-in reader, with the three things a
 * test controls: the Worker (`worker-stub.ts`), the analytics events the app
 * sends and the reader's session. Everything else is the app's own code,
 * loaded through `app-modules.ts`.
 *
 * Components are typed by what this helper uses of them, not imported as
 * types: the test project is checked with Node's timer types, which the
 * browser code in `.tsx` files does not accept.
 */
const USER = { uid: 'reader-1', getIdToken: () => Promise.resolve('test-token') };
const INTERESTS = ['cs.AI'];

type Component<Props = object> = (props: Props & { children?: ReactNode }) => ReactNode;

/** What a test reads of the feed provider, and does through it. */
interface FeedView {
  error: string | null;
  papers: Array<{ id: string }>;
  refreshFeed: () => Promise<void>;
  markNotInterested: (paper: Paper) => Promise<void>;
}

/**
 * `cards` are the last visit's saved feed, which the provider restores on mount
 * as the cards on screen. `container` also mounts the feed screen.
 */
export async function renderFeed({ container = false, cards = [] }: { container?: boolean; cards?: Paper[] } = {}) {
  const app = await startAppModules();
  const worker = stubWorker();
  // The corpus is the one Worker route a feed load needs; a test answers it.
  const corpus = worker.hold('/store/papers');
  // A failed load logs what it failed on, which these tests cause on purpose.
  const consoleOutput = { error: console.error, warn: console.warn, info: console.info };
  Object.assign(console, { error() {}, warn() {}, info() {} });
  const stop = async () => {
    cleanup();
    worker.stop();
    Object.assign(console, consoleOutput);
    await app.close();
  };
  // A setup that throws still releases the Vite server, `fetch` and `console`.
  try {
    const firebase = await app.firebase();
    firebase.auth.currentUser = USER;
    const contexts = await app.load<Record<'AuthContext' | 'FollowingContext' | 'AnalyticsContext', Context<unknown>>>('/src/context/contexts.ts');
    const { CustomFeedsContext } = await app.load<{ CustomFeedsContext: Context<unknown> }>('/src/context/custom-feeds-context.ts');
    const { LanguageProvider } = await app.load<{ LanguageProvider: Component }>('/src/context/language-context.tsx');
    const { FeedProvider, useFeed } = await app.load<{ FeedProvider: Component<{ feedRouteActive: boolean }>; useFeed: () => FeedView }>('/src/context/feed-context.tsx');
    const { default: FeedContainer } = await app.load<{ default: Component<{ onOpenPdf: () => void; onSaveToList: () => void }> }>('/src/components/feed/feed-container.tsx');
    const { writeFeedSnapshot } = await app.load<{ writeFeedSnapshot: typeof WriteFeedSnapshot }>('/src/context/feed-snapshot.ts');
    if (cards.length) writeFeedSnapshot(USER.uid, INTERESTS.join('|'), { papers: cards, page: 1, hasMore: true });

    const events: Array<{ name: string; params: Record<string, unknown> | undefined }> = [];
    const analytics = {
      consent: 'enabled',
      trackEvent: (name: string, params?: Record<string, unknown>) => { events.push({ name, params }); return Promise.resolve(true); },
      updateConsent: () => Promise.resolve(true),
      markActivation: () => Promise.resolve(false),
    };
    const auth = {
      user: { uid: USER.uid }, loading: false, error: null, onboardingComplete: true, userPreferences: INTERESTS,
      deselectedPreferences: [], addedPreferences: [], followedAuthors: [],
    };
    const following = { followedEntities: [], followedByType: {}, loading: false, error: null, confirmed: true };
    const customFeeds = { feeds: [], status: 'ready', refreshRequest: null, requestRefresh: () => {} };

    let feed: FeedView | null = null;
    function Probe() {
      const value = useFeed();
      useEffect(() => { feed = value; });
      return null;
    }

    const tree = (feedRouteActive: boolean) => createElement(MemoryRouter, null,
      createElement(contexts.AuthContext.Provider, { value: auth },
        createElement(contexts.FollowingContext.Provider, { value: following },
          createElement(contexts.AnalyticsContext.Provider, { value: analytics },
            createElement(LanguageProvider, null,
              createElement(CustomFeedsContext.Provider, { value: customFeeds },
                createElement(FeedProvider, { feedRouteActive },
                  createElement(Probe),
                  container ? createElement(FeedContainer, { onOpenPdf: () => {}, onSaveToList: () => {} }) : null,
                )))))));
    const view = render(tree(true));

    return {
      /** The Worker's corpus route, which holds each feed load until the test refuses it. */
      corpus,
      /** The `app_error` events the app has sent. */
      appErrors: () => events.filter(event => event.name === 'app_error').map(event => event.params),
      /** The feed's state and actions, as a card or screen reads them. */
      feed: () => {
        if (!feed) throw new Error('The feed provider has not rendered.');
        return feed;
      },
      /** The reader moves to or from /feed, where the feed screen shows. */
      showFeed: (visible: boolean) => view.rerender(tree(visible)),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
