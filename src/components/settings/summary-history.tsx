import type { SummaryHistoryCursor, SummaryHistoryPage, SummaryHistoryRow } from '../../services/saved-summary-service.ts';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, CircleNotch } from '@phosphor-icons/react';
import { useLanguage } from '../../context/language-context.tsx';
import { useOverlayHistory } from '../../hooks/use-overlay-history.ts';
import { PAPER_REWRITE_LEVELS } from '../../services/paper-rewrite-service.ts';
import { listSummaryHistory, summaryHistoryPaper } from '../../services/saved-summary-service.ts';
import { isReadTimeout } from '../../utils/bounded-read.ts';
import { ListRow } from '../lists/list-row.tsx';
import ScientificText from '../scientific-text.ts';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import Petri from '../onboarding/petri.tsx';

const PaperReader = lazy(() => import('../reader/paper-reader.tsx'));

const COPY = {
  title: 'Plain-words summaries',
  description: 'Papers you have read in plain words',
  loading: 'Loading your summaries…',
  emptyTitle: 'No summaries yet',
  empty: 'A paper you read in plain words is listed here.',
  stalled: 'Your summaries are taking unusually long. Still trying.',
  stalledMore: 'More summaries are taking unusually long. Still trying.',
  failed: 'Your summaries could not be loaded.',
  failedMore: 'More summaries could not be loaded.',
  retry: 'Try again',
  showMore: 'Show more',
  loaded: (count: number) => `${count} more ${count === 1 ? 'summary' : 'summaries'} listed.`,
  rowDetail: (level: string, date: string) => ` (${level} level${date ? `, ${date}` : ''})`,
};

const levelLabel = (level: string) => PAPER_REWRITE_LEVELS.find(option => option.id === level)?.label ?? level;

/**
 * The reader's own summaries, a page at a time: title, level and date only.
 * The text is read when a row opens, by the reader itself, which finds the
 * saved copy before it would ask the worker. Mounted with `key={uid}`, so
 * another account starts from an empty list and a page still in flight for
 * the previous one is aborted with it.
 */
