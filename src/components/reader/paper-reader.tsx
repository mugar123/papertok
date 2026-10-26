import type { KeyboardEvent, ReactNode, Ref } from 'react';
import type { Paper } from '../../models/paper.ts';
import type { AIUses, RewriteSection, ClientRewriteMeta } from '../../services/paper-rewrite-service.ts';
import type { PassageAnnotation } from '../../hooks/use-passage-annotations.ts';
import type { ReadingLevel } from '../../utils/user-settings.ts';
interface PaperReaderProps {
  paper: Partial<Paper>; onClose: () => void;
  originRect?: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'> | null;
  closeRef?: Ref<() => void> | null;
  /** The level to open at instead of the reader's default (the summary history opens the one it lists). */
  initialLevel?: ReadingLevel;
}
export type ReaderCopy = typeof COPY.en;
import { useCallback, useEffect, useEffectEvent, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowSquareOut,
  Flask,
  GraduationCap,
  Highlighter,
  PencilLine,
  Plant,
  Sparkle,
} from '@phosphor-icons/react';
import {
  canRewritePaper,
  fetchRemainingAIUses,
  getCachedRewrite,
  lastKnownAIUses,
  PAPER_REWRITE_LEVELS,
  PaperRewriteError,
  rewriteCacheKey,
  rememberAIUses,
  rewritePaper,
} from '../../services/paper-rewrite-service.ts';
import { indexHighlightsByParagraph, passageSegments } from '../../services/user-highlight-service.ts';
import ScientificText from '../scientific-text.ts';
import { usePassageAnnotations } from '../../hooks/use-passage-annotations.ts';
import {
  answerSlot,
  buildSectionOrder,
  countAnnotations,
  filterAnnotations,
  sortAnnotations,
} from '../../utils/annotation-order.ts';
import { normalizeLatexText, proseSourceOffset } from '../../utils/latex.ts';
import { buildRangeAnchor, buildSelectionAnchor } from '../../utils/text-highlights.ts';
import { useAuth } from '../../context/auth-context.tsx';
import { useAnalyticsConsent } from '../../context/analytics-context.tsx';
import { safeDoiUrl, safeExternalUrl } from '../../utils/external-url.ts';
import { journalExplorerLink } from '../../utils/explorer-paths.ts';
import { Link } from 'react-router-dom';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import Petri from '../onboarding/petri.tsx';
import { Dialog, DialogContent } from '../ui/dialog.tsx';
import { Toggle } from '../ui/toggle.tsx';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.tsx';
import AnnotationRail from './annotation-rail.tsx';
import { ListRowAuthors } from '../lists/list-row.tsx';
import HighlightedScientificText from './highlighted-scientific-text.tsx';
import SelectionMenu from './selection-menu.tsx';
import UsesCount from './uses-count.tsx';
import ThinkingDots from './thinking-dots.tsx';
import './paper-reader.css';
import './annotations.css';
import { EASE_OUT, EASE_OUT_EXPO } from '../../utils/motion-curves.ts';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

const LEVEL_ICONS = { beginner: Plant, university: GraduationCap, researcher: Flask } as const;

