import type { KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, Ref } from 'react';
import type { Paper } from '../../models/paper.ts';
import type { ReaderMenu } from '../feed/paper-menu.tsx';
import type { RewriteSection, ClientRewriteMeta } from '../../services/paper-rewrite-service.ts';
import type { PassageAnnotation } from '../../hooks/use-passage-annotations.ts';
import type { ReadingLevel } from '../../utils/user-settings.ts';
interface PaperReaderProps {
  card?: { paper: Paper; menu: ReaderMenu };
  paper: Partial<Paper>; onClose: () => void;
  closeRef?: Ref<() => void> | null;
  /** The level to open at instead of the reader's default (the summary history opens the one it lists). */
  initialLevel?: ReadingLevel;
  /** Opens the paper itself, when the reader is one of two tabs with the paper viewer. */
  onPaperTab?: () => void;
  /** Drawn inside the paper viewer as its AI summary tab, rather than as a dialog of its own. */
  embedded?: boolean;
  /** Inside the viewer, how a menu action leaves: the viewer closes, then the action runs. */
  onLeave?: (then: () => void) => void;
}
export type ReaderCopy = typeof COPY.en;
import { useCallback, useEffect, useEffectEvent, useId, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowClockwise,
  ArrowSquareOut,
  Flask,
  GraduationCap,
  Highlighter,
  Plant,
  Sparkle,
  X,
} from '@phosphor-icons/react';
import {
  canRewritePaper,
  refreshAIUses,
  getCachedRewrite,
  lastKnownAIUses,
  PAPER_REWRITE_LEVELS,
  PaperRewriteError,
  rewriteCacheKey,
  noteAIUsesLeft,
  subscribeAIUses,
  rewritePaper,
} from '../../services/paper-rewrite-service.ts';
import type { HighlightColor } from '../../services/user-highlight-service.ts';
import { FULL_TEXT_LEVEL, indexHighlightsByParagraph, passageQuote, passageSegments } from '../../services/user-highlight-service.ts';
import ScientificText from '../scientific-text.ts';
import { usePassageAnnotations } from '../../hooks/use-passage-annotations.ts';
import {
  answerSlot,
  buildSectionOrder,
  sortAnnotations,
} from '../../utils/annotation-order.ts';
import { normalizeLatexText, proseSourceOffset } from '../../utils/latex.ts';
import { HIGHLIGHT_MIN_QUOTE_LENGTH, buildRangeAnchor, buildSelectionAnchor } from '../../utils/text-highlights.ts';
import { useAuth } from '../../context/auth-context.tsx';
import { useAnalyticsConsent } from '../../context/privacy-context.tsx';
import { analyticsSessionContext } from '../../services/analytics-session.ts';
import { documentVisibility } from '../pdf/viewer-outcome.ts';
import { startReaderTime } from './reader-time.ts';
import { safeDoiUrl, safeExternalUrl } from '../../utils/external-url.ts';
import { journalExplorerLink } from '../../utils/explorer-paths.ts';
import { Link } from 'react-router-dom';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import Petri from '../onboarding/petri.tsx';
import { Dialog, DialogContent } from '../ui/dialog.tsx';
import { Toggle } from '../ui/toggle.ts';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.tsx';
import { NotesSidebar, PassageEditor } from '../pdf/viewer-notes.tsx';
import { ReadingDock } from '../pdf/reading-dock.tsx';
import { OutlineList, OutlineRail } from '../pdf/full-text-outline.tsx';
import { PassageHandles } from '../pdf/passage-handles.tsx';
import { overlapping, quoteOffsets, replacingHighlights } from '../pdf/passage-range.ts';
import { useOutlineActive } from '../pdf/use-outline.ts';
import { PaperAuthors } from '../pdf/paper-byline.tsx';
import { ReadingTabs } from '../pdf/reading-tabs.tsx';
import { acceptedConferenceText } from '../../utils/paper-status.ts';
import HighlightedScientificText from './highlighted-scientific-text.tsx';
import UsesCount from './uses-count.tsx';
import ThinkingDots from './thinking-dots.tsx';
import '../ui/tag.css';
import './paper-reader.css';
import './annotations.css';
import { EASE_OUT, EASE_OUT_EXPO, MOTION_BASE_S } from '../../utils/motion-curves.ts';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

const outlineTarget = (sectionIndex: number) => `rd-section-${sectionIndex}`;

/** The pending passage as it is drawn: from its first provisional mark to its last. */
function pendingRange(scroll: HTMLElement) {
  const marks = scroll.querySelectorAll('.rd-mark--pending');
  if (!marks.length) return null;
  const range = document.createRange();
  range.setStartBefore(marks[0]);
  range.setEndAfter(marks[marks.length - 1]);
  return range;
}
const SELECTION_SETTLE_MS = 200;

const paragraphAround = (node: Node | null) => {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement;
  return element?.closest<HTMLElement>('.rd-p[data-section]') || null;
};

const LEVEL_ICONS = { beginner: Plant, university: GraduationCap, researcher: Flask } as const;

const COPY = {
  en: {
    title: 'AI summary',
    close: 'Close reader',
    level: 'Level',
    writing: 'Writing the summary',
    writingHint: 'Sections appear as they are written.',
    cached: 'Free to reopen',
    cachedTitle: 'A summary written earlier, reused: no AI use was spent.',
    adaptationTag: 'AI summary',
    original: 'View the original paper',
    adaptation: 'AI summary written from the full text. It does not replace the original article.',
    stages: {
      saved: 'Looking for your saved summary',
      source: 'Downloading the paper',
      reading: 'The model is reading the paper',
      writing: 'Writing the summary',
    },
    retry: 'Try again',
    incomplete: 'The summary stopped before finishing. You can try again.',
    reusedNote: 'Written earlier and reused, so it spent no AI use. Writing it again spends one.',
    writeAgain: 'Write it again',
    writeAgainFailed: (reason: string) => `${reason}. The summary above was not replaced.`,
    writeAgainIncomplete: 'The new summary stopped before finishing',
    sections: 'sections',
    annotations: 'Annotations',
    toggleAnnotations: 'Show annotations',
    toggleAiMarks: 'Show AI highlights',
    aiMarks: 'AI highlights',
    highlight: 'Highlight',
    settings: 'Settings',
    annotateParagraphInstructions: 'Press Enter to open annotation options for this paragraph: highlight it, write a note on it, or ask the AI to explain it.',
    annotateParagraphBadge: 'Enter: annotate',
    oneUse: '1 use',
    noUsesLeftShort: 'no uses',
    noUsesLeft: 'Today’s AI uses have run out.',
    reading: 'Reading the passage',
    originMine: 'Yours',
    originAi: 'AI',
    noteLabel: (number: number) => `Note ${number}`,
  },
};

/**
 * One failure, two lines: what happened, and what it means for the reader. A
 * single sentence had to carry both and ended up carrying neither — the old
 * screen was one grey line in the middle of an empty page, and it read as the
 * app giving up rather than as a thing that failed for a reason.
 */
const ERROR_COPY = {
  en: {
    AI_REWRITE_NEEDS_FULL_TEXT: {
      title: 'There is no paper to read',
      body: 'The full text could not be loaded. It may be paywalled, or the source may be down.',
    },
    AI_AUTH_REQUIRED: {
      title: 'You need to sign in',
      body: 'AI summaries are a feature for signed-in accounts.',
    },
    AI_QUOTA_EXHAUSTED: {
      title: 'Today’s uses have run out',
      body: 'AI uses come back tomorrow. In the meantime, the original paper is still where it was.',
    },
    AI_QUOTA_EXHAUSTED_PROVIDER: {
      title: 'The service has used up today’s quota',
      body: 'The ceiling is the model provider’s, not yours: your own uses are untouched. It usually frees up before long.',
    },
    AI_NOT_CONFIGURED: {
      title: 'AI summaries are not available',
      body: 'This feature is not switched on here yet. It is not the paper’s fault.',
    },
    AI_TIMEOUT: {
      title: 'It took too long',
      body: 'The model stopped answering halfway through. Retrying usually does it.',
    },
    AI_BUSY: {
      title: 'The service is busy',
      body: 'Too many requests at once. Wait a moment and try again.',
    },
    AI_INVALID_PAPER: {
      title: 'This paper cannot be summarized',
      body: 'The PDF does not carry enough text to summarize. Usually a scan, or a one-page article.',
    },
    AI_INVALID_RESPONSE: {
      title: 'The model answered in another format',
      body: 'It replied, but not in a shape the reader can lay out. Retrying almost always fixes it.',
    },
    AI_EMPTY_RESPONSE: {
      title: 'The model returned nothing',
      body: 'Usually an oversized PDF, or a provider limit. Retrying is sometimes enough.',
    },
    AI_CANCELLED: {
      title: 'Rewrite cancelled',
      body: 'It stopped before any writing began.',
    },
    AI_REQUEST_TOO_LARGE: {
      title: 'This paper is too large to rewrite',
      body: 'It does not fit in a single request to the model. The original is still where it was.',
    },
    AI_INVALID_REQUEST_UPSTREAM: {
      title: 'The model refused this paper',
      body: 'Not a service failure: with this document the answer would be the same. Try another level, or the original.',
    },
    AI_UNAVAILABLE: {
      title: 'The paper could not be rewritten',
      body: 'Something broke between the reader and the model. Retrying usually does it.',
    },
    AI_SAVED_SUMMARY_READ_FAILED: {
      title: 'Could not check for a saved summary',
      body: 'No AI use was spent. Trying again checks once more, and writes a new summary only if none is saved.',
    },
  },
};

