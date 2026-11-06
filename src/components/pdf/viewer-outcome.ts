import type { FullTextSource } from '../../models/full-text.ts';
import type { ProductAnalyticsEvent } from '../../services/analytics-service.ts';

export type ViewerContent = 'text' | 'pdf_embed' | 'pdf_pages' | 'external_link' | 'none';
type PdfIssue = 'not_embeddable' | 'timeout' | 'relay_failed' | 'not_relayable' | 'no_open_copy';

export type ViewerOutcome = {
  content: ViewerContent;
  text_status: 'shown' | 'none' | 'failed';
  pdf_issue?: PdfIssue;
  text_source?: FullTextSource;
};

/** What the viewer has learnt so far, read from its own state on each render. */
type ViewerState = {
  /** The text's source once it is shown, null when there is none, undefined while it is asked for. */
  textSource: FullTextSource | null | undefined;
  textFailed: boolean;
  coarsePointer: boolean;
  /** A PDF exists (`fullTextUrl`), and the iframe may frame one (`pdfUrl`). */
  hasPdf: boolean;
  embeddable: boolean;
  relayable: boolean;
  iframeLoaded: boolean;
  embedTimedOut: boolean;
  /** The first page of the relayed PDF has been drawn, not just measured. */
  pagesDrawn: boolean;
  relayFailed: boolean;
  /** Something opens in a new tab: the PDF, the DOI or the OpenAlex page. */
  hasLink: boolean;
};

/**
 * What the reader was first shown, or null while that is not known yet. The
 * viewer opens on the text, so a text that arrives is the outcome; without one,
 * the PDF route decides it, and an issue says why the PDF was not drawn here.
 */
export function viewerOutcome(state: ViewerState): ViewerOutcome | null {
  if (state.textSource === undefined) return null;
  if (state.textSource) return { content: 'text', text_status: 'shown', text_source: state.textSource };
  const text_status = state.textFailed ? 'failed' : 'none';
  const instead = (pdf_issue: PdfIssue): ViewerOutcome => ({ content: state.hasLink ? 'external_link' : 'none', text_status, pdf_issue });
  if (!state.hasPdf) return instead('no_open_copy');
  if (state.coarsePointer) {
    if (!state.relayable) return instead('not_relayable');
    if (state.relayFailed) return instead('relay_failed');
    return state.pagesDrawn ? { content: 'pdf_pages', text_status } : null;
  }
  if (!state.embeddable) return instead('not_embeddable');
  if (state.iframeLoaded) return { content: 'pdf_embed', text_status };
  return state.embedTimedOut ? instead('timeout') : null;
}

type Visibility = { hidden: () => boolean; subscribe: (listener: () => void) => () => void };

export const documentVisibility: Visibility = {
  hidden: () => document.hidden,
  subscribe: listener => {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};

type ViewerEvent = Extract<ProductAnalyticsEvent, 'viewer_open' | 'viewer_content' | 'viewer_time'>;

/**
 * One viewer's analytics, from opening to closing: `viewer_open` now,
 * `viewer_content` for the first outcome only, and `viewer_time` on `stop`.
 * The time counts only while the tab is visible, as `reader_time` does, and
 * `text_seconds` is the part of it spent on the text rather than the PDF.
 */
export function startViewerTracking({ now, visibility, send }: {
  now: () => number;
  visibility: Visibility;
  send: (name: ViewerEvent, params: Record<string, unknown>) => void;
}) {
  const openedAt = now();
  let visibleSince: number | null = visibility.hidden() ? null : openedAt;
  let onText = false;
  let seconds = 0;
  let textSeconds = 0;
  let outcome: ViewerOutcome | null = null;
  let stopped = false;

  const flush = () => {
    const at = now();
    if (visibleSince !== null) {
      const elapsed = (at - visibleSince) / 1000;
      seconds += elapsed;
      if (onText) textSeconds += elapsed;
    }
    visibleSince = visibility.hidden() ? null : at;
  };
  const unsubscribe = visibility.subscribe(flush);
  send('viewer_open', {});

  return {
    settle(next: ViewerOutcome) {
      if (outcome || stopped) return;
      outcome = next;
      send('viewer_content', { ...next, duration_ms: now() - openedAt });
    },
    showText(shown: boolean) {
      if (shown === onText || stopped) return;
      flush();
      onText = shown;
    },
    stop() {
      if (stopped) return;
      flush();
      stopped = true;
      unsubscribe();
      send('viewer_time', { content: outcome?.content ?? 'loading', seconds, text_seconds: textSeconds });
    },
  };
}