const COPY = {
  en: {
    title: 'Read in plain words',
    close: 'Close reader',
    back: 'Back',
    level: 'Level',
    writing: 'Rewriting the paper',
    writingHint: 'Sections appear as they are written.',
    cached: 'Saved version',
    cachedTitle: 'A rewrite made earlier, reused: no AI use was spent.',
    adaptationTag: 'AI adaptation',
    original: 'View the original paper',
    adaptation: 'AI adaptation generated from the full text. It does not replace the original article.',
    stages: {
      saved: 'Looking for your saved summary',
      source: 'Downloading the paper',
      reading: 'The model is reading the paper',
      writing: 'Rewriting the paper',
    },
    retry: 'Try again',
    incomplete: 'The rewrite stopped before finishing. You can try again.',
    reusedNote: 'Written earlier and reused, so it spent no AI use. Writing it again spends one.',
    writeAgain: 'Write it again',
    writeAgainFailed: (reason: string) => `${reason}. The summary above was not replaced.`,
    writeAgainIncomplete: 'The new rewrite stopped before finishing',
    sections: 'sections',
    annotations: 'Annotations',
    toggleAnnotations: 'Show annotations',
    toggleAiMarks: 'Show AI highlights',
    settings: 'Settings',
    selectionTitle: 'What to do with the selection',
    annotateParagraphInstructions: 'Press Enter to open annotation options for this paragraph: highlight it, write a note on it, or ask the AI to explain it.',
    annotateParagraphBadge: 'Enter: annotate',
    justHighlight: 'Highlight',
    writeNote: 'Write a note',
    explainThis: 'Explain this to me',
    yourNote: 'Your note',
    notePlaceholder: 'Whatever you want to remember about this passage…',
    save: 'Save',
    cancel: 'Cancel',
    oneUse: '1 use',
    noUsesLeftShort: 'no uses',
    noUsesLeft: 'Today’s AI uses have run out.',
    usesLeftLine: (left: number, total?: number | null) => (total
      ? `${left} of ${total} AI uses left today.`
      : `${left} AI ${left === 1 ? 'use' : 'uses'} left today.`),
    reading: 'Reading the passage',
    originMine: 'Yours',
    originAi: 'AI',
    goToPassage: 'Go to the passage',
    removeAnnotation: 'Remove annotation',
    noteActions: 'Note actions',
    noteLabel: (number: number) => `Note ${number}`,
    copyNote: 'Copy as Markdown',
    noteCopied: 'Copied as Markdown',
    noteCopyFailed: 'Could not copy the note',
    emptyAllTitle: 'No notes yet',
    emptyAll: 'Select a sentence in the text to write a note on it, or to have the AI explain it.',
    filters: { all: 'All', mine: 'Yours', ai: 'AI' },
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
      body: 'Rewriting papers with AI is a feature for signed-in accounts.',
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
      title: 'Rewriting is not available',
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
      title: 'This paper cannot be put in plain words',
      body: 'The PDF does not carry enough text to rewrite. Usually a scan, or a one-page article.',
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
 * The reader's own entrance and exit — growing out of the button that opened
 * it, collapsing back into it, the floating chrome a beat behind — are CSS
 * now, on the `[data-open]` / `[data-closed]` attributes the Base UI Dialog
 * sets (see `.rd[data-open]` in paper-reader.css). The origin still comes from
 * the card: it travels as the `--rd-origin` variable set on the shell below.
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

export default function PaperReader({ paper, onClose, originRect = null, closeRef = null, initialLevel }: PaperReaderProps) {
  const { user, readingPreferences } = useAuth();
  const uid = user?.uid;
  const { trackEvent } = useAnalyticsConsent();
  const prefersReducedMotion = useReducedMotion();
  const copy = COPY.en;
  const kindLabels = KIND_LABELS.en;
  // One shared id: every paragraph's `aria-describedby` on the keyboard
  // route points at the same hidden sentence rather than each rendering its
  // own copy of it.
  const paragraphHintId = useId();

  const [level, setLevel] = useState(() => initialLevel ?? readingPreferences?.aiExplanationLevel ?? 'university');
  const [sections, setSections] = useState<Array<RewriteSection & { reveal?: boolean }>>([]);
  const [meta, setMeta] = useState<ClientRewriteMeta | null>(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState<Pick<PaperRewriteError, 'code' | 'quota'> | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [showAiMarks, setShowAiMarks] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [annotationFilter, setAnnotationFilter] = useState('all');
  /**
   * Under this width the paper wants the whole page, so the margin becomes a
   * sheet. Tracked in state rather than left to CSS because the two surfaces do
   * not have the same open/closed idea: a rail is shown or hidden, a sheet
   * peeks or is pulled up.
   */
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches,
  );
  /**
   * The day's AI allowance, read without spending any of it. `meta.remainingUses`
   * only exists once a rewrite is under way — after it has already cost a use,
   * and never on a cache hit or a failure — so the reader asks for the number
   * itself and then keeps it up to date from whatever the stream reports.
   */
  const [seededQuota] = useState(() => lastKnownAIUses(uid));
  const [quota, setQuota] = useState<AIUses | null>(seededQuota);
  const [stage, setStage] = useState('source');
  const abortRef = useRef<AbortController | null>(null);
  // The reader's own scroll container, so a touch selection outside it (e.g.
  // in a dialog rendered elsewhere in the tree) is never mistaken for one of
  // its paragraphs.
  const scrollRef = useRef<HTMLDivElement | null>(null);
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
  const [open, setOpen] = useState(true);
  const requestClose = useCallback(() => setOpen(false), []);
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
  // The way to a journal's Follow (ENG-123): its name opens its Explorer page.
  const journal = journalExplorerLink(paper);

  const load = useCallback(async (targetLevel: string, {
    force = false,
    // The summary on screen when the reader asked to write it again. It is
    // still the saved one until a complete new rewrite replaces it, so a
    // request that fails or stops before the end puts it back instead of an
    // error page or a partial paper.
    rewriteOf = null as { sections: RewriteSection[]; meta: ClientRewriteMeta } | null,
  } = {}) => {
    const regenerate = Boolean(rewriteOf);
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
          void trackEvent('paper_rewrite', { level: targetLevel, surface: 'reader', paper_id: paper.id, paper_title: paper.title });
        },
        onMeta: (nextMeta) => {
          replayed = nextMeta.cached === true;
          setMeta(nextMeta);
          // The reservation has already happened by the time this arrives, so it
          // is the freshest count there is — fresher than what the reader asked
          // for when it opened.
          if (typeof nextMeta.remainingUses === 'number') {
            setQuota(current => ({ dailyLimit: current?.dailyLimit ?? null, remainingUses: nextMeta.remainingUses! }));
          }
        },
        // `reveal` is what separates a section that was just written from one
        // that was already there. Only the fresh one gets the wipe; a cached
        // rewrite arrives all at once and must not stage a whole paper's worth
        // of animation nobody asked to watch.
        onSection: (section) => setSections(current => [...current, { ...section, reveal: !replayed }]),
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
      if (requested) void fetchRemainingAIUses({ signal: controller.signal }).then(fresh => { if (fresh) setQuota(fresh); });
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

  // Time with the reader on screen, sent when it closes. A hidden tab's time
  // is left out: a reader forgotten in a background tab was not being read.
  // Keyed on the paper's identity: a new object for the same paper is not a
  // second reading.
  const paperTitle = paper.title;
  const reportReaderTime = useEffectEvent((seconds: number, id: string, title: string | undefined) => {
    void trackEvent('reader_time', { level, seconds, paper_id: id, paper_title: title });
  });
  useEffect(() => {
    let visibleSince: number | null = document.hidden ? null : Date.now();
    let seconds = 0;
    const pause = () => {
      if (visibleSince !== null) seconds += (Date.now() - visibleSince) / 1000;
      visibleSince = null;
    };
    const onVisibility = () => {
      if (document.hidden) pause();
      else visibleSince ??= Date.now();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      pause();
      reportReaderTime(seconds, paperId, paperTitle);
    };
  }, [paperId, paperTitle]);

  useEffect(() => {
    if (!coversFeed) return undefined;
    document.body.setAttribute('data-reader-open', '');
    return () => document.body.removeAttribute('data-reader-open');
  }, [coversFeed]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 1100px)');
    const sync = (event: MediaQueryListEvent) => setIsNarrow(event.matches);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  /**
   * Takes the reveal flag back off once the wipe has finished. The mask that
   * draws it stays on the paragraph for as long as the flag does, and a mask is
   * a rasterised layer: leaving one on every paragraph of a long rewrite costs
   * memory and softens the type on some GPUs for an effect that is over.
   */
  useEffect(() => {
    if (!sections.some(section => section.reveal)) return undefined;
    const timerId = setTimeout(() => {
      setSections(current => (current.some(section => section.reveal)
        ? current.map(section => (section.reveal ? { ...section, reveal: false } : section))
        : current));
    }, REVEAL_SETTLE_MS);
    return () => clearTimeout(timerId);
  }, [sections]);

  useEffect(() => {
    if (!uid) return undefined;
    const controller = new AbortController();
    void fetchRemainingAIUses({ signal: controller.signal }).then(fresh => {
      // Only over the seed: a rewrite that started while this was in flight
      // already reported a newer number on its `meta` line.
      if (fresh) setQuota(current => (current === null || current === seededQuota ? fresh : current));
    });
    return () => controller.abort();
  }, [seededQuota, uid]);

  useEffect(() => {
    if (uid && quota) rememberAIUses(uid, quota);
  }, [quota, uid]);

  const noteQuota = useCallback((remainingUses: number) => {
    setQuota(current => ({ dailyLimit: current?.dailyLimit ?? null, remainingUses }));
  }, []);

  const annotating = useMemo(() => {
    try { return !window.matchMedia('(pointer: coarse)').matches; } catch { return true; }
  }, []);

  const annotations = usePassageAnnotations({
    uid: annotating ? uid : null,
    paper,
    paperId,
    level,
    language: 'en',
    onQuota: noteQuota,
    trackEvent,
  });

  const { begin: beginAnnotation } = annotations;

  const railIsSheet = isNarrow;

  useEffect(() => {
    if (!railIsSheet || !sheetOpen) return undefined;
    const closeOnPaper = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest('.rd-scroll') || target.closest('.rd-rail, .rd-pin')) return;
      if (window.getSelection()?.isCollapsed === false) return;
      setSheetOpen(false);
    };
    document.addEventListener('click', closeOnPaper);
    return () => document.removeEventListener('click', closeOnPaper);
  }, [railIsSheet, sheetOpen]);

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
   * already see. Notes, highlights and explanations are for a mouse or
   * trackpad only; touch screens read the paper without them.
   */
  const handleSelection = useCallback((
    sectionId: string,
    paragraphIndex: number,
    paragraphText: string,
    paragraphNode: HTMLElement,
    end?: { paragraphIndex: number; text: string; node: HTMLElement; between: string[] },
  ) => {
    if (!uid) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    // Offsets first, the selected string only as a fallback: the string is
    // wrong wherever the selection touched a formula, but it is still the right
    // answer for anything the offset walk could not map.
    const anchor = anchorFromSelection(range, paragraphNode, paragraphText)
      || buildSelectionAnchor(selection.toString());
    if (!anchor) return;
    const endAnchor = end ? anchorFromSelection(range, end.node, end.text) : null;
    const spans = end && endAnchor ? { end, endAnchor } : null;
    const rect = range.getBoundingClientRect();
    selection.removeAllRanges();
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
  useEffect(() => {
    if (!annotating) return undefined;
    const paragraphAround = (node: Node | null) => {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement;
      return element?.closest<HTMLElement>('.rd-p[data-section]') || null;
    };
    const handleDocumentMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const start = range.startContainer;
      const paragraph = paragraphAround(start) || paragraphAround(range.endContainer);
      if (!paragraph || !scrollRef.current?.contains(paragraph)) return;
      const sectionId = paragraph.dataset.section!;
      const paragraphIndex = Number(paragraph.dataset.paragraph);
      const text = paragraphTextFor(sectionId, paragraphIndex);
      if (text === null) return;
      // A selection that runs into later paragraphs of the same section is one
      // passage; one that crosses into another section stops where it started.
      const last = paragraphAround(range.endContainer);
      const lastIndex = Number(last?.dataset.paragraph);
      const lastText = last && last.dataset.section === sectionId && lastIndex > paragraphIndex
        ? paragraphTextFor(sectionId, lastIndex)
        : null;
      const between = [];
      for (let index = paragraphIndex + 1; index < lastIndex; index += 1) between.push(paragraphTextFor(sectionId, index) ?? '');
      handleSelection(sectionId, paragraphIndex, text, paragraph, last && lastText !== null
        ? { paragraphIndex: lastIndex, text: lastText, node: last, between }
        : undefined);
    };
    document.addEventListener('mouseup', handleDocumentMouseUp);
    return () => document.removeEventListener('mouseup', handleDocumentMouseUp);
  }, [annotating, handleSelection, paragraphTextFor]);

  const sectionOrder = useMemo(() => buildSectionOrder(sections), [sections]);
  const orderedAnnotations = useMemo(
    () => sortAnnotations(annotations.annotations, sectionOrder),
    [annotations.annotations, sectionOrder],
  );
  const visibleAnnotations = useMemo(
    () => filterAnnotations(orderedAnnotations, annotationFilter),
    [annotationFilter, orderedAnnotations],
  );
  const annotationCounts = useMemo(
    () => countAnnotations(orderedAnnotations),
    [orderedAnnotations],
  );
  // The place in the margin where the answer being written will be filed.
  const answerAt = useMemo(
    () => answerSlot(visibleAnnotations, annotations.askedAt, sectionOrder),
    [annotations.askedAt, sectionOrder, visibleAnnotations],
  );

  /**
   * Asking for an explanation is asking to read one, and the answer only ever
   * appears in the margin — so the margin comes out if it was put away (or
   * the sheet up, below 1100px), and a filter showing only your own notes
   * steps back to all of them. Left alone, each of those hid the answer the
   * reader had just spent a use on.
   */
  const { ask: askAnnotation } = annotations;
  const askAboutPassage = useCallback(() => {
    setAnnotationFilter(current => (current === 'mine' ? 'all' : current));
    if (railIsSheet) setSheetOpen(true);
    else setRailOpen(true);
    return askAnnotation();
  }, [askAnnotation, railIsSheet]);

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
  const pendingNoteNumber = useMemo(() => {
    const pending = annotations.pending;
    if (!pending) return undefined;
    return 1 + orderedAnnotations.filter(item => item.note && sortAnnotations([item, pending], sectionOrder)[0] === item).length;
  }, [annotations.pending, orderedAnnotations, sectionOrder]);
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

  /* The reader grows from wherever it was opened. `.rd` is `inset: 0`, so its
     own box is the viewport and the button's viewport coordinates are already
     the right origin — no measuring, no offset parent to correct for. Handed
     to the stylesheet as `--rd-origin`, which the arrival and the leave
     keyframes read as their `transform-origin`. */
  const transformOrigin = originRect
    ? `${originRect.left + originRect.width / 2}px ${originRect.top + originRect.height / 2}px`
    : '50% 62%';

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

  return (
    /* A full-screen Base UI Dialog: modal (FeedContainer's scroll guard reads
       the `aria-modal` it sets), with pointer dismissal off because a surface
       that covers the viewport has no outside to press — and the selection
       menu is a portaled popover that must not read as one.
       The centred-sheet look of DialogContent is undone in `.rd` itself
       (paper-reader.css), which is also everything else the shell looks like. */
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) requestClose(); }}
      onOpenChangeComplete={(next) => { if (!next) onClose(); }}
      modal
      disablePointerDismissal
    >
      <DialogContent
        className="rd inset-0 max-w-none translate-x-0 translate-y-0 rounded-none border-0 shadow-none"
        overlayClassName="rd-scrim"
        showClose={false}
        initialFocus={closeButtonRef}
        aria-label={copy.title}
        style={{ '--rd-origin': transformOrigin }}
      >
          <header className="rd-topbar">
            <Button
              ref={closeButtonRef}
              variant="ghost"
              size="icon"
              onClick={requestClose}
              aria-label={copy.close}
              title={copy.back}
            >
              <ArrowLeft size={18} />
            </Button>
            <div className="rd-panel rd-topbar-controls" role="group" aria-label={copy.title}>
              <Select
                items={PAPER_REWRITE_LEVELS.map(option => ({ value: option.id, label: option.label }))}
                value={level}
                onValueChange={(next) => { if (next) setLevel(next); }}
              >
                <SelectTrigger size="sm" className="rd-level-select" aria-label={copy.level}>
                  {(() => {
                    const LevelIcon = LEVEL_ICONS[level];
                    return LevelIcon && <LevelIcon size={15} aria-hidden="true" />;
                  })()}
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end" alignItemWithTrigger={false}>
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
              {annotating && (
              <>
              <div className="rd-panel-group">
                <span className="rd-panel-label">{copy.annotations}</span>
                <Toggle
                  variant="brand"
                  size="icon"
                  className="rd-topbar-switch"
                  pressed={isNarrow ? sheetOpen : railOpen}
                  onPressedChange={() => (isNarrow ? setSheetOpen(v => !v) : setRailOpen(v => !v))}
                  title={copy.toggleAnnotations}
                  aria-label={copy.toggleAnnotations}
                >
                  <PencilLine size={15} />
                </Toggle>
              </div>
              <div className="rd-panel-group">
                <Toggle
                  variant="brand"
                  size="icon"
                  className="rd-topbar-switch"
                  pressed={showAiMarks}
                  onPressedChange={setShowAiMarks}
                  title={copy.toggleAiMarks}
                  aria-label={copy.toggleAiMarks}
                >
                  <Highlighter size={15} />
                </Toggle>
              </div>
              </>
              )}
              {annotating && originalUrl && <div className="rd-panel-divider" />}
              {originalUrl && (
                <div className="rd-panel-group">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    render={<a href={originalUrl} target="_blank" rel="noopener noreferrer" />}
                    aria-label={copy.original}
                    title={copy.original}
                  >
                    <ArrowSquareOut size={15} />
                  </Button>
                </div>
              )}
            </div>
          </header>

        <div
          ref={scrollRef}
          className="rd-scroll"
          onScroll={() => annotations.dismiss()}
        >
          <article className="rd-doc" data-ai-marks={showAiMarks ? undefined : 'hidden'}>
            {/* The one title in the app that used to be printed raw: every other
                surface sends it through the same renderer, so a paper called
                "the $\mu$-Deformed Model" arrived here still wearing its dollars. */}
            {(usesQuota || sections.length > 0 || paper?.year || journal) && (
              <div className="rd-doc-tags">
                {usesQuota && (
                  <span className="rd-tag rd-tag--ai rd-uses">
                    <Sparkle size={12} aria-hidden="true" />
                    <UsesCount left={usesQuota.left} limit={usesQuota.limit} copy={copy} />
                  </span>
                )}
                {sections.length > 0 && (
                  <InfoTag className="rd-tag rd-tag--ai" info={[copy.adaptation, meta?.model].filter(Boolean).join(' · ')}>
                    <Sparkle size={12} aria-hidden="true" />
                    {copy.adaptationTag}
                  </InfoTag>
                )}
                {paper?.year && <span className="rd-tag">{paper.year}</span>}
                {journal && (
                  <Link
                    to={journal.path}
                    className="rd-tag rd-tag--link"
                    // The reader leaves for the page, which may be the one
                    // under it when it opened from that journal's Explorer page.
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
              {(paper?.authors?.length ?? 0) > 0 && <ListRowAuthors paper={paper} />}
            </div>

            {/* Pointed at by every paragraph's `aria-describedby` below,
                never read on its own: the keyboard route's instructions, for
                the one audience that cannot see a hint that only paints on
                focus. */}
            {annotating && <p id={paragraphHintId} className="visually-hidden">{copy.annotateParagraphInstructions}</p>}

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
                    className="rd-section"
                    data-reveal={section.reveal ? '' : undefined}
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
                      const aiHighlights = (annotating ? section.highlights || [] : [])
                        .filter(item => item.paragraphIndex === paragraphIndex)
                        .map(item => ({ ...item, source: 'ai', proposed: true }));
                      const stored = userHighlightIndex.get(`${section.id}:${paragraphIndex}`) || [];
                      return (
                        <p
                          key={paragraphIndex}
                          className="rd-p"
                          data-section={section.id}
                          data-paragraph={paragraphIndex}
                          data-annotatable={annotating ? '' : undefined}
                          data-hint={annotating ? copy.annotateParagraphBadge : undefined}
                          style={{ '--i': Math.min(paragraphIndex, MAX_STAGGER_STEPS) }}
                          // Keyboard route into the same menu the mouse opens on
                          // mouse-up (WCAG 2.1.1) -- see `handleParagraphKeyDown`.
                          tabIndex={annotating ? 0 : undefined}
                          aria-describedby={annotating ? paragraphHintId : undefined}
                          onKeyDown={annotating ? (event) => handleParagraphKeyDown(event, section.id, paragraphIndex, paragraph) : undefined}
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

          {annotating && (
          <AnnotationRail
            surface={railIsSheet ? 'sheet' : 'rail'}
            hidden={railIsSheet ? !sheetOpen : !railOpen}
            expanded={sheetOpen}
            onToggle={() => setSheetOpen(value => !value)}
            annotations={visibleAnnotations}
            pins={notePins}
            answerAt={answerAt}
            counts={annotationCounts}
            filter={annotationFilter}
            onFilter={setAnnotationFilter}
            thinking={annotations.busy === 'asking'}
            onFocus={goToPassage}
            onRemove={(id) => { void annotations.remove(id); }}
            labelFor={annotationLabel}
            copy={copy}
          />
          )}
        </div>

        {/* Over the selection, not in a corner: what it acts on is the passage
            under it, and a menu that drifts away from its subject stops being
            about it. A popover anchored to the selection's rectangle; it stays
            mounted and follows `pending` with `open`, so its leave can play
            over the passage it was about. */}
        {annotating && (
        <SelectionMenu
            open={Boolean(annotations.pending)}
            anchor={annotations.pending?.anchor}
            copy={copy}
            noteNumber={pendingNoteNumber}
            notePlace={annotations.pending ? annotationLabel(annotations.pending) : undefined}
            usesLeft={quota?.unlimited ? null : quota?.remainingUses ?? null}
            usesLimit={quota?.dailyLimit ?? null}
            unlimited={Boolean(quota?.unlimited)}
            canAsk={canSpendUse}
            busy={annotations.busy === 'saving'}
            onHighlight={() => { void annotations.highlight(); }}
            onSaveNote={(note) => { void annotations.saveNote(note); }}
            onAsk={() => { void askAboutPassage(); }}
            onClose={annotations.dismiss}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
