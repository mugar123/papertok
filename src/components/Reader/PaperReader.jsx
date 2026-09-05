import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertCircle,
  ArrowLeft,
  ExternalLink,
  Download,
  PenLine,
  Sparkles,
} from 'lucide-react';
import {
  canRewritePaper,
  fetchRemainingAIUses,
  getCachedRewrite,
  PAPER_REWRITE_LEVELS,
  PaperRewriteError,
  rewriteCacheKey,
  rewritePaper,
} from '../../services/paperRewriteService.js';
import { indexHighlightsByParagraph } from '../../services/userHighlightService.js';
import ScientificText from '../ScientificText.js';
import { usePassageAnnotations } from '../../hooks/usePassageAnnotations.js';
import {
  buildSectionOrder,
  countAnnotations,
  filterAnnotations,
  sortAnnotations,
} from '../../utils/annotationOrder.js';
import {
  PANEL_HIDE_DELAY_MS,
  panelShouldShow,
  pointerWakesPanel,
} from '../../utils/panelReveal.js';
import { normalizeLatexText, proseSourceOffset } from '../../utils/latex.js';
import { buildRangeAnchor, buildSelectionAnchor } from '../../utils/textHighlights.js';
import {
  buildLatexDocument,
  exportableAnnotations,
  exportFileName,
  summarizeExport,
} from '../../utils/latexExport.js';
import { buildPdfModel, downloadPdfDocument } from '../../utils/pdfExport.js';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import { pickSelectionRoute } from '../../utils/readerSelection.js';
import { nextBarVisibility } from '../../utils/scrollDirection.js';
import { safeDoiUrl, safeExternalUrl } from '../../utils/externalUrl.js';
import { Button } from '../ui/button.jsx';
import { Dialog, DialogContent } from '../ui/dialog.jsx';
import { Popover, PopoverTrigger } from '../ui/popover.jsx';
import { Toggle } from '../ui/toggle.jsx';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.jsx';
import AnnotationRail from './AnnotationRail.jsx';
import ExportCard from './ExportCard.jsx';
import HighlightedScientificText from './HighlightedScientificText.jsx';
import ReaderBar from './ReaderBar.jsx';
import SelectionMenu from './SelectionMenu.jsx';
import ThinkingDots from './ThinkingDots.jsx';
import './PaperReader.css';
import './Annotations.css';
import './Export.css';
import './ReaderBar.css';