/**
 * Not a worker code. A rewrite written again that stops before the end replaces
 * nothing, in the account or the worker's cache, so the reader puts back the
 * summary it would have replaced and says why under it.
 */
const WRITE_AGAIN_INCOMPLETE = 'AI_WRITE_AGAIN_INCOMPLETE';

/**
 * A failed annotation is not a failed rewrite.
 *
 * The rail borrowed `ERROR_COPY` at first, and every string in there is about
 * the paper being rewritten — so asking the model about one sentence and having
 * it fail told the reader "the paper could not be rewritten", about a paper
 * sitting rewritten on the screen in front of them. Same codes, same tone, one
 * line each: the rail is a 320px column, not an error page.
 */
const ANNOTATION_ERROR_COPY = {
  en: {
    AI_NOT_CONFIGURED: 'Asking the AI is not available yet.',
    AI_AUTH_REQUIRED: 'Sign in to ask the AI.',
    AI_QUOTA_EXHAUSTED: 'Today’s AI uses have run out.',
    AI_BUSY: 'The service is busy. Try again in a moment.',
    AI_TIMEOUT: 'The explanation took too long. You can ask again.',
    AI_EMPTY_RESPONSE: 'The model returned nothing about this passage.',
    AI_INVALID_REQUEST: 'Select a little more text to ask about it.',
    AI_UNAVAILABLE: 'This passage could not be explained.',
  },
};

const ERROR_POSES = {
  AI_QUOTA_EXHAUSTED: 'thinking',
  AI_TIMEOUT: 'thinking',
  AI_BUSY: 'thinking',
  AI_CANCELLED: 'thinking',
  AI_SAVED_SUMMARY_READ_FAILED: 'thinking',
  AI_UNAVAILABLE: 'upset',
  AI_INVALID_RESPONSE: 'upset',
  AI_EMPTY_RESPONSE: 'upset',
  AI_AUTH_REQUIRED: 'lost',
  AI_NOT_CONFIGURED: 'lost',
  AI_INVALID_PAPER: 'lost',
  AI_REWRITE_NEEDS_FULL_TEXT: 'lost',
  AI_REQUEST_TOO_LARGE: 'lost',
  AI_INVALID_REQUEST_UPSTREAM: 'lost',
} as const;

/**
 * Codes where pressing the button again cannot possibly help — the allowance is
 * spent, there is no session, the feature is off, the PDF has no text. Offering
 * a retry there spends a click to reprint the same screen, which is worse than
 * offering nothing. `AI_REWRITE_NEEDS_FULL_TEXT` is deliberately absent: the
 * worker sends it both for a paywall and for a mirror that timed out, and the
 * second one is worth another go.
 */
const UNRETRYABLE_ERRORS = new Set([
  'AI_QUOTA_EXHAUSTED',
  'AI_AUTH_REQUIRED',
  'AI_NOT_CONFIGURED',
  'AI_INVALID_PAPER',
  // The paper does not shrink, and the model's no is deterministic.
  'AI_REQUEST_TOO_LARGE',
  'AI_INVALID_REQUEST_UPSTREAM',
]);

/**
 * How long the reveal needs before the flag that draws it can come off: the
 * last staggered paragraph starts at `MAX_STAGGER_STEPS × 70ms` and runs for
 * 620ms, plus a margin so the flag never disappears mid-wipe.
 */
const REVEAL_SETTLE_MS = 1_500;
/** Past this many paragraphs the stagger stops growing, or a long section would
 *  still be revealing itself when the next one lands. */
const MAX_STAGGER_STEPS = 6;

/** Uneven on purpose: five bars of equal length read as a table, not as prose,
 *  and the short last line is most of what makes a block look like a paragraph. */
/* Five lines fill a laptop's measure and leave the bottom half of a phone
   empty. The tail past the fifth is drawn for every screen and hidden again
   above 640px, so the desktop ghost is the exact block it always was. */
const GHOST_LINES = Object.freeze([
  '100%', '97%', '99%', '93%', '61%',
  '100%', '96%', '98%', '91%', '58%',
]);

/*
 * The reader's own entrance and exit, the floating chrome a beat behind, are
 * CSS, on the `[data-open]` / `[data-closed]` attributes the Base UI Dialog
 * sets (see `.rd[data-open]` in paper-reader.css).
 */

/**
 * The panel's own coming and going, independent of the reader's.
 *
 * Asymmetric on purpose: arriving is an offer and takes its time, leaving is an
 * answer and should be out of the way before you notice. The transitions live
 * inside each target rather than on the element, which is what lets the two
 * directions differ at all.
 *
 * Passed to `animate` as objects, never as variant labels, so the panel animates
 * whenever its own state changes and nothing above it can override that.
 */
/**
 * Turns a DOM selection into an anchor in the paragraph's *source*.
 *
 * `selection.toString()` cannot do this once maths is involved. KaTeX renders
 * each formula twice — a visual copy and a clipped MathML copy — so the browser
 * hands back `x2x^2x2` for a `$x^2$` the source spells with dollars and a caret,
 * and the quote matches nothing on the way back. What does survive is where the
 * selection starts and ends, which every rendered run carries in `data-start` /
 * `data-end`. Maths is taken whole: there is no offset inside `x²` that means
 * anything in `$x^2$`.
 */
function anchorFromSelection(range: Range | null, paragraphNode: HTMLElement | null, paragraphText: string) {
  if (!range || !paragraphNode) return null;
  const normalizedParagraph = normalizeLatexText(paragraphText);
  let start = Infinity;
  let end = -Infinity;

  for (const node of paragraphNode.querySelectorAll<HTMLElement>('[data-start]')) {
    if (!range.intersectsNode(node)) continue;
    const nodeStart = Number(node.dataset.start);
    const nodeEnd = Number(node.dataset.end);
    if (!Number.isFinite(nodeStart) || !Number.isFinite(nodeEnd)) continue;

    if (node.dataset.math !== undefined) {
      start = Math.min(start, nodeStart);
      end = Math.max(end, nodeEnd);
      continue;
    }

    // A text run holds exactly one text node, and its characters follow the
    // normalized source in order — one for one except where `displayProse`
    // painted a `\%` as a single `%` — so the range's own offsets refine the
    // ends once walked back through the escapes.
    const textNode = node.firstChild;
    const length = nodeEnd - nodeStart;
    const runSource = normalizedParagraph.slice(nodeStart, nodeEnd);
    const from = range.startContainer === textNode ? proseSourceOffset(runSource, range.startOffset) : 0;
    const to = range.endContainer === textNode ? proseSourceOffset(runSource, range.endOffset) : length;
    start = Math.min(start, nodeStart + from);
    end = Math.max(end, nodeStart + to);
  }

  if (!Number.isFinite(start) || end <= start) return null;
  const built = buildRangeAnchor(paragraphText, start, end);
  // Offsets travel alongside the quote so a re-entry guard can tell two
  // identical substrings in the same paragraph apart — the quote alone cannot.
  return built ? { ...built, start, end } : null;
}

const KIND_LABELS = {
  en: { abstract: 'Abstract', intro: 'Introduction', background: 'Background', methods: 'Methods', results: 'Results', discussion: 'Discussion', conclusion: 'Conclusion', other: 'Section' },
};

function InfoTag({ className, info, children }: { className: string; info: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger render={<button type="button" className={className} />}>{children}</PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="rd-info-pop">
        <p>{info}</p>
      </PopoverContent>
    </Popover>
  );
}