export default function SummaryHistory({ uid }: { uid: string }) {
  const { locale } = useLanguage();
  const [rows, setRows] = useState<SummaryHistoryRow[]>([]);
  const [cursor, setCursor] = useState<SummaryHistoryCursor>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<'loading' | 'stalled' | 'ready' | 'error'>('loading');
  const [moreStatus, setMoreStatus] = useState<'idle' | 'loading' | 'stalled' | 'error'>('idle');
  const [attempt, setAttempt] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [openRow, setOpenRow] = useState<SummaryHistoryRow | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const focusRowRef = useRef<number | null>(null);
  const moreRef = useRef<AbortController | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);

  // A first page that outlasts its read budget says so and keeps trying; the
  // answer still fills the list when it arrives (as on the Lists page).
  useEffect(() => {
    const controller = new AbortController();
    const show = (page: SummaryHistoryPage) => {
      if (controller.signal.aborted) return;
      // A late page takes the stalled note's Try again away; focus on it stays
      // in the section, on the heading.
      if (retryRef.current && document.activeElement === retryRef.current) headingRef.current?.focus();
      setRows(page.rows);
      setCursor(page.cursor);
      setHasMore(page.hasMore);
      setStatus('ready');
    };
    listSummaryHistory(uid, { signal: controller.signal, onLateResult: show }).then(show, (error) => {
      if (controller.signal.aborted) return;
      console.warn('Could not list the saved summaries', error);
      setStatus(isReadTimeout(error) ? 'stalled' : 'error');
    });
    return () => controller.abort();
  }, [uid, attempt]);

  useEffect(() => () => moreRef.current?.abort(), []);

  // A stalled read can also end in a refusal that patientRead no longer
  // reports, so the stalled state keeps a way to ask again.
  const retryFirstPage = () => {
    // The button leaves with the note; the heading keeps focus in the section.
    headingRef.current?.focus();
    setStatus('loading');
    setAttempt(value => value + 1);
  };

  const loadMore = async () => {
    if (moreStatus === 'loading') return;
    // A retry replaces a page that is still being asked for.
    moreRef.current?.abort();
    const controller = new AbortController();
    moreRef.current = controller;
    setMoreStatus('loading');
    // Cleared so the same sentence is read out again for this page.
    setAnnouncement('');
    const firstNew = rows.length;
    const append = (page: SummaryHistoryPage) => {
      if (controller.signal.aborted) return;
      // A page that arrives late must not pull focus away from wherever the
      // reader went meanwhile; it only moves on from "Show more" itself.
      const active = document.activeElement;
      const focusStayed = !active || active === document.body || active === moreButtonRef.current;
      // A summary written again while the list was open moves to the top,
      // and must not be listed twice.
      setRows(current => [...current, ...page.rows.filter(row => !current.some(listed => listed.id === row.id))]);
      setCursor(page.cursor);
      setHasMore(page.hasMore);
      setMoreStatus('idle');
      setAnnouncement(COPY.loaded(page.rows.length));
      if (focusStayed) focusRowRef.current = firstNew;
    };
    try {
      append(await listSummaryHistory(uid, { cursor, signal: controller.signal, onLateResult: append }));
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn('Could not list more saved summaries', error);
      // Past its budget the read is still running and its page can still
      // arrive, as for the first page; only a refusal is an error.
      if (isReadTimeout(error)) {
        setMoreStatus('stalled');
        setAnnouncement(COPY.stalledMore);
      } else {
        setMoreStatus('error');
      }
    }
  };

  // "Show more" leaves the page with the last page, so focus moves on to the
  // first row it added (or the last row, if every new one was a duplicate).
  useEffect(() => {
    if (focusRowRef.current === null) return;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('.list-row-title-btn');
    const target = buttons?.[Math.min(focusRowRef.current, buttons.length - 1)];
    focusRowRef.current = null;
    target?.focus();
  }, [rows]);

  // Back closes the reader rather than leaving Settings (use-overlay-history.ts).
  const readerCloseRef = useRef<(() => void) | null>(null);
  const requestReaderClose = useCallback(() => {
    if (readerCloseRef.current) readerCloseRef.current();
    else setOpenRow(null);
  }, []);
  useOverlayHistory(Boolean(openRow), requestReaderClose, 'reader');
  const readerPaper = useMemo(() => (openRow ? summaryHistoryPaper(openRow) : null), [openRow]);

  const formatDate = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
    return (date: Date | null) => (date ? format.format(date) : '');
  }, [locale]);

  return (
    <section className="settings-section" aria-labelledby="settings-summaries-heading">
      <div className="settings-section-heading">
        <h2 ref={headingRef} id="settings-summaries-heading" tabIndex={-1}>{COPY.title}</h2>
        <p>{COPY.description}</p>
      </div>

      {/* One status element from loading to stalled, so the change of text is
          read out, and a new alert for a refusal. A stalled read is not an
          alert, as on the Lists page. */}
      {status !== 'ready' && (
        <div className="settings-summaries-note">
          {status === 'error'
            ? <p key="failed" role="alert">{COPY.failed}</p>
            : <p key="status" role="status">{status === 'stalled' ? COPY.stalled : COPY.loading}</p>}
          {status !== 'loading' && (
            <Button ref={retryRef} variant="outline" size="sm" onClick={retryFirstPage}>
              <ArrowClockwise size={15} aria-hidden="true" />
              {COPY.retry}
            </Button>
          )}
        </div>
      )}
      {status === 'ready' && rows.length === 0 && (
        <EmptyState as="h3" art={<Petri pose="reading" />} title={COPY.emptyTitle}>{COPY.empty}</EmptyState>
      )}

      {rows.length > 0 && (
        <div ref={listRef} className="settings-list settings-summaries" role="list" aria-labelledby="settings-summaries-heading">
          {rows.map((row) => {
            const level = levelLabel(row.level);
            const date = formatDate(row.updatedAt);
            return (
              <ListRow
                key={row.id}
                role="listitem"
                meta={[level, date]}
                titleLang="en"
                title={(
                  <>
                    <ScientificText>{row.title}</ScientificText>
                    {/* Two levels of one paper share a title; the name says which is which. */}
                    <span className="visually-hidden">{COPY.rowDetail(level, date)}</span>
                  </>
                )}
                onOpen={() => setOpenRow(row)}
              />
            );
          })}
        </div>
      )}

      {moreStatus === 'error' && <p className="settings-summaries-note" role="alert">{COPY.failedMore}</p>}
      {/* Read out by the status line below, which is already on the page. */}
      {moreStatus === 'stalled' && <p className="settings-summaries-note">{COPY.stalledMore}</p>}
      {hasMore && (
        <Button
          ref={moreButtonRef}
          variant="outline"
          size="sm"
          className="settings-summaries-more"
          onClick={() => { void loadMore(); }}
          aria-busy={moreStatus === 'loading'}
        >
          {moreStatus === 'loading'
            ? <CircleNotch size={15} className="settings-spin" aria-hidden="true" />
            : (moreStatus === 'error' || moreStatus === 'stalled') && <ArrowClockwise size={15} aria-hidden="true" />}
          {moreStatus === 'error' || moreStatus === 'stalled' ? COPY.retry : COPY.showMore}
        </Button>
      )}
      <p className="visually-hidden" role="status">{announcement}</p>

      {openRow && readerPaper && (
        // As in PaperCard: nothing to hold a place for while the chunk loads.
        <Suspense fallback={null}>
          <PaperReader
            paper={readerPaper}
            initialLevel={openRow.level}
            closeRef={readerCloseRef}
            onClose={() => setOpenRow(null)}
          />
        </Suspense>
      )}
    </section>
  );
}