const COPY = {
  es: {
    title: 'Leer en simple',
    close: 'Cerrar lector',
    back: 'Volver',
    level: 'Nivel',
    writing: 'Reescribiendo el paper',
    writingHint: 'Las secciones aparecen a medida que se escriben.',
    cached: 'Versión guardada',
    original: 'Ver el paper original',
    adaptation: 'Adaptación generada por IA a partir del texto completo. No sustituye al artículo original.',
    remaining: (count) => `${count} ${count === 1 ? 'uso' : 'usos'} hoy`,
    uses: (left, total) => `${left}/${total} hoy`,
    usesTitle: (left, total) => (left === 0
      ? `Has gastado los ${total} usos de IA de hoy. Vuelven mañana.`
      : `Te ${left === 1 ? 'queda' : 'quedan'} ${left} de ${total} usos de IA hoy.`),
    stages: {
      source: 'Descargando el paper',
      reading: 'El modelo está leyendo el paper',
      writing: 'Reescribiendo el paper',
    },
    retry: 'Reintentar',
    incomplete: 'La reescritura se cortó antes de terminar. Puedes reintentarlo.',
    sections: 'secciones',
    errorKicker: 'No se pudo reescribir',
    download: 'Descargar',
    whatGoes: 'Qué se lleva',
    exportOptions: {
      marks: 'Tus subrayados',
      mine: 'Tus notas',
      ai: 'Anotaciones de la IA',
    },
    optionCount: (id, count) => (id === 'marks'
      ? `${count} ${count === 1 ? 'pasaje' : 'pasajes'}`
      : `${count} ${count === 1 ? 'nota' : 'notas'} · numerada${count === 1 ? '' : 's'} al pie`),
    noneOfThese: 'ninguna todavía',
    alwaysIncluded: 'Siempre se incluyen el título, los autores, el enlace al original y la nota de que el texto lo escribió una IA. El fichero puede acabar lejos de aquí.',
    previewTitle: 'Título del paper',
    previewByline: 'autores · reescrito por PaperTok',
    previewSection: 'De qué va el paper',
    previewNote: (format) => (format === 'pdf' ? 'Así se verá el PDF' : 'Así se verá al compilarlo'),
    format: 'Formato',
    downloadTex: 'Descargar .tex',
    downloadPdf: 'Descargar PDF',
    generating: 'Generando…',
    downloaded: 'Descargado',
    unlimitedUses: 'IA sin límite',
    unlimitedUsesTitle: 'Esta cuenta no tiene límite diario de usos de IA.',
    annotations: 'Anotaciones',
    toggleAnnotations: 'Ver anotaciones',
    settings: 'Ajustes',
    selectionTitle: 'Qué hacer con la selección',
    // Read by `aria-describedby` on every paragraph on the desktop route
    // (`paragraphHintId`), not shown: the keyboard route's own instructions,
    // for the audience that cannot see a hint that only paints on focus.
    annotateParagraphInstructions: 'Pulsa Intro para abrir las opciones de anotación de este párrafo: subrayarlo, escribirle una nota o pedirle a la IA que lo explique.',
    // The same instructions, compressed to what fits in a small tag that
    // paints over the paragraph's own corner on keyboard focus (CSS
    // `content: attr(data-hint)` in PaperReader.css) -- for the reader who
    // can see the screen but has no mouse and no screen reader to read the
    // sentence above out loud.
    annotateParagraphBadge: 'Intro: anotar',
    justHighlight: 'Subrayar',
    writeNote: 'Escribir nota',
    explainThis: 'Que me lo explique',
    yourNote: 'Tu nota',
    notePlaceholder: 'Lo que quieras recordar de este pasaje…',
    save: 'Guardar',
    cancel: 'Cancelar',
    oneUse: '1 uso',
    noUsesLeftShort: 'sin usos',
    noUsesLeft: 'Se han acabado los usos de IA de hoy.',
    usesLeftLine: (left) => `Te ${left === 1 ? 'queda' : 'quedan'} ${left} ${left === 1 ? 'uso' : 'usos'} de IA hoy.`,
    reading: 'Leyendo el pasaje',
    originMine: 'Tuya',
    originAi: 'IA',
    goToPassage: 'Ir al pasaje',
    removeAnnotation: 'Quitar anotación',
    emptyAll: 'Selecciona una frase del texto para escribir una nota, o para pedirle a la IA que te la explique.',
    emptyFiltered: 'Aquí no hay nada todavía.',
    countLine: ({ notes, marks }) => {
      const parts = [];
      if (marks) parts.push(`${marks} ${marks === 1 ? 'marca' : 'marcas'}`);
      if (notes) parts.push(`${notes} ${notes === 1 ? 'nota' : 'notas'}`);
      return parts.join(' · ');
    },
    filters: { all: 'Todas', mine: 'Tuyas', ai: 'IA' },
  },
  en: {
    title: 'Read in plain words',
    close: 'Close reader',
    back: 'Back',
    level: 'Level',
    writing: 'Rewriting the paper',
    writingHint: 'Sections appear as they are written.',
    cached: 'Saved version',
    original: 'View the original paper',
    adaptation: 'AI adaptation generated from the full text. It does not replace the original article.',
    remaining: (count) => `${count} ${count === 1 ? 'use' : 'uses'} today`,
    uses: (left, total) => `${left}/${total} today`,
    usesTitle: (left, total) => (left === 0
      ? `You have used all ${total} of today's AI uses. They return tomorrow.`
      : `${left} of ${total} AI uses left today.`),
    stages: {
      source: 'Downloading the paper',
      reading: 'The model is reading the paper',
      writing: 'Rewriting the paper',
    },
    retry: 'Try again',
    incomplete: 'The rewrite stopped before finishing. You can try again.',
    sections: 'sections',
    errorKicker: 'Could not rewrite',
    download: 'Download',
    whatGoes: 'What goes with it',
    exportOptions: {
      marks: 'Your highlights',
      mine: 'Your notes',
      ai: 'AI annotations',
    },
    optionCount: (id, count) => (id === 'marks'
      ? `${count} ${count === 1 ? 'passage' : 'passages'}`
      : `${count} ${count === 1 ? 'note' : 'notes'} · numbered at the foot`),
    noneOfThese: 'none yet',
    alwaysIncluded: 'The title, the authors, the link to the original and the note that an AI wrote the text always travel with it. The file can end up a long way from here.',
    previewTitle: 'Paper title',
    previewByline: 'authors · rewritten by PaperTok',
    previewSection: 'What the paper is about',
    previewNote: (format) => (format === 'pdf' ? 'How the PDF will look' : 'How it will look compiled'),
    format: 'Format',
    downloadTex: 'Download .tex',
    downloadPdf: 'Download PDF',
    generating: 'Generating…',
    downloaded: 'Downloaded',
    unlimitedUses: 'Unlimited AI',
    unlimitedUsesTitle: 'This account has no daily limit on AI uses.',
    annotations: 'Annotations',
    toggleAnnotations: 'Show annotations',
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
    usesLeftLine: (left) => `${left} AI ${left === 1 ? 'use' : 'uses'} left today.`,
    reading: 'Reading the passage',
    originMine: 'Yours',
    originAi: 'AI',
    goToPassage: 'Go to the passage',
    removeAnnotation: 'Remove annotation',
    emptyAll: 'Select a sentence in the text to write a note on it, or to have the AI explain it.',
    emptyFiltered: 'Nothing here yet.',
    countLine: ({ notes, marks }) => {
      const parts = [];
      if (marks) parts.push(`${marks} ${marks === 1 ? 'mark' : 'marks'}`);
      if (notes) parts.push(`${notes} ${notes === 1 ? 'note' : 'notes'}`);
      return parts.join(' · ');
    },
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
  es: {
    AI_REWRITE_NEEDS_FULL_TEXT: {
      title: 'No hay paper que leer',
      body: 'La reescritura necesita el texto completo, y de este solo hay resumen o el PDF no se deja abrir. A veces es la fuente, que está caída: si crees que sí debería estar, reintenta.',
    },
    AI_AUTH_REQUIRED: {
      title: 'Necesitas iniciar sesión',
      body: 'Reescribir papers con IA es una función de las cuentas registradas.',
    },
    AI_QUOTA_EXHAUSTED: {
      title: 'Se han acabado los usos de hoy',
      body: 'Los usos de IA se reponen mañana. Mientras tanto, el paper original sigue donde estaba.',
    },
    AI_NOT_CONFIGURED: {
      title: 'La reescritura no está disponible',
      body: 'Esta función todavía no está activada aquí. No es culpa del paper.',
    },
    AI_TIMEOUT: {
      title: 'Ha tardado demasiado',
      body: 'El modelo dejó de responder a mitad de camino. Reintentar suele bastar.',
    },
    AI_BUSY: {
      title: 'El servicio está saturado',
      body: 'Hay demasiadas peticiones a la vez. Espera un momento y vuelve a intentarlo.',
    },
    AI_INVALID_PAPER: {
      title: 'Este paper no da para una versión en simple',
      body: 'El PDF no tiene texto suficiente que reescribir. Suele pasar con escaneos y con artículos de una página.',
    },
    AI_INVALID_RESPONSE: {
      title: 'El modelo contestó en otro formato',
      body: 'Respondió, pero no como el lector espera leerlo. Reintentar casi siempre lo arregla.',
    },
    AI_EMPTY_RESPONSE: {
      title: 'El modelo no devolvió nada',
      body: 'Suele ser un PDF demasiado grande, o un límite del proveedor. Reintentar a veces basta.',
    },
    AI_CANCELLED: {
      title: 'Reescritura cancelada',
      body: 'Se detuvo antes de empezar a escribir.',
    },
    AI_UNAVAILABLE: {
      title: 'No se ha podido reescribir',
      body: 'Algo falló entre el lector y el modelo. Reintentar suele bastar.',
    },
  },
  en: {
    AI_REWRITE_NEEDS_FULL_TEXT: {
      title: 'There is no paper to read',
      body: 'The rewrite needs the full text, and this one has only an abstract or a PDF that will not open. Sometimes it is the source being down: if you think it should be there, try again.',
    },
    AI_AUTH_REQUIRED: {
      title: 'You need to sign in',
      body: 'Rewriting papers with AI is a feature for signed-in accounts.',
    },
    AI_QUOTA_EXHAUSTED: {
      title: 'Today’s uses have run out',
      body: 'AI uses come back tomorrow. In the meantime, the original paper is still where it was.',
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
    AI_UNAVAILABLE: {
      title: 'The paper could not be rewritten',
      body: 'Something broke between the reader and the model. Retrying usually does it.',
    },
  },
};

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
  es: {
    AI_NOT_CONFIGURED: 'Preguntarle a la IA no está disponible todavía.',
    AI_AUTH_REQUIRED: 'Inicia sesión para preguntarle a la IA.',
    AI_QUOTA_EXHAUSTED: 'Se han acabado los usos de IA de hoy.',
    AI_BUSY: 'El servicio está saturado. Inténtalo en un momento.',
    AI_TIMEOUT: 'La explicación ha tardado demasiado. Puedes volver a pedirla.',
    AI_EMPTY_RESPONSE: 'El modelo no devolvió nada sobre este pasaje.',
    AI_INVALID_REQUEST: 'Selecciona un poco más de texto para poder preguntar.',
    AI_UNAVAILABLE: 'No se ha podido explicar este pasaje.',
  },
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

/**
 * What the failure is, so the screen can say it in colour as well as in words:
 * `wait` is amber (come back and it will work), `broken` is red (this attempt
 * went wrong), `closed` is neutral (nothing here is going to change by trying).
 */
const ERROR_TONES = {
  AI_QUOTA_EXHAUSTED: 'wait',
  AI_TIMEOUT: 'wait',
  AI_BUSY: 'wait',
  AI_CANCELLED: 'wait',
  AI_UNAVAILABLE: 'broken',
  AI_INVALID_RESPONSE: 'broken',
  AI_EMPTY_RESPONSE: 'broken',
  AI_AUTH_REQUIRED: 'closed',
  AI_NOT_CONFIGURED: 'closed',
  AI_INVALID_PAPER: 'closed',
  AI_REWRITE_NEEDS_FULL_TEXT: 'closed',
};

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

const EASE_OUT = [0.16, 1, 0.3, 1];

/*
 * The reader's own entrance and exit — growing out of the button that opened
 * it, collapsing back into it, the floating chrome a beat behind — are CSS
 * now, on the `[data-open]` / `[data-closed]` attributes the Base UI Dialog
 * sets (see `.rd[data-open]` in PaperReader.css). The origin still comes from
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
const PANEL_STATES = {
  shown: {
    opacity: 1,
    y: 0,
    scale: 1,
    pointerEvents: 'auto',
    transition: { duration: 0.26, ease: EASE_OUT },
  },
  hidden: {
    opacity: 0,
    y: 12,
    scale: 0.97,
    pointerEvents: 'none',
    transition: { duration: 0.18, ease: 'easeIn' },
  },
};

const STILL_PANEL_STATES = {
  shown: { opacity: 1, y: 0, scale: 1, pointerEvents: 'auto', transition: { duration: 0.12 } },
  hidden: { opacity: 0, y: 0, scale: 1, pointerEvents: 'none', transition: { duration: 0.12 } },
};

/**
 * Wiring for the panel's reveal. The rule itself lives in `utils/panelReveal.js`;
 * what is here is only how the four inputs are gathered.
 *
 * The strip is watched with `mousemove` rather than with an invisible element
 * that has `pointer-events`. A strip across the bottom of the page would swallow
 * the `mousedown` of anyone selecting text in the last lines, which is exactly
 * the gesture the highlighter exists for.
 */
function usePanelReveal() {
  const canHover = useMemo(
    () => typeof window === 'undefined'
      || window.matchMedia('(hover: hover) and (pointer: fine)').matches,
    [],
  );
  const [nearBottom, setNearBottom] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [holdsFocus, setHoldsFocus] = useState(false);
  const hideTimer = useRef(null);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) return;
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      setNearBottom(false);
    }, PANEL_HIDE_DELAY_MS);
  }, []);

  const trackPointer = useCallback((event) => {
    // Not while a button is down: dragging a selection towards the last lines
    // is not a request for the controls, it is reading.
    if (event.buttons !== 0) return;
    if (!pointerWakesPanel(event.clientY, window.innerHeight)) {
      // Only when there is something to put away. Without the guard, moving the
      // pointer anywhere in the upper page arms a timer every 300ms for a state
      // change that was never going to happen.
      if (nearBottom) scheduleHide();
      return;
    }
    clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setNearBottom(true);
  }, [nearBottom, scheduleHide]);

  const releasePointer = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = null;
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  return {
    shown: panelShouldShow({ canHover, hasScrolled, nearBottom, holdsFocus }),
    onPointerMove: canHover ? trackPointer : undefined,
    onPointerGone: canHover ? releasePointer : undefined,
    onScrolled: useCallback(() => setHasScrolled(true), []),
    onFocusIn: useCallback(() => setHoldsFocus(true), []),
    onFocusOut: useCallback((event) => {
      // A move between two controls inside the panel is not a departure.
      if (event.currentTarget.contains(event.relatedTarget)) return;
      setHoldsFocus(false);
    }, []),
  };
}

