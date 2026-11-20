import { createContext } from 'react';

/**
 * The ref FeedContainer puts on its retry buttons (useWaitFocus), given to a
 * source's own empty state. A retry button there that takes it hands its
 * focus on as Try again does: to the retry button that comes back, or to the
 * first card when the papers do. Null outside a source's empty state.
 */
export const FeedRetryRefContext = createContext<((node: HTMLElement | null) => void) | null>(null);
