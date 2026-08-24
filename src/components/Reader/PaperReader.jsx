import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  AlertCircle,
  ArrowLeft,
  ExternalLink,
  Highlighter,
  Loader2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  canRewritePaper,
  getCachedRewrite,
  PAPER_REWRITE_LEVELS,
  PaperRewriteError,
  rewriteCacheKey,
  rewritePaper,
} from '../../services/paperRewriteService.js';
import {
  indexHighlightsByParagraph,
  listUserHighlights,
  removeUserHighlight,
  saveUserHighlight,
} from '../../services/userHighlightService.js';
import { buildSelectionAnchor } from '../../utils/textHighlights.js';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';
import { safeDoiUrl, safeExternalUrl } from '../../utils/externalUrl.js';
import { Button } from '../ui/button.jsx';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.jsx';
import HighlightedScientificText from './HighlightedScientificText.jsx';
import './PaperReader.css';

const COPY = {
  es: {
    title: 'Leer en simple',
    close: 'Cerrar lector',
    back: 'Volver',
    level: 'Nivel',
    writing: 'Reescribiendo el paper',
    writingHint: 'Las secciones aparecen a medida que se escriben.',
    cached: 'Versión guardada',
    highlightsOn: 'Destacados activados',
    highlightsOff: 'Destacados desactivados',
    toggleHighlights: 'Destacados',
    original: 'Ver el paper original',
    adaptation: 'Adaptación generada por IA a partir del texto completo. No sustituye al artículo original.',
    remaining: (count) => `${count} ${count === 1 ? 'uso' : 'usos'} hoy`,
    retry: 'Reintentar',
    incomplete: 'La reescritura se cortó antes de terminar. Puedes reintentarlo.',
    yourHighlight: 'Quitar destacado',
    selectHint: 'Selecciona texto para destacarlo',
    sections: 'secciones',
  },
  en: {
    title: 'Read in plain words',
    close: 'Close reader',
    back: 'Back',
    level: 'Level',
    writing: 'Rewriting the paper',
    writingHint: 'Sections appear as they are written.',
    cached: 'Saved version',
    highlightsOn: 'Highlights on',
    highlightsOff: 'Highlights off',
    toggleHighlights: 'Highlights',
    original: 'View the original paper',
    adaptation: 'AI adaptation generated from the full text. It does not replace the original article.',
    remaining: (count) => `${count} ${count === 1 ? 'use' : 'uses'} today`,
    retry: 'Try again',
    incomplete: 'The rewrite stopped before finishing. You can try again.',
    yourHighlight: 'Remove highlight',
    selectHint: 'Select text to highlight it',
    sections: 'sections',
  },
};

const ERROR_COPY = {
  es: {
    AI_REWRITE_NEEDS_FULL_TEXT: 'Esta reescritura necesita el texto completo del paper, y aquí solo hay resumen o el PDF no es accesible.',
    AI_AUTH_REQUIRED: 'Inicia sesión para reescribir papers.',
    AI_QUOTA_EXHAUSTED: 'Se han agotado los usos de IA de hoy. Volverán mañana.',
    AI_NOT_CONFIGURED: 'La reescritura con IA todavía no está disponible.',
    AI_TIMEOUT: 'La reescritura ha tardado demasiado. Puedes reintentarlo.',
    AI_BUSY: 'El servicio de IA está saturado. Inténtalo en un momento.',
    AI_INVALID_PAPER: 'Este paper no tiene texto suficiente para reescribirlo.',
    AI_INVALID_RESPONSE: 'El modelo respondió, pero no en el formato esperado. Reintentar suele bastar.',
    AI_EMPTY_RESPONSE: 'El modelo no devolvió texto. Suele ser un PDF demasiado grande o un límite del proveedor.',
    AI_CANCELLED: 'Reescritura cancelada.',
    AI_UNAVAILABLE: 'No se ha podido reescribir el paper ahora mismo.',
  },
  en: {
    AI_REWRITE_NEEDS_FULL_TEXT: 'This rewrite needs the full text of the paper, and only an abstract is available or the PDF cannot be read.',
    AI_AUTH_REQUIRED: 'Sign in to rewrite papers.',
    AI_QUOTA_EXHAUSTED: 'Today’s AI uses have run out. They return tomorrow.',
    AI_NOT_CONFIGURED: 'AI rewriting is not available yet.',
    AI_TIMEOUT: 'The rewrite took too long. You can try again.',
    AI_BUSY: 'The AI service is busy. Try again in a moment.',
    AI_INVALID_PAPER: 'This paper does not have enough text to rewrite.',
    AI_INVALID_RESPONSE: 'The model answered, but not in the expected format. Retrying usually fixes it.',
    AI_EMPTY_RESPONSE: 'The model returned no text. Usually an oversized PDF or a provider limit.',
    AI_CANCELLED: 'Rewrite cancelled.',
    AI_UNAVAILABLE: 'The paper could not be rewritten right now.',
  },
};

