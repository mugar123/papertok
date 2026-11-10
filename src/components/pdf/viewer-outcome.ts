import type { FullTextSource } from '../../models/full-text.ts';
import type { ProductAnalyticsEvent } from '../../services/analytics-service.ts';

export type ViewerContent = 'text' | 'pdf_embed' | 'pdf_pages' | 'external_link' | 'none';
type PdfIssue = 'not_embeddable' | 'timeout' | 'relay_failed' | 'render_failed' | 'not_relayable' | 'no_open_copy';

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
  /** The relay could not deliver a readable PDF. */
  relayFailed: boolean;
  /** The relay delivered the PDF, but no page of it could be drawn here. */
  drawFailed: boolean;
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
    if (state.drawFailed) return instead('render_failed');
    return state.pagesDrawn ? { content: 'pdf_pages', text_status } : null;
  }
  if (!state.embeddable) return instead('not_embeddable');
  if (state.iframeLoaded) return { content: 'pdf_embed', text_status };
  return state.embedTimedOut ? instead('timeout') : null;
}

export type Visibility = { hidden: () => boolean; subscribe: (listener: () => void) => () => void };

export const documentVisibility: Visibility = {
  hidden: () => document.hidden,
  subscribe: listener => {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};

/**
 * Fixes the analytics consent and account a session opened under. The returned
 * check is true until `context` first differs from that opening value, and
 * false from then on, even if the context later returns to it (a sign-out and
 * back in, say). The reader's `reader_time` keeps to the same rule.
 */
export function pinAnalyticsContext(context: () => string) {
  const openedWith = context();
  let dropped = false;
  return () => {
    if (context() !== openedWith) dropped = true;
    return !dropped;
  };
}

type ViewerEvent = Extract<ProductAnalyticsEvent, 'viewer_open' | 'viewer_content' | 'viewer_time'>;

/**
 * One viewer's analytics, from opening to closing: `viewer_open` now,
 * `viewer_content` for the first outcome only, and `viewer_time` on `stop`.
 * The time counts only while the tab is visible, as `reader_time` does, and
 * `text_seconds` is the part of it spent on the text rather than the PDF.
 *
 * `context` names the analytics consent and the account the session belongs
 * to. Once it differs from the one at opening, the session is dropped and
 * sends nothing more: time counted before a consent change or under another
 * account must not be reported now. `check` lets the viewer drop it as soon as
 * either changes; every send checks again.
 */
export function startViewerTracking({ now, visibility, context, send }: {
  now: () => number;
  visibility: Visibility;
  context: () => string;
  send: (name: ViewerEvent, params: Record<string, unknown>, stillValid: () => boolean) => void;
}) {
  const check = pinAnalyticsContext(context);
  const sendEvent = (name: ViewerEvent, params: Record<string, unknown>) => send(name, params, check);
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
  sendEvent('viewer_open', {});

  return {
    check,
    settle(next: ViewerOutcome) {
      if (outcome || stopped || !check()) return;
      outcome = next;
      sendEvent('viewer_content', { ...next, duration_ms: now() - openedAt });
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
      if (check()) sendEvent('viewer_time', { content: outcome?.content ?? 'loading', seconds, text_seconds: textSeconds });
    },
  };
}