/**
 * Whether the coarse-pointer bar should be up, driven by scroll direction
 * (`nextBarVisibility`, Task 2) rather than by `usePanelReveal` above.
 * `panelShouldShow` answers `!canHover`, which is permanently `true` on every
 * device that renders `ReaderBar` — a touch screen has no hover to ask with —
 * so it cannot be the thing that varies here. This hook is the first place
 * that makes the bar's visibility actually move.
 *
 * Position lives in a ref, not state: a bare `scrollTop` read on every frame
 * of a momentum scroll is not worth a re-render, only a *change* in
 * visibility is. `setVisible` is therefore called at most once per direction
 * reversal, never once per scroll event.
 */
function useBarScrollVisibility({ scrollRef, enabled, frozen }) {
  const [visible, setVisible] = useState(true);
  const visibleRef = useRef(true);
  const previousTopRef = useRef(0);
  // Read fresh inside the listener without re-subscribing it on every
  // keystroke of a selection changing: the effect below installs the
  // listener once per mount (per the project's usual cleanup pattern — see
  // `usePanelReveal`'s own single `useEffect(() => () => clearTimeout(...))`
  // above), and a ref is how a long-lived closure sees a value that changes
  // between renders without becoming an effect dependency. Written from its
  // own effect, not during render — mutating a ref while rendering is the
  // thing `react-hooks/refs` exists to catch, even for a "just keep it
  // fresh" ref like this one.
  const frozenRef = useRef(frozen);
  useEffect(() => { frozenRef.current = frozen; }, [frozen]);

  useEffect(() => {
    if (!enabled) return undefined;
    const node = scrollRef.current;
    if (!node) return undefined;
    previousTopRef.current = node.scrollTop;

    const handleScroll = () => {
      const currentTop = node.scrollTop;
      const previousTop = previousTopRef.current;
      previousTopRef.current = currentTop;
      // A live selection or an open composer must never lose its bar to a
      // scroll underneath it — hiding the actions for the selection the
      // reader just made would be the worst possible moment (decision 4).
      // Position tracking above still runs while frozen, so the next real
      // decision, once the selection ends, starts from an accurate delta
      // instead of one stale from before the freeze.
      if (frozenRef.current) return;
      const next = nextBarVisibility({ previousTop, currentTop, visible: visibleRef.current });
      if (next === visibleRef.current) return;
      visibleRef.current = next;
      setVisible(next);
    };

    node.addEventListener('scroll', handleScroll, { passive: true });
    return () => node.removeEventListener('scroll', handleScroll);
  }, [enabled, scrollRef]);

  return visible;
}

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
function anchorFromSelection(range, paragraphNode, paragraphText) {
  if (!range || !paragraphNode) return null;
  const normalizedParagraph = normalizeLatexText(paragraphText);
  let start = Infinity;
  let end = -Infinity;

  for (const node of paragraphNode.querySelectorAll('[data-start]')) {
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
  es: { abstract: 'Resumen', intro: 'Introducción', background: 'Contexto', methods: 'Método', results: 'Resultados', discussion: 'Discusión', conclusion: 'Conclusión', other: 'Sección' },
  en: { abstract: 'Abstract', intro: 'Introduction', background: 'Background', methods: 'Methods', results: 'Results', discussion: 'Discussion', conclusion: 'Conclusion', other: 'Section' },
};

export default function PaperReader({ paper, onClose, originRect = null }) {
  const { isEnglish } = useLanguage();
  const { user } = useAuth();
  const uid = user?.uid;
  const { trackEvent } = useAnalyticsConsent();
  const prefersReducedMotion = useReducedMotion();
  const copy = COPY[isEnglish ? 'en' : 'es'];
  const kindLabels = KIND_LABELS[isEnglish ? 'en' : 'es'];
  // One shared id: every paragraph's `aria-describedby` on the keyboard
  // route points at the same hidden sentence rather than each rendering its
  // own copy of it.
  const paragraphHintId = useId();

  const [level, setLevel] = useState('university');
  const [sections, setSections] = useState([]);
  const [meta, setMeta] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [railOpen, setRailOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Which face the annotation sheet shows once open. Touch never gets a third
  // surface for the level/highlights controls — it gets a tab on this one.
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  /* Three switches rather than one "annotations": a bare mark and a mark you
     wrote on are different things to want in a file. */
  const [include, setInclude] = useState({ marks: true, mine: true, ai: true });
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
  const [quota, setQuota] = useState(null);
  const [stage, setStage] = useState('source');
  const abortRef = useRef(null);
  // The reader's own scroll container, so a touch selection outside it (e.g.
  // in a dialog rendered elsewhere in the tree) is never mistaken for one of
  // its paragraphs.
  const scrollRef = useRef(null);
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
  // Where focus lands on open: the way back, as it always was
  // (`data-dialog-initial-focus`, now the popup's `initialFocus`).
  const closeButtonRef = useRef(null);
  const panel = usePanelReveal();

  const supportsRewrite = canRewritePaper(paper);
  const paperId = paper?.id || paper?.doi || paper?.arxivId || '';

  const load = useCallback(async (targetLevel, { force = false } = {}) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // A cached level swaps in without a loading state at all.
    const cached = !force && getCachedRewrite(paper, targetLevel, isEnglish ? 'en' : 'es');
    if (cached) {
      setSections(cached.sections);
      setMeta({ ...cached.meta, cached: true });
      setStatus('ready');
      setError(null);
      return;
    }

    setSections([]);
    setMeta(null);
    setError(null);
    setStage('source');
    setStatus('streaming');

    // Counted here rather than in the effect: only this branch reaches the
    // worker, so a cache hit no longer inflates the metric, and a retry — which
    // does spend a use — is no longer invisible to it.
    trackEvent('paper_rewrite', { level: targetLevel, surface: 'reader' });

    try {
      const result = await rewritePaper(paper, targetLevel, {
        language: isEnglish ? 'en' : 'es',
        force,
        signal: controller.signal,
        onMeta: (nextMeta) => {
          setMeta(nextMeta);
          // The reservation has already happened by the time this arrives, so it
          // is the freshest count there is — fresher than what the reader asked
          // for when it opened.
          if (typeof nextMeta.remainingUses === 'number') {
            setQuota(current => ({ dailyLimit: current?.dailyLimit ?? null, remainingUses: nextMeta.remainingUses }));
          }
        },
        // `reveal` is what separates a section that was just written from one
        // that was already there. Only the fresh one gets the wipe; a cached
        // rewrite arrives all at once and must not stage a whole paper's worth
        // of animation nobody asked to watch.
        onSection: (section) => setSections(current => [...current, { ...section, reveal: true }]),
        onProgress: ({ stage: nextStage }) => setStage(nextStage),
      });
      setStatus(result.incomplete ? 'incomplete' : 'ready');
    } catch (caught) {
      if (caught instanceof PaperRewriteError && caught.code === 'AI_CANCELLED') return;
      setError(caught instanceof PaperRewriteError ? caught.code : 'AI_UNAVAILABLE');
      setStatus('error');
      // Most failures hand the use back, and the worker does it after the count
      // on the `meta` line was already sent. Re-reading is the only way the chip
      // can show the refund rather than a use the reader never actually spent.
      fetchRemainingAIUses({ signal: controller.signal }).then(fresh => { if (fresh) setQuota(fresh); });
    }
  }, [isEnglish, paper, trackEvent]);

  useEffect(() => {
    // The two ways the PDF can change are not the same thing. Going from no
    // readable PDF to one is a request that never happened, and the gate below
    // holds the key unclaimed until then, so it fires the moment the open-access
    // copy produces a URL. One readable PDF swapping for a better one is not:
    // the key ignores `pdfUrl`, so that re-run recognises its own request and
    // leaves the stream in flight alone.
    if (!supportsRewrite) return undefined;
    const requestKey = rewriteCacheKey(paper, level, isEnglish ? 'en' : 'es');
    if (requestedRewriteRef.current === requestKey) return undefined;
    // Deferred so the request starts after this render commits, matching how
    // the report page kicks off its own fetches. The key is claimed inside the
    // timer rather than before it: an effect torn down before its timer fires
    // has requested nothing, and must leave the rewrite pending, not swallowed.
    const timerId = setTimeout(() => {
      requestedRewriteRef.current = requestKey;
      load(level);
    }, 0);
    return () => clearTimeout(timerId);
  }, [isEnglish, level, load, paper, supportsRewrite]);

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

  useEffect(() => {
    if (!coversFeed) return undefined;
    document.body.setAttribute('data-reader-open', '');
    return () => document.body.removeAttribute('data-reader-open');
  }, [coversFeed]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 1100px)');
    const sync = (event) => setIsNarrow(event.matches);
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
    fetchRemainingAIUses({ signal: controller.signal }).then(fresh => {
      // Only when nothing better has arrived: a rewrite that started while this
      // was in flight already reported a newer number on its `meta` line.
      if (fresh) setQuota(current => current ?? fresh);
    });
    return () => controller.abort();
  }, [uid]);

  const noteQuota = useCallback((remainingUses) => {
    setQuota(current => ({ dailyLimit: current?.dailyLimit ?? null, remainingUses }));
  }, []);

  const annotations = usePassageAnnotations({
    uid,
    paper,
    paperId,
    level,
    language: isEnglish ? 'en' : 'es',
    onQuota: noteQuota,
    trackEvent,
  });

  const { begin: beginAnnotation } = annotations;

  // Gated by pointer type, never by window width: the reader already switches
  // layout below 1100px, and shrinking a laptop window must not flip a mouse
  // user onto the touch selection path.
  const coarsePointer = useMemo(() => {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
  }, []);
  const selectionRoute = pickSelectionRoute({ coarsePointer });

  /**
   * Whether the margin is a sheet rather than the desktop rail. Width alone:
   * the rail only mounts on the fine-pointer route now (the touch route has
   * no annotations UI at all — 2026-08-29), so a narrow mouse window gets
   * the sheet and everything else gets the desktop rail.
   */
  const railIsSheet = isNarrow;

  // Only wired on the route that actually renders `ReaderBar` — on the
  // desktop route this would be a scroll listener computing a value nothing
  // reads. Frozen by a live selection or an open composer (both collapse to
  // `annotations.pending` being truthy: `composing` cannot be `true` while
  // `pending` is falsy — see the `if (!pending && composing)` guard in
  // `ReaderBar.jsx` — so checking `pending` alone covers both).
  const barScrollVisible = useBarScrollVisibility({
    scrollRef,
    enabled: selectionRoute === 'bar',
    // Nothing left to freeze for: the touch route no longer creates
    // selections or opens a composer (the mobile reader is level + download,
    // 2026-08-29), so scroll direction is always an honest reading signal.
    frozen: false,
  });

  /**
   * A selection stops being a selection and becomes a decision.
   *
   * Everything the three outcomes could need is captured here, in one go, at
   * the moment the selection is decided (mouse-up on the desktop route,
   * `selectionchange` settling on the touch route): the quote, where it is
   * anchored, the paragraph around it (the model cannot explain "that
   * quantity" without the sentence that named it), and the rectangle to hang
   * the menu off. Capturing it all up front is what lets the browser's own
   * selection be cleared immediately — the reader paints its own provisional
   * mark instead, so the highlight you are deciding about is one you can
   * already see. Fine pointers only: the touch route has no annotation
   * actions (2026-08-29 — the mobile reader is level + download), so nothing
   * wires this there.
   */
  const handleSelection = useCallback((sectionId, paragraphIndex, paragraphText, paragraphNode) => {
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
    const rect = range.getBoundingClientRect();
    selection.removeAllRanges();
    beginAnnotation({
      sectionId,
      paragraphIndex,
      quote: anchor.quote,
      quoteStart: anchor.start,
      quoteEnd: anchor.end,
      context: paragraphText,
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
   * only that the function itself stays reachable (2.1.1). Wired only where
   * `handleSelection` is -- the 'menu' route, fine pointers, desktop -- for
   * the same reason its own comment gives.
   */
  const handleParagraphKeyDown = useCallback((event, sectionId, paragraphIndex, paragraphText) => {
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

  const userHighlightIndex = useMemo(() => {
    const index = indexHighlightsByParagraph(annotations.annotations, {
      level,
      language: isEnglish ? 'en' : 'es',
    });
    // One transient state gets folded in here rather than stored: the pen
    // stroke on a mark that has just been made.
    for (const [key, bucket] of index) {
      index.set(key, bucket.map(item => {
        const stored = annotations.annotations.find(entry => entry.id === item.id);
        return { ...item, fresh: Boolean(stored?.fresh) };
      }));
    }
    // The passage the menu is open on wears the pen already, provisionally —
    // on the desktop route only. Painting this mark rewrites the paragraph's
    // highlight runs, which rewrites the DOM text node a live selection Range
    // points into, which collapses the selection. Desktop wants exactly that
    // (the browser's own selection is already gone by the time this paints).
    // Touch cannot afford it: the OS handles live on that same selection, and
    // this repaint would silently drag them away mid-adjustment. On touch the
    // OS's own highlight is the provisional mark — nothing to add here.
    const waiting = selectionRoute === 'menu' ? annotations.pending : null;
    if (waiting) {
      const key = `${waiting.sectionId}:${waiting.paragraphIndex}`;
      index.set(key, [
        ...(index.get(key) || []),
        { id: 'pending', quote: waiting.quote, kind: 'user', source: 'user', pending: true },
      ]);
    }
    return index;
  }, [annotations.annotations, annotations.pending, isEnglish, level, selectionRoute]);

  const originalUrl = safeExternalUrl(paper?.openAccessPdfUrl)
    || safeExternalUrl(paper?.pdfUrl)
    || safeExternalUrl(paper?.landingPageUrl)
    || safeDoiUrl(paper?.doi);

  const levelLabel = PAPER_REWRITE_LEVELS.find(option => option.id === level) || { label: level, labelEn: level };

  // Counted on the same list the file will carry, not on the rail's: the rail
  // shows every annotation for the paper, and the card would have promised to
  // export notes written at another level.
  const exportCounts = useMemo(
    () => summarizeExport(exportableAnnotations(annotations.annotations, {
      sections,
      level,
      language: isEnglish ? 'en' : 'es',
    })),
    [annotations.annotations, isEnglish, level, sections],
  );

  /**
   * Hands the file over.
   *
   * A blob and an `<a download>`: there is no other way for a page to give the
   * browser a file it made itself. The object URL is revoked on the next tick
   * rather than immediately — revoking it in the same frame as the click can
   * beat the download to it in Safari, and the leak of waiting a tick is
   * nothing next to a download that silently does not happen.
   */
  const downloadTex = useCallback(() => {
    const built = buildLatexDocument({
      paper,
      sections,
      annotations: annotations.annotations,
      language: isEnglish ? 'en' : 'es',
      level,
      kindLabels,
      originalUrl,
      include,
    });
    const url = URL.createObjectURL(new Blob([built.source], {
      type: 'application/x-tex;charset=utf-8',
    }));
    const link = document.createElement('a');
    link.href = url;
    link.download = built.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    trackEvent('paper_export', {
      surface: 'reader',
      level,
      format: 'tex',
      notes: built.noteCount,
    });
  }, [annotations.annotations, include, isEnglish, kindLabels, level, originalUrl, paper, sections, trackEvent]);

  /**
   * The PDF is made, not written: pages laid out and rasterized in
   * `downloadPdfDocument`, which takes long enough for the card to need a
   * "generating" state. The libraries arrive as their own chunks on the first
   * use, so the failure worth planning for is a chunk that never lands —
   * `finally` gives the button back either way, and the card shows "saved"
   * only when the await resolves.
   */
  const downloadPdf = useCallback(async () => {
    const model = buildPdfModel({
      paper,
      sections,
      annotations: annotations.annotations,
      language: isEnglish ? 'en' : 'es',
      level,
      kindLabels,
      originalUrl,
      include,
    });
    setExporting(true);
    try {
      await downloadPdfDocument(model);
    } finally {
      setExporting(false);
    }
    trackEvent('paper_export', {
      surface: 'reader',
      level,
      format: 'pdf',
      notes: model.noteCount,
    });
  }, [annotations.annotations, include, isEnglish, kindLabels, level, originalUrl, paper, sections, trackEvent]);

  const handleDownload = useCallback(
    (format) => (format === 'pdf' ? downloadPdf() : downloadTex()),
    [downloadPdf, downloadTex],
  );

  /** Where the passage is, said in the reader's own vocabulary: "Método · §2". */
  const annotationLabel = useCallback((annotation) => {
    const section = sections.find(item => String(item.id) === String(annotation.sectionId));
    const kind = kindLabels[section?.kind] || kindLabels.other;
    return `${kind} · §${Number(annotation.paragraphIndex) + 1}`;
  }, [kindLabels, sections]);

  /**
   * The rail sends the reader back to a passage. `block: 'center'` is the whole
   * answer: the mark is already the only coloured thing on the page, so putting
   * it in the middle of the screen puts it under the reader's eyes. It used to
   * glow on arrival as well, which mostly fired when nobody had asked.
   */
  const goToPassage = useCallback((annotation) => {
    const selector = `[data-section="${CSS.escape(String(annotation.sectionId))}"][data-paragraph="${Number(annotation.paragraphIndex)}"]`;
    const paragraph = scrollRef.current?.querySelector(selector);
    if (!paragraph) return;
    paragraph.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'center',
    });
  }, [prefersReducedMotion]);


  const gateError = supportsRewrite ? null : 'AI_REWRITE_NEEDS_FULL_TEXT';
  const shownStatus = gateError ? 'error' : status;
  const shownError = gateError || error;
  const isStreaming = shownStatus === 'streaming';
  const errorCopy = ERROR_COPY[isEnglish ? 'en' : 'es'][shownError]
    || ERROR_COPY[isEnglish ? 'en' : 'es'].AI_UNAVAILABLE;
  const canRetry = supportsRewrite && !UNRETRYABLE_ERRORS.has(shownError);

  // One truth for all the floating chrome. A rewrite in flight overrides the
  // scroll state: the streaming indicator lives on the bar, so the bar (and
  // the chrome that follows it) has to stay up for it to be seen.
  //
  // Declared HERE, after `isStreaming`, and that placement is load-bearing:
  // an earlier draft sat next to `useBarScrollVisibility` above and shipped a
  // crash the whole test suite missed — `||` short-circuits, so while
  // `barScrollVisible` stayed `true` the `isStreaming` term was never
  // evaluated, and the first scroll down was the first evaluation of a const
  // still in its temporal dead zone. The reader worked until you scrolled,
  // then the error boundary took the whole app down (production, 2026-08-29).
  const barVisible = barScrollVisible || isStreaming;

  // On the touch route the top chrome follows the bar: reading down, the back
  // button and the uses counter recede with it instead of standing on the
  // text for the whole read (asked for from a real iPhone, 2026-08-29); a
  // scroll up brings both back. Fine pointers never hide chrome to begin with.
  const chromeReceded = coarsePointer && selectionRoute === 'bar' && !barVisible;

  /* The reader grows from wherever it was opened. `.rd` is `inset: 0`, so its
     own box is the viewport and the button's viewport coordinates are already
     the right origin — no measuring, no offset parent to correct for. Handed
     to the stylesheet as `--rd-origin`, which the arrival and the leave
     keyframes read as their `transform-origin`. */
  const transformOrigin = originRect
    ? `${originRect.left + originRect.width / 2}px ${originRect.top + originRect.height / 2}px`
    : '50% 62%';

  /* The dock's shared groups, each held once and rendered from both places
     that need them — the floating dock (fine pointer, below) and `ReaderBar`
     (touch), which receives them as `levelSlot`/`exportSlot`. One tree per
     control, so the two surfaces cannot drift apart. The annotations-toggle
     group stays inline in the dock only: the touch route has no annotations
     UI to toggle (2026-08-29). */
  const levelControl = (
    <div className="rd-panel-group">
      <span className="rd-panel-label">{copy.level}</span>
      <ToggleGroup
        value={[level]}
        // Single-select: the array carries at most one id, and it is empty
        // when the pressed level is pressed again — which is not a request
        // for no level at all, so it is ignored.
        onValueChange={([next]) => { if (next) setLevel(next); }}
        aria-label={copy.level}
      >
        {PAPER_REWRITE_LEVELS.map(option => (
          <ToggleGroupItem
            key={option.id}
            value={option.id}
            disabled={isStreaming && level !== option.id}
            aria-label={isEnglish ? option.labelEn : option.label}
          >
            {isEnglish ? option.labelEn : option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );

  /* Shared between the dock (fine pointer) and `ReaderBar` (touch): the
     touch route has no dock, and the export must stay reachable there —
     hiding it once already shipped a phone with no way to download.

     The download button is the trigger of the export card's Popover, and
     the card itself travels inside the same root so the two are one tree
     wherever this slot is rendered: Base UI anchors the card above the
     button, closes it on an outside press or Escape (and not on a press of
     the button, which toggles), and returns focus to it afterwards. The
     root renders no element of its own, so the group's markup is unchanged. */
  const exportControl = (
    <Popover open={exportOpen} onOpenChange={(next) => setExportOpen(next)}>
      <div className="rd-panel-group">
        <span className="rd-panel-label">{copy.download}</span>
        <PopoverTrigger
          render={<Toggle variant="brand" size="icon" pressed={exportOpen} />}
          disabled={sections.length === 0}
          title={copy.download}
          aria-label={copy.download}
        >
          <Download size={15} />
        </PopoverTrigger>
      </div>
      <ExportCard
        copy={{
          download: copy.download,
          whatGoes: copy.whatGoes,
          options: copy.exportOptions,
          optionCount: copy.optionCount,
          noneOfThese: copy.noneOfThese,
          alwaysIncluded: copy.alwaysIncluded,
          previewTitle: copy.previewTitle,
          previewByline: copy.previewByline,
          previewSection: copy.previewSection,
          previewNote: copy.previewNote,
          format: copy.format,
          downloadTex: copy.downloadTex,
          downloadPdf: copy.downloadPdf,
          generating: copy.generating,
          downloaded: copy.downloaded,
          cancel: copy.cancel,
        }}
        counts={exportCounts}
        include={include}
        onToggle={(id) => setInclude(current => ({ ...current, [id]: !current[id] }))}
        onDownload={handleDownload}
        busy={exporting}
        fileNames={{
          pdf: exportFileName(paper, isEnglish ? 'en' : 'es', 'pdf'),
          tex: exportFileName(paper, isEnglish ? 'en' : 'es'),
        }}
        stamp={`${isEnglish ? levelLabel.labelEn : levelLabel.label} · ${isEnglish ? 'English' : 'Español'}`}
      />
    </Popover>
  );

  // Shared with `ReaderBar` below: on the touch route the sheet holding
  // `AnnotationRail` sits fully off-screen with no peek, so a failed
  // "Que me lo explique" rendered only into the rail (as it always has been)
  // would land in a surface nobody is looking at — and the next scroll's
  // `dismiss()` clears it before it is ever seen. Null, not the fallback
  // string, while there is no error: both consumers gate their own rendering
  // on this being truthy, so a stray string here would show a phantom.
  const askErrorText = annotations.error
    ? (ANNOTATION_ERROR_COPY[isEnglish ? 'en' : 'es'][annotations.error]
      || ANNOTATION_ERROR_COPY[isEnglish ? 'en' : 'es'].AI_UNAVAILABLE)
    : null;

  return (
    /* A full-screen Base UI Dialog: modal (FeedContainer's scroll guard reads
       the `aria-modal` it sets), with pointer dismissal off because a surface
       that covers the viewport has no outside to press — and the export card
       and the selection menu are portaled popovers that must not read as one.
       The centred-sheet look of DialogContent is undone in `.rd` itself
       (PaperReader.css), which is also everything else the shell looks like. */
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
        onMouseMove={panel.onPointerMove}
        onMouseLeave={panel.onPointerGone}
      >
        {/* Chrome floats over the document instead of sitting in bars above it:
            the page is the interface, the controls are an overlay on top. */}
        <div className="rd-float-close" data-receded={chromeReceded ? '' : undefined}>
          <Button
            ref={closeButtonRef}
            variant="outline"
            size="icon"
            className="shadow-[var(--shadow-md)]"
            onClick={requestClose}
            aria-label={copy.close}
            title={copy.back}
          >
            <ArrowLeft size={18} />
          </Button>
        </div>

        <div className="rd-status" data-receded={chromeReceded ? '' : undefined}>
          {/* Identity to the document, state to the chrome. The kicker names
              *what this is* ("Leer en simple"), which is the same kind of fact
              as the paper's own title next to it in `rd-doc-title` — so on a
              coarse pointer it moves down there (see `.rd-doc-kicker` below)
              and scrolls away with the text it names, instead of floating in
              this fixed overlay for the whole read. The cache chip and the
              uses counter report *state* — what is true right now, exactly
              what a reader wants to check mid-scroll — so they stay pinned
              here on every pointer. On a fine pointer there is no scrolling
              chrome to hide behind in the first place, so the kicker simply
              stays: decision 3 in the reader's mobile plan, desktop untouched. */}
          {!coarsePointer && <span className="rd-status-kicker"><Sparkles size={11} /> {copy.title}</span>}
          {meta?.cached && <span className="rd-status-chip">{copy.cached}</span>}
          {quota && (
            <span
              className="rd-uses"
              data-level={quota.unlimited ? 'ok' : quota.remainingUses === 0 ? 'out' : quota.remainingUses <= 2 ? 'low' : 'ok'}
              title={quota.unlimited
                ? copy.unlimitedUsesTitle
                : quota.dailyLimit ? copy.usesTitle(quota.remainingUses, quota.dailyLimit) : undefined}
            >
              {/* A meter rather than a number alone: "three left" reads as plenty
                  until you see how short the row is. Segments only while there are
                  few enough to count at a glance. */}
              {/* No meter where there is nothing to empty. */}
              {!quota.unlimited && quota.dailyLimit > 0 && quota.dailyLimit <= 12 && (
                <span className="rd-uses-meter" aria-hidden="true">
                  {Array.from({ length: quota.dailyLimit }, (_, index) => (
                    <i key={index} data-spent={index >= quota.remainingUses ? '' : undefined} />
                  ))}
                </span>
              )}
              <span className="rd-uses-count">
                {quota.unlimited
                  ? copy.unlimitedUses
                  : quota.dailyLimit
                    ? copy.uses(quota.remainingUses, quota.dailyLimit)
                    : copy.remaining(quota.remainingUses)}
              </span>
            </span>
          )}
        </div>

        {/* Two elements, two jobs. The dock is what the reader's own entrance
            and exit move (in CSS, with the rest of the chrome); the panel
            inside it is what comes and goes with the pointer. One element
            holding both animations fights itself — the second to write a
            transform wins, and neither looks deliberate. */}
        <div
          className="rd-panel-dock"
          onFocusCapture={panel.onFocusIn}
          onBlurCapture={panel.onFocusOut}
        >
          <motion.div
            className="rd-panel"
            role="group"
            aria-label={copy.title}
            initial={false}
            animate={(prefersReducedMotion ? STILL_PANEL_STATES : PANEL_STATES)[panel.shown ? 'shown' : 'hidden']}
          >
            {levelControl}

            <div className="rd-panel-divider" />

            {/* Two switches, not one: what the model proposed and what you wrote
                are different things to want on screen. Dock-only — see the
                comment on `levelControl` above for why this one group isn't
                shared with the sheet's settings tab. */}
            <div className="rd-panel-group">
              <span className="rd-panel-label">{copy.annotations}</span>
              <Toggle
                variant="brand"
                size="icon"
                pressed={isNarrow ? sheetOpen : railOpen}
                onPressedChange={() => (isNarrow ? setSheetOpen(v => !v) : setRailOpen(v => !v))}
                title={copy.toggleAnnotations}
                aria-label={copy.toggleAnnotations}
              >
                <PenLine size={15} />
              </Toggle>
            </div>
            <div className="rd-panel-divider" />

            {exportControl}

          </motion.div>
        </div>

        <div
          ref={scrollRef}
          className="rd-scroll"
          onScroll={() => {
            panel.onScrolled();
            annotations.dismiss();
          }}
        >
          <article className="rd-doc">
            {/* The one title in the app that used to be printed raw: every other
                surface sends it through the same renderer, so a paper called
                "the $\mu$-Deformed Model" arrived here still wearing its dollars. */}
            {/* The kicker's other half of the split above: on a coarse pointer
                it lives here, in flow, ahead of the title it names, so it
                scrolls away with the paper instead of hovering over it. */}
            {coarsePointer && <span className="rd-doc-kicker"><Sparkles size={11} /> {copy.title}</span>}
            <h1 className="rd-doc-title" lang="en"><ScientificText>{paper?.title}</ScientificText></h1>
            <p className="rd-doc-byline">
              {(paper?.authors || []).slice(0, 6).map(author => author?.name || author).join(', ')}
              {(paper?.authors || []).length > 6 && ' et al.'}
              {paper?.year ? ` · ${paper.year}` : ''}
            </p>

            {/* Pointed at by every paragraph's `aria-describedby` below,
                never read on its own: the keyboard route's instructions, for
                the one audience that cannot see a hint that only paints on
                focus. */}
            {selectionRoute === 'menu' && (
              <p id={paragraphHintId} className="visually-hidden">{copy.annotateParagraphInstructions}</p>
            )}

            {shownStatus === 'error' ? (
              /* A failure is a block on the page, not a note left in the middle of
                 an empty one: a rule down the side in the colour of what went
                 wrong, the code set in mono because that is machine data, then the
                 same two-line hierarchy the rest of the document uses. */
              <div className="rd-error" role="alert" data-tone={ERROR_TONES[shownError] || 'broken'}>
                <span className="rd-error-kicker">
                  <AlertCircle size={12} />
                  {copy.errorKicker}
                  {shownError && <code>{shownError}</code>}
                </span>
                <h2 className="rd-error-title">{errorCopy.title}</h2>
                <p className="rd-error-body">{errorCopy.body}</p>
                <div className="rd-error-actions">
                  {canRetry && (
                    <button type="button" className="rd-retry" onClick={() => load(level, { force: true })}>
                      {copy.retry}
                    </button>
                  )}
                  {originalUrl && (
                    <a className="rd-original" href={originalUrl} target="_blank" rel="noopener noreferrer">
                      {copy.original} <ExternalLink size={13} />
                    </a>
                  )}
                </div>
              </div>
            ) : (
              <>
                {sections.map((section, sectionIndex) => (
                  <section
                    key={section.id || sectionIndex}
                    className="rd-section"
                    data-reveal={section.reveal ? '' : undefined}
                  >
                    <div className="rd-section-head">
                      <span className="rd-section-kind">{kindLabels[section.kind] || kindLabels.other}</span>
                      {section.originalHeading && (
                        <span className="rd-section-origin">{section.originalHeading}</span>
                      )}
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
                          data-section={section.id}
                          data-paragraph={paragraphIndex}
                          data-annotatable={selectionRoute === 'menu' ? '' : undefined}
                          data-hint={selectionRoute === 'menu' ? copy.annotateParagraphBadge : undefined}
                          style={{ '--i': Math.min(paragraphIndex, MAX_STAGGER_STEPS) }}
                          // Keyboard route into the same menu the mouse opens on
                          // mouse-up (WCAG 2.1.1) -- see `handleParagraphKeyDown`.
                          tabIndex={selectionRoute === 'menu' ? 0 : undefined}
                          aria-describedby={selectionRoute === 'menu' ? paragraphHintId : undefined}
                          onMouseUp={(event) => handleSelection(section.id, paragraphIndex, paragraph, event.currentTarget)}
                          onKeyDown={selectionRoute === 'menu'
                            ? (event) => handleParagraphKeyDown(event, section.id, paragraphIndex, paragraph)
                            : undefined}
                        >
                          <HighlightedScientificText highlights={[...stored, ...aiHighlights]}>
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
                      : { opacity: 0, y: -6, transition: { duration: 0.2, ease: 'easeIn' } }}
                  >
                    <p className="rd-ghost-head" role="status" aria-live="polite">
                      <ThinkingDots />
                      {/* Keyed by stage so the label is remounted, and its own
                          entrance animation replays, on every change of stage —
                          "downloading" does not jump into "reading". */}
                      <span key={stage} className="rd-ghost-stage">{copy.stages[stage] || copy.writing}</span>
                      <small>{sections.length > 0 ? `${sections.length} ${copy.sections}` : copy.writingHint}</small>
                    </p>
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={sections.length}
                        className="rd-ghost-body"
                        aria-hidden="true"
                        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scaleY: 0.7, y: -4 }}
                        animate={{ opacity: 1, scaleY: 1, y: 0 }}
                        exit={prefersReducedMotion
                          ? { opacity: 0, transition: { duration: 0.12 } }
                          : { opacity: 0, scaleY: 0.4, y: -8, transition: { duration: 0.18, ease: 'easeIn' } }}
                        transition={{ duration: prefersReducedMotion ? 0.12 : 0.26, ease: EASE_OUT }}
                      >
                        <div className="rd-ghost-title" />
                        <div className="rd-ghost-lines">
                          {GHOST_LINES.map((width, index) => (
                            <i key={index} style={{ '--w': width, '--i': index }} />
                          ))}
                        </div>
                      </motion.div>
                    </AnimatePresence>
                  </motion.div>
                  )}
                </AnimatePresence>

                {shownStatus === 'incomplete' && (
                  <p className="rd-notice" role="alert">
                    {copy.incomplete}
                    <button type="button" className="rd-retry" onClick={() => load(level, { force: true })}>
                      {copy.retry}
                    </button>
                  </p>
                )}
              </>
            )}

            {sections.length > 0 && (
              <footer className="rd-doc-footer">
                <p className="rd-attribution">{copy.adaptation}</p>
                {originalUrl && (
                  <a className="rd-original" href={originalUrl} target="_blank" rel="noopener noreferrer">
                    {copy.original} <ExternalLink size={13} />
                  </a>
                )}
                {meta?.model && (
                  <span className="rd-model">{meta.model}</span>
                )}
              </footer>
            )}
          </article>

          {/* Fine pointers only. The rail hides by sliding out rather than
              unmounting, so it comes back as the same margin and not a new
              one; on a mouse-narrow window it is a sheet that peeks by its
              header. The touch route mounts none of this: the mobile reader
              is level + download (2026-08-29), and its annotations UI —
              sheet, tabs, selection bar — went with that decision. */}
          {selectionRoute === 'menu' && (
          <AnnotationRail
            surface={railIsSheet ? 'sheet' : 'rail'}
            hidden={!railIsSheet && !railOpen}
            expanded={sheetOpen}
            onToggle={() => setSheetOpen(value => !value)}
            annotations={visibleAnnotations}
            counts={annotationCounts}
            filter={annotationFilter}
            onFilter={setAnnotationFilter}
            thinking={annotations.busy === 'asking'}
            error={Boolean(annotations.error)}
            errorText={askErrorText || ANNOTATION_ERROR_COPY[isEnglish ? 'en' : 'es'].AI_UNAVAILABLE}
            onFocus={goToPassage}
            onRemove={annotations.remove}
            onSettle={annotations.settle}
            labelFor={annotationLabel}
            copy={copy}
          />
          )}
        </div>

        {/* Over the selection, not in a corner: what it acts on is the passage
            under it, and a menu that drifts away from its subject stops being
            about it. A popover anchored to the selection's rectangle; it stays
            mounted and follows `pending` with `open`, so its leave can play
            over the passage it was about. (The export card lives with its
            trigger, in `exportControl` above.) */}
        {selectionRoute === 'menu' && (
          <SelectionMenu
            open={Boolean(annotations.pending)}
            anchor={annotations.pending?.anchor}
            copy={copy}
            usesLeft={quota?.unlimited ? null : quota?.remainingUses ?? null}
            unlimited={Boolean(quota?.unlimited)}
            canAsk={quota ? quota.unlimited || quota.remainingUses > 0 : true}
            busy={annotations.busy === 'saving'}
            onHighlight={annotations.highlight}
            onSaveNote={annotations.saveNote}
            onAsk={annotations.ask}
            onClose={annotations.dismiss}
          />
        )}

        {/* One island rather than a popover: always mounted on the touch
            route, morphing in place and hiding with the scroll. The mobile
            reader's whole control surface (2026-08-29): the level, the
            download, and the streaming indicator while a rewrite is being
            written. Gated on the first section having arrived: during the
            initial download-and-skeleton phase the island floated over the
            ghost lines saying nothing anyone could act on (seen on a real
            iPhone, 2026-08-29). Annotations, highlights and "explain this"
            live on the fine-pointer route only, until their mobile
            redesign. */}
        {selectionRoute === 'bar' && sections.length > 0 && (
          <ReaderBar
            copy={copy}
            levelSlot={levelControl}
            exportSlot={exportControl}
            streaming={isStreaming}
            visible={barVisible}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