const KIND_LABELS = {
  es: { abstract: 'Resumen', intro: 'Introducción', background: 'Contexto', methods: 'Método', results: 'Resultados', discussion: 'Discusión', conclusion: 'Conclusión', other: 'Sección' },
  en: { abstract: 'Abstract', intro: 'Introduction', background: 'Background', methods: 'Methods', results: 'Results', discussion: 'Discussion', conclusion: 'Conclusion', other: 'Section' },
};

export default function PaperReader({ paper, onClose }) {
  const { isEnglish } = useLanguage();
  const { user } = useAuth();
  const uid = user?.uid;
  const { trackEvent } = useAnalyticsConsent();
  const prefersReducedMotion = useReducedMotion();
  const copy = COPY[isEnglish ? 'en' : 'es'];
  const kindLabels = KIND_LABELS[isEnglish ? 'en' : 'es'];

  const [level, setLevel] = useState('university');
  const [sections, setSections] = useState([]);
  const [meta, setMeta] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [showHighlights, setShowHighlights] = useState(true);
  const [userHighlights, setUserHighlights] = useState([]);
  const abortRef = useRef(null);
  /**
   * The rewrite this reader has already asked for, keyed the way the rewrite
   * cache keys itself. The object arriving as `paper` is rebuilt upstream when
   * the open-access copy resolves (`readablePaper` in PaperCard), and until this
   * ref existed that new identity re-ran the effect below: the sections already
   * streamed were thrown away, the reader dropped back to `streaming`, and a
   * second of the ten daily uses went on the very same paper.
   */
  const requestedRewriteRef = useRef('');
  const dialogRef = useDialogFocus(true, onClose);

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
        onMeta: (nextMeta) => setMeta(nextMeta),
        onSection: (section) => setSections(current => [...current, section]),
      });
      setStatus(result.incomplete ? 'incomplete' : 'ready');
    } catch (caught) {
      if (caught instanceof PaperRewriteError && caught.code === 'AI_CANCELLED') return;
      setError(caught instanceof PaperRewriteError ? caught.code : 'AI_UNAVAILABLE');
      setStatus('error');
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

  useEffect(() => {
    if (!uid || !paperId) return;
    let active = true;
    listUserHighlights(uid, paperId).then(stored => {
      if (active) setUserHighlights(stored);
    });
    return () => { active = false; };
  }, [paperId, uid]);

  const userHighlightIndex = useMemo(
    () => indexHighlightsByParagraph(userHighlights, {
      level,
      language: isEnglish ? 'en' : 'es',
    }),
    [isEnglish, level, userHighlights],
  );

  const handleSelection = useCallback(async (sectionId, paragraphIndex) => {
    if (!uid) return;
    const selection = window.getSelection();
    const anchor = buildSelectionAnchor(selection?.toString());
    if (!anchor) return;
    selection.removeAllRanges();
    const saved = await saveUserHighlight(uid, {
      paperId,
      paperTitle: paper?.title,
      level,
      language: isEnglish ? 'en' : 'es',
      sectionId,
      paragraphIndex,
      quote: anchor.quote,
    });
    if (saved) {
      setUserHighlights(current => [...current.filter(item => item.id !== saved.id), saved]);
      trackEvent('paper_highlight', { surface: 'reader', level });
    }
  }, [isEnglish, level, paper?.title, paperId, trackEvent, uid]);

  const handleRemoveHighlight = useCallback(async (highlightId) => {
    if (!uid || !highlightId) return;
    const removed = await removeUserHighlight(uid, highlightId);
    if (removed) setUserHighlights(current => current.filter(item => item.id !== highlightId));
  }, [uid]);

  const originalUrl = safeExternalUrl(paper?.openAccessPdfUrl)
    || safeExternalUrl(paper?.pdfUrl)
    || safeExternalUrl(paper?.landingPageUrl)
    || safeDoiUrl(paper?.doi);

  const gateError = supportsRewrite ? null : 'AI_REWRITE_NEEDS_FULL_TEXT';
  const shownStatus = gateError ? 'error' : status;
  const shownError = gateError || error;
  const isStreaming = shownStatus === 'streaming';

  return (
    <motion.div
      ref={dialogRef}
      className="rd"
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
      tabIndex={-1}
      initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 12 }}
      transition={{ duration: prefersReducedMotion ? 0 : 0.24, ease: [0.16, 1, 0.3, 1] }}
    >
      {/* Chrome floats over the document instead of sitting in bars above it:
          the page is the interface, the controls are an overlay on top. */}
      <Button
        variant="outline"
        size="icon"
        className="rd-float-close shadow-[var(--shadow-md)]"
        onClick={onClose}
        data-dialog-initial-focus
        aria-label={copy.close}
        title={copy.back}
      >
        <ArrowLeft size={18} />
      </Button>

      <div className="rd-status">
        <span className="rd-status-kicker"><Sparkles size={11} /> {copy.title}</span>
        {meta?.cached && <span className="rd-status-chip">{copy.cached}</span>}
        {typeof meta?.remainingUses === 'number' && (
          <span className="rd-status-chip">{copy.remaining(meta.remainingUses)}</span>
        )}
      </div>

      <div className="rd-panel" role="group" aria-label={copy.title}>
        <div className="rd-panel-group">
          <span className="rd-panel-label">{copy.level}</span>
          <ToggleGroup
            type="single"
            value={level}
            onValueChange={(next) => { if (next) setLevel(next); }}
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

        <div className="rd-panel-divider" />

        <div className="rd-panel-group">
          <span className="rd-panel-label">{copy.toggleHighlights}</span>
          <Button
            variant={showHighlights ? 'brand' : 'outline'}
            size="icon-sm"
            onClick={() => setShowHighlights(value => !value)}
            aria-pressed={showHighlights}
            title={showHighlights ? copy.highlightsOn : copy.highlightsOff}
            aria-label={copy.toggleHighlights}
          >
            <Highlighter size={15} />
          </Button>
        </div>
      </div>

      <div className="rd-scroll">
        <article className="rd-doc">
          <h1 className="rd-doc-title">{paper?.title}</h1>
          <p className="rd-doc-byline">
            {(paper?.authors || []).slice(0, 6).map(author => author?.name || author).join(', ')}
            {(paper?.authors || []).length > 6 && ' et al.'}
            {paper?.year ? ` · ${paper.year}` : ''}
          </p>

          {shownStatus === 'error' ? (
            <div className="rd-state" role="alert">
              <AlertCircle size={20} />
              <p>{ERROR_COPY[isEnglish ? 'en' : 'es'][shownError] || ERROR_COPY[isEnglish ? 'en' : 'es'].AI_UNAVAILABLE}</p>
              {supportsRewrite && (
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
          ) : (
            <>
              {sections.map((section, sectionIndex) => (
                <section key={section.id || sectionIndex} className="rd-section">
                  <div className="rd-section-head">
                    <span className="rd-section-kind">{kindLabels[section.kind] || kindLabels.other}</span>
                    {section.originalHeading && (
                      <span className="rd-section-origin">{section.originalHeading}</span>
                    )}
                  </div>
                  {section.heading && <h2 className="rd-section-title">{section.heading}</h2>}
                  {section.paragraphs.map((paragraph, paragraphIndex) => {
                    const aiHighlights = showHighlights
                      ? (section.highlights || [])
                        .filter(item => item.paragraphIndex === paragraphIndex)
                        .map(item => ({ ...item, source: 'ai' }))
                      : [];
                    const stored = userHighlightIndex.get(`${section.id}:${paragraphIndex}`) || [];
                    return (
                      <p
                        key={paragraphIndex}
                        className="rd-p"
                        data-section={section.id}
                        data-paragraph={paragraphIndex}
                        onMouseUp={() => handleSelection(section.id, paragraphIndex)}
                      >
                        <HighlightedScientificText highlights={[...stored, ...aiHighlights]}>
                          {paragraph}
                        </HighlightedScientificText>
                      </p>
                    );
                  })}
                </section>
              ))}

              {isStreaming && (
                <p className="rd-writing" role="status" aria-live="polite">
                  <Loader2 size={15} className="spinning" />
                  <span>{copy.writing}</span>
                  <small>{sections.length > 0 ? `${sections.length} ${copy.sections}` : copy.writingHint}</small>
                </p>
              )}

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

        {userHighlights.length > 0 && (
          <aside className="rd-notes" aria-label={copy.toggleHighlights}>
            <span className="rd-notes-label"><Highlighter size={12} /> {copy.toggleHighlights}</span>
            <ul>
              {userHighlights.map(highlight => (
                <li key={highlight.id}>
                  <span>{highlight.quote}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveHighlight(highlight.id)}
                    aria-label={copy.yourHighlight}
                    title={copy.yourHighlight}
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </motion.div>
  );
}