export default function PaperReader({ paper, card, onClose, closeRef = null, initialLevel, onPaperTab, embedded = false, onLeave }: PaperReaderProps) {
  const { user, readingPreferences } = useAuth();
  const uid = user?.uid;
  const { trackEvent, consent } = useAnalyticsConsent();
  const prefersReducedMotion = useReducedMotion();
  const copy = COPY.en;
  const kindLabels = KIND_LABELS.en;
  // One shared id: every paragraph's `aria-describedby` on the keyboard
  // route points at the same hidden sentence rather than each rendering its
  // own copy of it.
  const paragraphHintId = useId();

  const [level, setLevel] = useState(() => initialLevel ?? readingPreferences.aiExplanationLevel);
  const [sections, setSections] = useState<RewriteSection[]>([]);
  const [revealingSections, setRevealingSections] = useState<Set<RewriteSection>>(() => new Set());
  const [meta, setMeta] = useState<ClientRewriteMeta | null>(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState<Pick<PaperRewriteError, 'code' | 'quota'> | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  // Set when a mouse-up turned the selection into a pending passage (pickSelection), so the
  // click that follows it does not open the notes and close the editor that just opened.
  const selectionTaken = useRef(0);
  // The passage while its handles are dragged; it becomes the pending one when they are let go.
  const [draggedRange, setDraggedRange] = useState<Range | null>(null);
  const [showAiMarks, setShowAiMarks] = useState(true);
  /**
   * The day's AI allowance, read without spending any of it. `meta.remainingUses`
   * only exists once a rewrite is under way — after it has already cost a use,
   * and never on a cache hit or a failure — so the reader asks for the number
   * itself and then keeps it up to date from whatever the stream reports.
   */
  const [seededQuota] = useState(() => lastKnownAIUses(uid));
  const quota = useSyncExternalStore(subscribeAIUses, () => lastKnownAIUses(uid));
  const [stage, setStage] = useState('source');
  const abortRef = useRef<AbortController | null>(null);
  // The reader's own scroll container, so a touch selection outside it (e.g.
  // in a dialog rendered elsewhere in the tree) is never mistaken for one of
  // its paragraphs.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const scrollRefCallback = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    setScrollElement(element);
  }, []);
  /**
   * The rewrite this reader has already asked for, keyed the way the rewrite
   * cache keys itself. The object arriving as `paper` is rebuilt upstream when
   * the open-access copy resolves (`readablePaper` in PaperCard), and until this
   * ref existed that new identity re-ran the effect below: the sections already
   * streamed were thrown away, the reader dropped back to `streaming`, and a
   * second of the ten daily uses went on the very same paper.
   */
  const requestedRewriteRef = useRef('');
  /**
   * The reader closes itself and only then tells the card.
   *
   * The card mounts it as `{showReader && createPortal(…)}`, so calling
   * `onClose` deletes the node in the same commit. Owning `open` here means
   * the Base UI Dialog gets to play its leave first — it holds the node until
   * the `[data-closed]` animation ends — and `onOpenChangeComplete(false)` is
   * the one moment the card is told. The card keeps its one-line mount.
   */
  const afterClose = useRef<(() => void) | null>(null);
  // The Paper tab closes the reader the way its X does, so the press ends on the reader rather
  // than on whatever is under it once it is gone, and then hands over to the paper.
  const toPaper = useRef(false);
  const [open, setOpen] = useState(true);
  // Inside the viewer there is no dialog of its own to play a leave: closing is the viewer's.
  const requestClose = useCallback(() => (embedded ? onClose() : setOpen(false)), [embedded, onClose]);
  const readerOpenTracked = useRef(false);
  useEffect(() => {
    if (readerOpenTracked.current) return;
    readerOpenTracked.current = true;
    void trackEvent('reader_open', { surface: 'reader' });
  }, [trackEvent]);
  /**
   * The one way out, published for the browser's Back button.
   *
   * The card arms `useOverlayHistory` with whatever this ref holds, so Back
   * ends up in `requestClose` — the same function the X, Escape and
   * `onOpenChange(false)` already travel through — instead of deleting this
   * node with `open` still true, which would cut the leave short and leave
   * Base UI's scroll lock and `inert` sitting on the page behind it, with
   * nothing left to unwind them (use-overlay-history.ts).
   * `useImperativeHandle` rather than a hand-written `closeRef.current = …`:
   * it publishes in the layout phase, before the frame the card arms on, and
   * clears itself on unmount — and a prop is not ours to mutate by hand.
   */
  useImperativeHandle(closeRef, () => requestClose, [requestClose]);
  // Where focus lands on open: the way back, as it always was
  // (`data-dialog-initial-focus`, now the popup's `initialFocus`).
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  // Where focus goes when "Write it again" takes its own button off the page.
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  const supportsRewrite = canRewritePaper(paper);
  const paperId = paper?.id || paper?.doi || paper?.arxivId || '';
  // The journal's name opens its Explorer page (ENG-123).
  const journal = journalExplorerLink(paper);
  const acceptedAt = acceptedConferenceText(paper);

  const load = useCallback(async (targetLevel: string, {
    force = false,
    // The summary on screen when the reader asked to write it again. It is
    // still the saved one until a complete new rewrite replaces it, so a
    // request that fails or stops before the end puts it back instead of an
    // error page or a partial paper.
    rewriteOf = null as { sections: RewriteSection[]; meta: ClientRewriteMeta } | null,
  } = {}) => {
    const regenerate = Boolean(rewriteOf);
    setRevealingSections(new Set());
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = performance.now();

    // A cached level swaps in without a loading state at all.
    const cached = !force && !regenerate && getCachedRewrite(paper, targetLevel, 'en');
    if (cached) {
      setSections(cached.sections);
      setMeta({ ...cached.meta, cached: true });
      setStatus('ready');
      setError(null);
      void trackEvent('paper_rewrite_result', {
        level: targetLevel, surface: 'reader', result: 'success', cached: true, duration_ms: performance.now() - startedAt,
      });
      return;
    }

    setSections([]);
    setMeta(null);
    setError(null);
    setStage('source');
    setStatus('streaming');
    // A copy replayed from the account or the worker's cache arrives whole.
    let replayed = false;
    // A summary saved in the account comes back without a Worker request, so
    // its result is cached. A Worker cache replay was still a request.
    let requested = false;

    try {
      const result = await rewritePaper(paper, targetLevel, {
        language: 'en',
        force,
        regenerate,
        uid,
        signal: controller.signal,
        // Counted when the request leaves rather than when loading starts: a
        // summary saved in the account never reaches the worker and spends
        // nothing, and a retry, which does spend a use, is still counted.
        onRequest: () => {
          requested = true;
          setStage('source');
          void trackEvent('paper_rewrite', { level: targetLevel, surface: 'reader', paper_id: paper.id });
        },
        onMeta: (nextMeta) => {
          replayed = nextMeta.cached === true;
          setMeta(nextMeta);
          // The reservation has already happened by the time this arrives, so it
          // is the freshest count there is — fresher than what the reader asked
          // for when it opened.
          if (uid && typeof nextMeta.remainingUses === 'number') noteAIUsesLeft(uid, nextMeta.remainingUses);
        },
        // `reveal` is what separates a section that was just written from one
        // that was already there. Only the fresh one gets the wipe; a cached
        // rewrite arrives all at once and must not stage a whole paper's worth
        // of animation nobody asked to watch.
        onSection: (section) => {
          setSections(current => [...current, section]);
          if (!replayed) setRevealingSections(current => new Set([...current, section]));
        },
        onProgress: ({ stage: nextStage }) => setStage(nextStage),
      });
      void trackEvent('paper_rewrite_result', {
        level: targetLevel, surface: 'reader', result: result.incomplete ? 'incomplete' : 'success',
        cached: !requested, duration_ms: performance.now() - startedAt,
      });
      if (result.incomplete && rewriteOf) {
        setSections(rewriteOf.sections);
        setMeta(rewriteOf.meta);
        setError({ code: WRITE_AGAIN_INCOMPLETE, quota: null });
        setStatus('ready');
        return;
      }
      setStatus(result.incomplete ? 'incomplete' : 'ready');
    } catch (caught) {
      void trackEvent('paper_rewrite_result', {
        level: targetLevel, surface: 'reader', result: controller.signal.aborted ? 'cancelled' : 'error',
        cached: false, duration_ms: performance.now() - startedAt,
        error_code: caught instanceof PaperRewriteError ? caught.code : 'AI_UNAVAILABLE',
      });
      if (caught instanceof PaperRewriteError && caught.code === 'AI_CANCELLED') return;
      if (caught instanceof PaperRewriteError && caught.code === 'AI_QUOTA_EXHAUSTED') {
        void trackEvent('ai_limit_reached', { feature: 'rewrite', scope: caught.quota?.scope });
      }
      // The whole error, not only its code: `quota.scope` is what tells the
      // reader's own ceiling from the provider's, and those need opposite advice.
      setError(caught instanceof PaperRewriteError
        ? { code: caught.code, quota: caught.quota }
        : { code: 'AI_UNAVAILABLE', quota: null });
      if (rewriteOf) {
        setSections(rewriteOf.sections);
        setMeta(rewriteOf.meta);
        setStatus('ready');
      } else {
        setStatus('error');
      }
      // Most failures hand the use back, and the worker does it after the count
      // on the `meta` line was already sent. Re-reading is the only way the chip
      // can show the refund rather than a use the reader never actually spent.
      // Without a request, as when the saved summary could not be read, there
      // is nothing to refund.
      if (requested && uid) void refreshAIUses(uid, controller.signal);
    }
  }, [paper, trackEvent, uid]);

  useEffect(() => {
    // The two ways the PDF can change are not the same thing. Going from no
    // readable PDF to one is a request that never happened, and the gate below
    // holds the key unclaimed until then, so it fires the moment the open-access
    // copy produces a URL. One readable PDF swapping for a better one is not:
    // the key ignores `pdfUrl`, so that re-run recognises its own request and
    // leaves the stream in flight alone.
    if (!supportsRewrite) return undefined;
    const requestKey = rewriteCacheKey(paper, level, 'en');
    if (requestedRewriteRef.current === requestKey) return undefined;
    // Deferred so the request starts after this render commits. The key is
    // claimed inside the timer rather than before it: an effect torn down
    // before its timer fires has requested nothing, and must leave the rewrite
    // pending, not swallowed.
    const timerId = setTimeout(() => {
      requestedRewriteRef.current = requestKey;
      void load(level);
    }, 0);
    return () => clearTimeout(timerId);
  }, [level, load, paper, supportsRewrite]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * The feed behind an open reader is invisible and still expensive.
   *
   * `.rd` is opaque and covers the viewport, but the feed underneath stays in
   * the layout tree, so every style recalculation walks it as well — measured
   * at 8.5ms with it and 3.9ms without, on a 2900-element page. That matters
   * far more than it sounds: framer-motion animates by writing inline styles
   * every frame, so each of those frames was paying for a document nobody could
   * see, and 8.5ms of recalculation does not fit in a 16.7ms frame alongside
   * paint. `content-visibility: hidden` skips the subtree's layout while
   * preserving its rendering state — the feed's scroll position survives, which
   * `display: none` would have thrown away.
   *
   * Delayed until the entrance has finished, and dropped the instant the exit
   * begins: the reader grows out of the card behind it and collapses back into
   * it, and that card has to be there for both.
   */
  const [settled, setSettled] = useState(false);
  // Derived, not cleared: closing has to lift the cover in the same commit that
  // starts the exit, and a setState in an effect would arrive a render late —
  // one frame of the reader shrinking over a page with no feed behind it.
  const coversFeed = open && settled;

  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => setSettled(true), prefersReducedMotion ? 140 : 380);
    return () => clearTimeout(timer);
  }, [open, prefersReducedMotion]);

  // Time with the reader on screen, sent when it closes (reader-time.ts).
  // Keyed on the paper's identity: a new object for the same paper is not a
  // second reading. A change of consent or account while open drops it:
  // `consent` and `uid` drop it at once, and `analyticsSessionContext` checks
  // again at each send.
  const reportReaderTime = useEffectEvent((seconds: number, id: string, stillValid: () => boolean) => {
    void trackEvent('reader_time', { level, seconds, paper_id: id }, stillValid);
  });
  const readerTimeRef = useRef<ReturnType<typeof startReaderTime> | null>(null);
  useEffect(() => {
    readerTimeRef.current?.check();
  }, [consent, uid]);
  useEffect(() => {
    const session = startReaderTime({
      now: Date.now,
      visibility: documentVisibility,
      context: analyticsSessionContext,
      send: (seconds, stillValid) => reportReaderTime(seconds, paperId, stillValid),
    });
    readerTimeRef.current = session;
    return () => {
      session.stop();
      readerTimeRef.current = null;
    };
  }, [paperId]);

  useEffect(() => {
    if (!coversFeed) return undefined;
    document.body.setAttribute('data-reader-open', '');
    return () => document.body.removeAttribute('data-reader-open');
  }, [coversFeed]);

  /**
   * Takes the reveal flag back off once the wipe has finished. The mask that
   * draws it stays on the paragraph for as long as the flag does, and a mask is
   * a rasterised layer: leaving one on every paragraph of a long rewrite costs
   * memory and softens the type on some GPUs for an effect that is over.
   */
  useEffect(() => {
    if (revealingSections.size === 0) return undefined;
    const timerId = setTimeout(() => setRevealingSections(new Set()), REVEAL_SETTLE_MS);
    return () => clearTimeout(timerId);
  }, [revealingSections]);

  useEffect(() => {
    if (!uid) return undefined;
    const controller = new AbortController();
    void refreshAIUses(uid, controller.signal);
    return () => controller.abort();
  }, [uid]);

  const touch = useMemo(() => {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
  }, []);

  const annotations = usePassageAnnotations({
    uid,
    paper,
    paperId,
    level,
    language: 'en',
    trackEvent,
  });

  const { begin: beginAnnotation } = annotations;
  const [annotationOrigin, setAnnotationOrigin] = useState<HTMLElement | null>(null);
  const [failedNote, setFailedNote] = useState<string | null>(null);

  const outlineItems = useMemo(() => sections.map((section, index) => ({
    target: outlineTarget(index),
    depth: 0,
    title: section.heading || section.originalHeading?.trim() || kindLabels[section.kind as keyof typeof kindLabels] || kindLabels.other,
  })), [sections, kindLabels]);
  const outline = useOutlineActive(outlineItems, scrollElement);
  const [titleInView, setTitleInView] = useState(true);
  useEffect(() => {
    const title = titleRef.current;
    if (!scrollElement || !title) return;
    const observer = new IntersectionObserver(([entry]) => setTitleInView(entry.intersectionRatio >= 0.99), { root: scrollElement, threshold: [0, 0.99] });
    observer.observe(title);
    return () => observer.disconnect();
  }, [scrollElement]);

  /**
   * A selection stops being a selection and becomes a decision.
   *
   * Everything the three outcomes could need is captured here, in one go, at
   * the moment the selection is decided (mouse-up, raised by the document
   * listener below): the quote, where it is
   * anchored, the paragraph around it (the model cannot explain "that
   * quantity" without the sentence that named it), and the rectangle to hang
   * the menu off. Capturing it all up front is what lets the browser's own
   * selection be cleared immediately — the reader paints its own provisional
   * mark instead, so the highlight you are deciding about is one you can
   * already see.
   */
  const handleSelection = useCallback((
    range: Range,
    sectionId: string,
    paragraphIndex: number,
    paragraphText: string,
    paragraphNode: HTMLElement,
    end?: { paragraphIndex: number; text: string; node: HTMLElement; between: string[] },
  ) => {
    if (!uid) return false;
    // Offsets first, the selected string only as a fallback: the string is
    // wrong wherever the selection touched a formula, but it is still the right
    // answer for anything the offset walk could not map.
    const anchor = anchorFromSelection(range, paragraphNode, paragraphText)
      || buildSelectionAnchor(range.toString());
    if (!anchor) return false;
    const endAnchor = end ? anchorFromSelection(range, end.node, end.text) : null;
    const spans = end && endAnchor ? { end, endAnchor } : null;
    const rect = range.getBoundingClientRect();
    beginAnnotation({
      sectionId,
      paragraphIndex,
      quote: anchor.quote,
      quoteStart: (anchor as { start?: number }).start,
      quoteEnd: (anchor as { end?: number }).end,
      ...(spans ? {
        endParagraphIndex: spans.end.paragraphIndex,
        endQuote: spans.endAnchor.quote,
        text: [anchor.quote, ...spans.end.between, spans.endAnchor.quote].join('\n\n'),
      } : {}),
      context: spans ? [paragraphText, ...spans.end.between, spans.end.text].join('\n\n') : paragraphText,
      anchor: {
        left: rect.left,
        top: rect.top,
        bottom: rect.bottom,
        right: rect.right,
      },
    });
    return true;
  }, [beginAnnotation, uid]);

  /**
   * The keyboard route into the same fork `handleSelection` opens from a
   * mouse selection.
   *
   * There is no caret to select a phrase with here: paragraphs are not
   * editable, and the one browser feature that would hand a keyboard a caret
   * on plain text -- caret browsing -- defaults to off, needs a manual
   * toggle (F7 on Windows) this page cannot invoke, and does not exist on
   * macOS at all. So the keyboard's unit is the whole paragraph rather than
   * a phrase: WCAG does not require matching the mouse route's granularity,
   * only that the function itself stays reachable (2.1.1).
   */
  const handleParagraphKeyDown = useCallback((event: KeyboardEvent<HTMLParagraphElement>, sectionId: string, paragraphIndex: number, paragraphText: string) => {
    if (event.key !== 'Enter' || !uid) return;
    event.preventDefault();
    const normalized = normalizeLatexText(paragraphText);
    const anchor = buildRangeAnchor(paragraphText, 0, normalized.length);
    if (!anchor) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setFailedNote(null);
    setAnnotationOrigin(event.currentTarget);
    beginAnnotation({
      sectionId,
      paragraphIndex,
      quote: anchor.quote,
      quoteStart: 0,
      quoteEnd: normalized.length,
      context: paragraphText,
      anchor: {
        left: rect.left,
        top: rect.top,
        bottom: rect.bottom,
        right: rect.right,
      },
    });
  }, [beginAnnotation, uid]);

  /** The source text of a paragraph, by the ids its `<p>` carries. */
  const paragraphTextFor = useCallback((sectionId: string | undefined, paragraphIndex: number) => {
    const section = sections.find(item => String(item.id) === String(sectionId));
    const text = section?.paragraphs?.[paragraphIndex];
    return typeof text === 'string' ? text : null;
  }, [sections]);

  /**
   * The mouse-up that decides a selection, on the document rather than on the
   * paragraph. It lived on each `<p>`, so a drag released on the section
   * title, in the margin or in the gap between paragraphs — where a drag to
   * the end of a sentence usually ends — reached no handler: no menu, no
   * provisional mark, and the browser's own selection left on the page
   * (measured 2026-09-17). The paragraph is read off the selection itself:
   * the one holding where it STARTS, so a selection that crosses into the
   * next paragraph quotes from where the reader began and is clipped to that
   * paragraph's end (`anchorFromSelection` only walks the paragraph it is
   * given) — or, when the start itself is outside every paragraph (a drag
   * upwards that overshot into the gap above), the one holding where it
   * ENDS. Releases over the menu, the rail or a text field find no
   * paragraph and do nothing, as before.
   */
  /** A range of the text, from a selection or the handles, as the pending passage. */
  const annotateRange = useCallback((range: Range) => {
    setFailedNote(null);
    setAnnotationOrigin(null);
    const start = range.startContainer;
    const paragraph = paragraphAround(start) || paragraphAround(range.endContainer);
    if (!paragraph || !scrollRef.current?.contains(paragraph)) return false;
    const sectionId = paragraph.dataset.section!;
    const paragraphIndex = Number(paragraph.dataset.paragraph);
    const text = paragraphTextFor(sectionId, paragraphIndex);
    if (text === null) return false;
    // A selection that runs into later paragraphs of the same section is one
    // passage; one that crosses into another section stops where it started.
    const last = paragraphAround(range.endContainer);
    const lastIndex = Number(last?.dataset.paragraph);
    const lastText = last && last.dataset.section === sectionId && lastIndex > paragraphIndex
      ? paragraphTextFor(sectionId, lastIndex)
      : null;
    const between = [];
    for (let index = paragraphIndex + 1; index < lastIndex; index += 1) between.push(paragraphTextFor(sectionId, index) ?? '');
    return handleSelection(range, sectionId, paragraphIndex, text, paragraph, last && lastText !== null
      ? { paragraphIndex: lastIndex, text: lastText, node: last, between }
      : undefined);
  }, [handleSelection, paragraphTextFor]);
  const pickSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    if (!annotateRange(selection.getRangeAt(0))) return;
    // The editor takes the selection's place, and the click this mouse-up is about to
    // fire belongs to the selection, not to a mark under it.
    selection.removeAllRanges();
    selectionTaken.current = performance.now();
  }, [annotateRange]);
  useEffect(() => {
    if (touch) return undefined;
    document.addEventListener('mouseup', pickSelection);
    return () => document.removeEventListener('mouseup', pickSelection);
  }, [pickSelection, touch]);

  const [touchRange, setTouchRange] = useState<Range | null>(null);
  const waitsForTouch = touch && Boolean(uid) && !annotations.pending;
  useEffect(() => {
    if (!waitsForTouch) return undefined;
    const read = () => {
      const selection = window.getSelection();
      const range = selection && !selection.isCollapsed && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      const inText = range && scrollRef.current?.contains(range.commonAncestorContainer)
        && (paragraphAround(range.startContainer) || paragraphAround(range.endContainer))
        && selection!.toString().trim().length >= HIGHLIGHT_MIN_QUOTE_LENGTH;
      setTouchRange(inText ? range.cloneRange() : null);
    };
    let timer = 0;
    const later = () => { clearTimeout(timer); timer = window.setTimeout(read, SELECTION_SETTLE_MS); };
    document.addEventListener('selectionchange', later);
    return () => { clearTimeout(timer); document.removeEventListener('selectionchange', later); };
  }, [waitsForTouch]);
  const highlightTouchSelection = () => {
    if (!touchRange) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(touchRange);
    setTouchRange(null);
    pickSelection();
  };

  const sectionOrder = useMemo(() => buildSectionOrder(sections), [sections]);
  const orderedAnnotations = useMemo(
    () => sortAnnotations(annotations.annotations.filter(item => item.level !== FULL_TEXT_LEVEL), sectionOrder),
    [annotations.annotations, sectionOrder],
  );
  // The highlight the reader clicked, as in the viewer: it opens the notes at its entry.
  // Derived against the list, so a deleted one simply drops out.
  const [picked, setPicked] = useState<string | null>(null);
  const activeNote = orderedAnnotations.some(item => item.id === picked) ? picked : null;
  const openHighlightAt = (event: ReactMouseEvent<HTMLDivElement>) => {
    // The click a mouse-up fires comes at once; a later one is the reader's own.
    const fromSelection = performance.now() - selectionTaken.current < 400;
    selectionTaken.current = 0;
    if (fromSelection || event.detail > 1 || window.getSelection()?.isCollapsed === false) return;
    const mark = (event.target as Element).closest<HTMLElement>('[data-highlight-id]');
    const id = mark?.dataset.highlightId ?? null;
    // An AI note hidden by the AI highlights switch is not there to click.
    const hit = id !== null && !(mark?.classList.contains('rd-mark--ai') && !showAiMarks) && orderedAnnotations.some(item => item.id === id);
    setPicked(hit ? id : null);
    if (!hit) return;
    setNotesOpen(true);
    // As in the viewer: on a phone the notes cover the text, so focus goes to them.
    const paragraph = mark?.closest('[data-passage]');
    requestAnimationFrame(() => {
      if (window.matchMedia('(max-width: 719px)').matches) document.querySelector<HTMLElement>('#reader-notes .vn-side-title')?.focus();
      else paragraph?.scrollIntoView({ block: 'nearest' });
    });
  };
  // The place in the margin where the answer being written will be filed.
  const answerAt = useMemo(
    () => answerSlot(orderedAnnotations, annotations.askedAt, sectionOrder),
    [annotations.askedAt, sectionOrder, orderedAnnotations],
  );

  /**
   * Asking for an explanation is asking to read one, and the answer only ever
   * appears in the margin — so the margin comes out if it was put away (or
   * the sheet up, below 1100px), and a filter showing only your own notes
   * steps back to all of them. Left alone, each of those hid the answer the
   * reader had just spent a use on.
   */
  // As in the viewer: a passage over the reader's own highlights in its paragraph replaces
  // them, keeping their notes.
  const saveAnnotation = async (note: string, color: HighlightColor) => {
    const passage = annotations.pending;
    const text = passage && !passage.endQuote ? paragraphTextFor(passage.sectionId, passage.paragraphIndex) : null;
    // Without an occurrence on either side, a quote said twice in the paragraph could match
    // the wrong one, so only quotes the paragraph holds once take part.
    const once = (quote: string) => text !== null && quoteOffsets(text, quote, 1) === null;
    const { note: words, replaced } = replacingHighlights(note, passage && text !== null && once(passage.quote)
      ? overlapping(text, passage, orderedAnnotations.filter(item => item.kind === 'user' && !item.endQuote
        && item.sectionId === passage.sectionId && item.paragraphIndex === passage.paragraphIndex && once(item.quote)))
      : []);
    const saved = words ? await annotations.saveNote(words, color) : await annotations.highlight(color);
    if (saved) {
      setFailedNote(null);
      annotationOrigin?.focus({ preventScroll: true });
      const removed = await Promise.all(replaced.filter(item => item.id !== saved.id).map(item => annotations.remove(item.id)));
      if (!removed.every(Boolean)) toast.error('Saved, but the old highlight could not be removed. Try deleting it.');
      return;
    }
    if (passage) beginAnnotation(passage);
    setFailedNote(note);
  };

  const { ask: askAnnotation } = annotations;
  const askAboutPassage = useCallback((question = '') => {
    setNotesOpen(true);
    return askAnnotation(question);
  }, [askAnnotation]);

  const userHighlightIndex = useMemo(() => {
    const index = indexHighlightsByParagraph(annotations.annotations, {
      level,
      language: 'en',
      paragraphText: paragraphTextFor,
    });
    // One transient state gets folded in here rather than stored: the pen
    // stroke on a mark that has just been made.
    for (const [key, bucket] of index) {
      index.set(key, bucket.map(item => {
        const stored = annotations.annotations.find(entry => entry.id === item.id);
        return { ...item, fresh: Boolean(stored?.fresh) };
      }));
    }
    // The passage the menu is open on wears the pen already, provisionally.
    const waiting = annotations.pending;
    if (waiting) {
      for (const segment of passageSegments(waiting, paragraphTextFor)) {
        const key = `${waiting.sectionId}:${segment.paragraphIndex}`;
        index.set(key, [
          ...(index.get(key) || []),
          { id: 'pending', quote: segment.quote, kind: 'user', source: 'user', pending: true },
        ]);
      }
    }
    return index;
  }, [annotations.annotations, annotations.pending, level, paragraphTextFor]);

  const originalUrl = safeExternalUrl(paper?.openAccessPdfUrl)
    || safeExternalUrl(paper?.pdfUrl)
    || safeExternalUrl(paper?.landingPageUrl)
    || safeDoiUrl(paper?.doi);


  /** Where the passage is, said in the reader's own vocabulary: "Método · §2". */
  const annotationLabel = useCallback((annotation: Pick<PassageAnnotation, 'sectionId' | 'paragraphIndex' | 'endParagraphIndex'>) => {
    const section = sections.find(item => String(item.id) === String(annotation.sectionId));
    const kind = kindLabels[section?.kind as keyof typeof kindLabels] || kindLabels.other;
    const first = Number(annotation.paragraphIndex) + 1;
    const last = annotation.endParagraphIndex === undefined ? first : Number(annotation.endParagraphIndex) + 1;
    return `${kind} · §${last > first ? `${first}–${last}` : first}`;
  }, [kindLabels, sections]);

  const notePins = useMemo(
    () => new Map(orderedAnnotations.filter(item => item.note).map((item, index) => [
      item.id,
      {
        number: index + 1,
        note: item.note!,
        kind: item.kind,
        label: copy.noteLabel(index + 1),
        origin: item.kind === 'ai' ? copy.originAi : copy.originMine,
        where: annotationLabel(item),
      },
    ])),
    [annotationLabel, copy, orderedAnnotations],
  );
  const pinsByParagraph = useMemo(() => {
    const byParagraph = new Map<string, typeof notePins>();
    for (const annotation of orderedAnnotations) {
      const pin = notePins.get(annotation.id);
      if (!pin || (!showAiMarks && pin.kind === 'ai')) continue;
      const key = `${annotation.sectionId}:${annotation.endParagraphIndex ?? annotation.paragraphIndex}`;
      byParagraph.set(key, new Map([...(byParagraph.get(key) || []), [annotation.id, pin]]));
    }
    return byParagraph;
  }, [notePins, orderedAnnotations, showAiMarks]);

  /**
   * The rail sends the reader back to a passage. `block: 'center'` is the whole
   * answer: the mark is already the only coloured thing on the page, so putting
   * it in the middle of the screen puts it under the reader's eyes. It used to
   * glow on arrival as well, which mostly fired when nobody had asked.
   */
  const cancelSweepRef = useRef<(() => void) | null>(null);
  const goToPassage = useCallback((annotation: PassageAnnotation) => {
    const selector = `[data-section="${CSS.escape(String(annotation.sectionId))}"][data-paragraph="${Number(annotation.paragraphIndex)}"]`;
    const paragraph = scrollRef.current?.querySelector(selector);
    if (!paragraph) return;
    paragraph.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'center',
    });
    const scroller = scrollRef.current;
    cancelSweepRef.current?.();
    if (prefersReducedMotion || !scroller) return;
    const controller = new AbortController();
    const sweep = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      scroller.querySelectorAll<HTMLElement>(`[data-highlight-id="${CSS.escape(String(annotation.id))}"]`).forEach(mark => {
        mark.removeAttribute('data-arrived');
        void mark.offsetWidth;
        mark.setAttribute('data-arrived', '');
        mark.addEventListener('animationend', () => mark.removeAttribute('data-arrived'), { once: true });
      });
    };
    const startTop = scroller.scrollTop;
    scroller.addEventListener('scrollend', sweep, { signal: controller.signal });
    const timer = setTimeout(sweep, 800);
    controller.signal.addEventListener('abort', () => clearTimeout(timer));
    cancelSweepRef.current = () => controller.abort();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (scroller.scrollTop === startTop) sweep();
    }));
  }, [prefersReducedMotion]);
  useEffect(() => () => cancelSweepRef.current?.(), []);


  const gateError = supportsRewrite ? null : 'AI_REWRITE_NEEDS_FULL_TEXT';
  const shownStatus = gateError ? 'error' : status;
  const shownError = gateError || error?.code || null;
  /**
   * The same 429 means two opposite things. The reader's own ten uses run out
   * until tomorrow and there is nothing to do; the model provider's ceiling is
   * somebody else's and usually frees up in minutes — and it is the far more
   * common of the two. Told they had spent their allowance, readers who had
   * spent none of it stopped asking.
   */
  const providerQuota = shownError === 'AI_QUOTA_EXHAUSTED' && error?.quota?.scope === 'provider';
  const isStreaming = shownStatus === 'streaming';
  const errorCopy = ERROR_COPY.en[(providerQuota ? 'AI_QUOTA_EXHAUSTED_PROVIDER' : shownError) as keyof typeof ERROR_COPY.en]
    || ERROR_COPY.en.AI_UNAVAILABLE;
  const stageLabel = copy.stages[stage as keyof ReaderCopy['stages']] || copy.writing;
  const errorPose = providerQuota ? 'thinking' : ERROR_POSES[shownError as keyof typeof ERROR_POSES] || 'upset';
  const canRetry = supportsRewrite && (providerQuota || !UNRETRYABLE_ERRORS.has(shownError!));

  const usesQuota = quota && !quota.unlimited && quota.dailyLimit ? { left: quota.remainingUses, limit: quota.dailyLimit } : null;
  // The seed draws the pill but never refuses a use: it may be yesterday's.
  const quotaConfirmed = quota !== null && quota !== seededQuota;
  const canSpendUse = quotaConfirmed ? Boolean(quota.unlimited) || quota.remainingUses > 0 : true;
  // Only a signed-in reader can ask the worker at all, and their copy is the one
  // a new rewrite replaces. `error` here is a failed attempt to write it again,
  // which left the reused summary on screen.
  const canWriteAgain = Boolean(uid) && meta?.cached === true && shownStatus === 'ready';
  const writeAgainOpen = canSpendUse && (!error || canRetry);
  const writeAgain = () => {
    // The button leaves the page while the new rewrite streams in.
    titleRef.current?.focus();
    void load(level, { rewriteOf: { sections, meta: meta! } });
  };
  // A failed attempt brings the button back beside the reason the alert reads
  // out, so focus returns to it from the title it waited on.
  const writeAgainRef = useRef<HTMLButtonElement | null>(null);
  const writeAgainFailed = canWriteAgain && Boolean(error);
  useEffect(() => {
    if (writeAgainFailed && document.activeElement === titleRef.current) writeAgainRef.current?.focus();
  }, [writeAgainFailed]);
  // The error state's retry follows the same path: focus waits on the title
  // while the paper loads again, and comes back to the button if it fails again.
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const retry = () => {
    titleRef.current?.focus();
    // A saved summary that could not be read is looked up again. A forced
    // retry skips that lookup and could write a new copy over the saved one.
    void load(level, { force: shownError !== 'AI_SAVED_SUMMARY_READ_FAILED' });
  };
  const retryOffered = shownStatus === 'error' && canRetry;
  useEffect(() => {
    if (retryOffered && document.activeElement === titleRef.current) retryRef.current?.focus();
  }, [retryOffered]);
  const { error: askError, clearError: clearAskError } = annotations;
  useEffect(() => {
    if (!askError) return;
    toast.error(ANNOTATION_ERROR_COPY.en[askError as keyof typeof ANNOTATION_ERROR_COPY.en]
      || ANNOTATION_ERROR_COPY.en.AI_UNAVAILABLE);
    clearAskError();
  }, [askError, clearAskError]);

  /* As the viewer's AI summary tab, the reader is a region of the viewer's own dialog, which
     already owns the focus trap, Escape and the scrim; opened from a card, it is a dialog. */
  const shell = (body: ReactNode) => (embedded ? (
    <div className="rd rd--embedded" role="region" aria-label={copy.title}>{body}</div>
  ) : (
    /* A full-screen Base UI Dialog: modal (FeedContainer's scroll guard reads
       the `aria-modal` it sets), with pointer dismissal off because a surface
       that covers the viewport has no outside to press — and the selection
       menu is a portaled popover that must not read as one.
       The centred-sheet look of DialogContent is undone in `.rd` itself
       (paper-reader.css), which is also everything else the shell looks like. */
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) requestClose(); }}
      onOpenChangeComplete={(next) => { if (!next) { if (toPaper.current && onPaperTab) onPaperTab(); else onClose(); afterClose.current?.(); } }}
      modal
      disablePointerDismissal
    >
      <DialogContent
        className="rd inset-0 max-w-none translate-x-0 translate-y-0 rounded-none border-0 shadow-none"
        overlayClassName="rd-scrim"
        showClose={false}
        initialFocus={closeButtonRef}
        aria-label={copy.title}
      >
        {body}
      </DialogContent>
    </Dialog>
  ));

  return shell(<>
          {/* As the viewer's tab, the viewer's own bar stays above the reader, its tabs and close included. */}
          {!embedded && <header className="rd-topbar">
            <Button
              ref={closeButtonRef}
              variant="ghost"
              size="icon-sm"
              onClick={requestClose}
              aria-label={copy.close}
              title={copy.close}
            >
              <X size={18} aria-hidden="true" />
            </Button>
            {/* The bar names the paper once the document's own title has scrolled
                away, rising in from below; it leaves the way it came. Opened as the
                viewer's tab, the bar holds the two tabs instead. */}
            {onPaperTab ? <ReadingTabs current="summary" onChange={(view) => {
              if (view !== 'paper') return;
              if (embedded) { onPaperTab(); return; }
              toPaper.current = true;
              requestClose();
            }} /> : <AnimatePresence initial={false}>
              {!titleInView && (
                <motion.p
                  key="title"
                  className="rd-topbar-title"
                  initial={{ opacity: 0, transform: 'translateY(40%)' }}
                  animate={{ opacity: 1, transform: 'translateY(0%)' }}
                  exit={{ opacity: 0, transform: 'translateY(40%)' }}
                  transition={{ duration: MOTION_BASE_S, ease: EASE_OUT }}
                >
                  <ScientificText>{paper?.title}</ScientificText>
                </motion.p>
              )}
            </AnimatePresence>}
          </header>}

        {/* The viewer's stage: the notes take the right of it, and the paper and its dock move over. */}
        <div className="pdf-stage rd-stage" data-notes-open={notesOpen || undefined}>
        <div
          ref={scrollRefCallback}
          className="rd-scroll"
          onScroll={() => annotations.dismiss()}
          onClick={openHighlightAt}
        >
          <article className="rd-doc" data-ai-marks={showAiMarks ? undefined : 'hidden'}>
            {/* The one title in the app that used to be printed raw: every other
                surface sends it through the same renderer, so a paper called
                "the $\mu$-Deformed Model" arrived here still wearing its dollars. */}
            {(usesQuota || sections.length > 0 || paper?.year || journal || acceptedAt) && (
              <div className="rd-doc-tags">
                {usesQuota && (
                  <span className="rd-tag rd-tag--ai rd-uses" role="status">
                    <Sparkle size={12} aria-hidden="true" />
                    <UsesCount left={usesQuota.left} limit={usesQuota.limit} />
                  </span>
                )}
                {sections.length > 0 && (
                  <InfoTag className="rd-tag rd-tag--ai" info={[copy.adaptation, meta?.model].filter(Boolean).join(' · ')}>
                    <Sparkle size={12} aria-hidden="true" />
                    {copy.adaptationTag}
                  </InfoTag>
                )}
                {paper?.year && <span className="rd-tag">{paper.year}</span>}
                {acceptedAt && <span className="rd-tag">{acceptedAt}</span>}
                {journal && (
                  <Link
                    to={journal.path}
                    className="rd-tag rd-tag--link"
                    // The reader leaves for the page, which may be the one
                    // under it when it opened from that journal's Explorer page.
                    // As with the Similar layer's links, the reader's history
                    // entry stays under the new page: Back from it shows the
                    // feed, and a second Back lands on the same feed URL and
                    // seems to do nothing (use-overlay-history.ts). A
                    // replacing navigation would remove it but give the page the
                    // feed's history index, which the Explorer's back arrow and
                    // the page transition read.
                    onClick={(event) => {
                      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) requestClose();
                    }}
                  >
                    {journal.name}
                  </Link>
                )}
                {meta?.cached && <InfoTag className="rd-tag" info={copy.cachedTitle}>{copy.cached}</InfoTag>}
              </div>
            )}
            <h1 ref={titleRef} tabIndex={-1} className="rd-doc-title" lang="en"><ScientificText>{paper?.title}</ScientificText></h1>
            {/* The rule under the byline closes the head even with no authors to
                list, as when a summary reopens from the history. */}
            <div className="rd-doc-byline">
              {paper && <PaperAuthors paper={paper} />}
            </div>

            {/* Pointed at by every paragraph's `aria-describedby` below,
                never read on its own: the keyboard route's instructions, for
                the one audience that cannot see a hint that only paints on
                focus. */}
            <p id={paragraphHintId} className="visually-hidden">{copy.annotateParagraphInstructions}</p>

            {shownStatus === 'error' ? (
              <EmptyState
                role="alert"
                className="rd-error-state"
                art={<Petri pose={errorPose} />}
                title={errorCopy.title}
                actions={(canRetry || originalUrl) && (
                  <>
                    {canRetry && (
                      <Button ref={retryRef} onClick={retry}>
                        <ArrowClockwise size={16} aria-hidden="true" />
                        {copy.retry}
                      </Button>
                    )}
                    {originalUrl && (
                      <Button variant="outline" render={<a href={originalUrl} target="_blank" rel="noopener noreferrer" />}>
                        {copy.original}
                        <ArrowSquareOut size={16} aria-hidden="true" />
                      </Button>
                    )}
                  </>
                )}
              >
                {errorCopy.body}
                {shownError && <code className="rd-error-code">{shownError}</code>}
              </EmptyState>
            ) : (
              <>
                {sections.map((section, sectionIndex) => (
                  <section
                    key={section.id || sectionIndex}
                    id={outlineTarget(sectionIndex)}
                    className="rd-section"
                    data-reveal={revealingSections.has(section) ? '' : undefined}
                  >
                    <div className="rd-section-head">
                      <span className="rd-section-kind">
                        {section.originalHeading?.trim() || kindLabels[section.kind as keyof typeof kindLabels] || kindLabels.other}
                      </span>
                    </div>
                    {section.heading && <h2 className="rd-section-title">{section.heading}</h2>}
                    {section.paragraphs.map((paragraph, paragraphIndex) => {
                      /* Built whether or not they are switched on. Dropping
                         them from the plan took the `<mark>` elements out of the
                         paragraph, which set the text a pixel over on every
                         switch and gave the colour nothing to fade out of; now
                         the switch is a colour, and the words never move. */
                      const aiHighlights = (section.highlights || [])
                        .filter(item => item.paragraphIndex === paragraphIndex)
                        .map(item => ({ ...item, source: 'ai', proposed: true }));
                      const stored = userHighlightIndex.get(`${section.id}:${paragraphIndex}`) || [];
                      return (
                        <p
                          key={paragraphIndex}
                          className="rd-p"
                          data-passage={`${section.id}:${paragraphIndex}`}
                          data-section={section.id}
                          data-paragraph={paragraphIndex}
                          data-annotatable={uid ? '' : undefined}
                          data-hint={uid ? copy.annotateParagraphBadge : undefined}
                          style={{ '--i': Math.min(paragraphIndex, MAX_STAGGER_STEPS) }}
                          // Keyboard route into the same menu the mouse opens on
                          // mouse-up (WCAG 2.1.1) -- see `handleParagraphKeyDown`.
                          tabIndex={uid ? 0 : undefined}
                          aria-describedby={uid ? paragraphHintId : undefined}
                          onKeyDown={uid ? (event) => handleParagraphKeyDown(event, section.id, paragraphIndex, paragraph) : undefined}
                        >
                          <HighlightedScientificText highlights={[...stored, ...aiHighlights]} pins={pinsByParagraph.get(`${section.id}:${paragraphIndex}`)}>
                            {paragraph}
                          </HighlightedScientificText>
                        </p>
                      );
                    })}
                  </section>
                ))}

                {/* The section being written, drawn before it exists. It lives at
                    the end of the document and every arriving section is inserted
                    in front of it, so what you watch is one ghost turning into
                    text while the next one grows underneath. */}
                <AnimatePresence>
                  {isStreaming && (
                  <motion.div
                    className="rd-ghost"
                    /* The last ghost has no section to turn into: the stream
                       simply ends. Without an exit of its own it blinked out one
                       frame after growing a fresh skeleton nobody would fill. */
                    exit={prefersReducedMotion
                      ? { opacity: 0, transition: { duration: 0.12 } }
                      : { opacity: 0, transform: 'translateY(-6px)', transition: { duration: 0.2, ease: EASE_OUT } }}
                  >
                    {sections.length === 0 ? (
                      <EmptyState
                        role="status"
                        aria-live="polite"
                        as="p"
                        art={<Petri pose="download" />}
                        title={<span key={stage} className="rd-ghost-stage">{stageLabel}</span>}
                      >
                        {copy.writingHint}
                      </EmptyState>
                    ) : (
                    <>
                    <p className="rd-ghost-head" role="status" aria-live="polite">
                      <ThinkingDots />
                      {/* Keyed by stage so the label is remounted, and its own
                          entrance animation replays, on every change of stage —
                          "downloading" does not jump into "reading". */}
                      <span key={stage} className="rd-ghost-stage">{stageLabel}</span>
                      <small>{`${sections.length} ${copy.sections}`}</small>
                    </p>
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={sections.length}
                        className="rd-ghost-body"
                        aria-hidden="true"
                        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, transform: 'translateY(-4px) scaleY(0.7)' }}
                        animate={{ opacity: 1, transform: 'translateY(0px) scaleY(1)' }}
                        exit={prefersReducedMotion
                          ? { opacity: 0, transition: { duration: 0.12 } }
                          : { opacity: 0, transform: 'translateY(-8px) scaleY(0.4)', transition: { duration: 0.18, ease: EASE_OUT } }}
                        transition={{ duration: prefersReducedMotion ? 0.12 : 0.26, ease: EASE_OUT_EXPO }}
                      >
                        <div className="rd-ghost-title" />
                        <div className="rd-ghost-lines">
                          {GHOST_LINES.map((width, index) => (
                            <i key={index} style={{ '--w': width, '--i': index }} />
                          ))}
                        </div>
                      </motion.div>
                    </AnimatePresence>
                    </>
                    )}
                  </motion.div>
                  )}
                </AnimatePresence>

                {canWriteAgain && (
                  <div className="rd-reused">
                    {writeAgainFailed
                      ? <p role="alert">{copy.writeAgainFailed(error?.code === WRITE_AGAIN_INCOMPLETE ? copy.writeAgainIncomplete : errorCopy.title)}</p>
                      : <p>{canSpendUse ? copy.reusedNote : copy.noUsesLeft}</p>}
                    <Button ref={writeAgainRef} variant="outline" size="sm" onClick={writeAgain} disabled={!writeAgainOpen} focusableWhenDisabled>
                      <ArrowClockwise size={14} aria-hidden="true" />
                      {copy.writeAgain}
                    </Button>
                  </div>
                )}

                {shownStatus === 'incomplete' && (
                  <p className="rd-notice" role="alert">
                    {copy.incomplete}
                    <Button size="sm" onClick={() => { void load(level, { force: true }); }}>
                      <ArrowClockwise size={14} aria-hidden="true" />
                      {copy.retry}
                    </Button>
                  </p>
                )}
              </>
            )}

          </article>

        </div>

        {outline.items.length > 0 && <OutlineRail {...outline} />}

        {/* As in the viewer: handles on the pending passage's ends move them a character at a
            time, and where they settle becomes the passage, through the selection's own path. */}
        {!touch && scrollElement && annotations.pending && (
          <PassageHandles
            key={`${annotations.pending.sectionId}:${annotations.pending.paragraphIndex}:${annotations.pending.quote}`}
            root={scrollElement}
            range={() => draggedRange ?? pendingRange(scrollElement)}
            onMove={setDraggedRange}
            onEnd={(range) => {
              setDraggedRange(null);
              if (range) annotateRange(range);
            }}
          />
        )}

        <NotesSidebar
          id="reader-notes"
          open={notesOpen}
          passages={orderedAnnotations}
          active={activeNote}
          withAi
          thinking={annotations.busy === 'asking' ? { at: answerAt ?? 0, label: copy.reading } : null}
          onGoTo={(passage) => {
            if (scrollElement && getComputedStyle(scrollElement).visibility === 'hidden') setNotesOpen(false);
            setPicked(passage.id);
            goToPassage(passage);
          }}
          onRemove={(id) => { void annotations.remove(id); }}
          onClose={() => setNotesOpen(false)}
        />

        {waitsForTouch && touchRange && (
          <Button className="vn-touch-highlight" onClick={highlightTouchSelection}>
            <Highlighter size={18} aria-hidden="true" />
            {copy.highlight}
          </Button>
        )}

        <ReadingDock
          title={`${paper.title ?? 'Paper'} — AI summary`} paper={card?.paper}
          scroll={scrollElement} spoken={null} canListen={false}
          notes={{ id: 'reader-notes', open: notesOpen, count: orderedAnnotations.length, onOpenChange: setNotesOpen }}
          originalUrl={originalUrl}
          menu={card ? { paper: card.paper, doc: null, fromCard: card.menu, onLeave: then => {
            if (embedded && onLeave) { onLeave(then); return; }
            afterClose.current = then;
            requestClose();
          } } : undefined}
          contents={outline.items.length > 0 ? close => <OutlineList {...outline} onPick={close} /> : null}
        >
          <Select
            items={PAPER_REWRITE_LEVELS.map(option => ({ value: option.id, label: option.label }))}
            value={level}
            onValueChange={(next) => { if (next) setLevel(next); }}
          >
            <SelectTrigger size="sm" className="rd-dock-level" aria-label={`${copy.level}: ${PAPER_REWRITE_LEVELS.find(option => option.id === level)?.label ?? level}`} title={copy.level}>
              {(() => {
                const LevelIcon = LEVEL_ICONS[level];
                return LevelIcon && <LevelIcon size={18} aria-hidden="true" />;
              })()}
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top" align="center" alignItemWithTrigger={false}>
              {PAPER_REWRITE_LEVELS.map(option => {
                const LevelIcon = LEVEL_ICONS[option.id as keyof typeof LEVEL_ICONS];
                return (
                  <SelectItem key={option.id} value={option.id} disabled={isStreaming && level !== option.id}>
                    <LevelIcon size={15} aria-hidden="true" />
                    {option.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Toggle
            className="pdf-dock-toggle"
            pressed={showAiMarks}
            onPressedChange={setShowAiMarks}
            aria-label={copy.aiMarks}
            title={copy.toggleAiMarks}
          >
            <Highlighter size={18} aria-hidden="true" />
            <span className="pdf-dock-label">{copy.aiMarks}</span>
          </Toggle>
        </ReadingDock>
        </div>

        {/* Over the selection, as in the paper viewer: highlight it, with a note
            and a colour if wanted, or have the AI explain it. */}
        {annotations.pending?.anchor && (
          <PassageEditor
            key={`${annotations.pending.sectionId}:${annotations.pending.paragraphIndex}:${annotations.pending.quote}`}
            quote={passageQuote(annotations.pending)}
            anchor={annotations.pending.anchor}
            busy={annotations.busy === 'saving'}
            error={failedNote !== null}
            initialNote={failedNote ?? ''}
            returnFocus={annotationOrigin}
            sheet={touch}
            ask={{
              price: quota?.unlimited ? null
                : quota?.dailyLimit ? <UsesCount left={quota.remainingUses} limit={quota.dailyLimit} />
                  : canSpendUse ? copy.oneUse : copy.noUsesLeftShort,
              disabled: !canSpendUse,
              title: canSpendUse ? undefined : copy.noUsesLeft,
              onAsk: (question) => { void askAboutPassage(question); },
            }}
            onSave={(note, color) => { void saveAnnotation(note, color); }}
            onCancel={() => { setFailedNote(null); annotations.dismiss(); }}
          />
        )}
  </>);
}
