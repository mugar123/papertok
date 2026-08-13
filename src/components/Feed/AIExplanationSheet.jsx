import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertCircle,
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  Cpu,
  FileCheck2,
  FileText,
  FlaskConical,
  KeyRound,
  Lightbulb,
  ListChecks,
  Sparkles,
  Target,
  X,
} from 'lucide-react';
import {
  AI_EXPLANATION_LEVELS,
  explainPaper,
  formatAIModelLabel,
} from '../../services/aiExplanationService.js';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import ScientificText from '../ScientificText';
import { normalizeAIExplanationMath } from '../../utils/aiExplanationMath.js';
import { formatQuotaCountdown, formatQuotaResetTime } from '../../utils/aiQuota.js';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';
import './AIExplanationSheet.css';

const ERROR_COPY = {
  es: {
    AI_AUTH_REQUIRED: 'Inicia sesión para utilizar las explicaciones con IA.',
    AI_QUOTA_EXHAUSTED: 'Se han agotado los usos de IA disponibles por hoy. Volverán a estar disponibles mañana.',
    AI_FALLBACK_BUDGET_EXHAUSTED: 'Se ha alcanzado el límite mensual de seguridad de Kimi. No se realizarán más llamadas de pago este mes.',
    AI_NOT_CONFIGURED: 'Las explicaciones con IA todavía no están disponibles.',
    AI_TIMEOUT: 'La explicación está tardando demasiado. Puedes volver a intentarlo.',
    AI_BUSY: 'El servicio de IA está recibiendo muchas solicitudes. Inténtalo de nuevo dentro de un momento.',
    AI_INVALID_PAPER: 'Este paper no contiene suficiente información para generar una explicación fiable.',
    AI_INVALID_RESPONSE: 'No se ha podido construir una explicación fiable. Inténtalo de nuevo.',
    AI_UNAVAILABLE: 'No se ha podido generar la explicación ahora mismo. Inténtalo de nuevo.',
  },
  en: {
    AI_AUTH_REQUIRED: 'Sign in to use AI explanations.',
    AI_QUOTA_EXHAUSTED: 'Today’s AI uses have run out. They will be available again tomorrow.',
    AI_FALLBACK_BUDGET_EXHAUSTED: 'Kimi’s monthly safety limit has been reached. No more paid calls will be made this month.',
    AI_NOT_CONFIGURED: 'AI explanations are not available yet.',
    AI_TIMEOUT: 'The explanation is taking too long. You can try again.',
    AI_BUSY: 'The AI service is receiving many requests. Try again in a moment.',
    AI_INVALID_PAPER: 'This paper does not contain enough information for a reliable explanation.',
    AI_INVALID_RESPONSE: 'A reliable explanation could not be built. Try again.',
    AI_UNAVAILABLE: 'The explanation could not be generated right now. Try again.',
  },
};

const SECTIONS = [
  { key: 'overview', label: { es: 'El paper en pocas palabras', en: 'The paper in a nutshell' }, Icon: BookOpen },
  { key: 'whyItMatters', label: { es: 'Por qué importa', en: 'Why it matters' }, Icon: Lightbulb },
  { key: 'methodology', label: { es: 'Cómo lo investigaron', en: 'How they studied it' }, Icon: FlaskConical },
  { key: 'results', label: { es: 'Qué encontraron', en: 'What they found' }, Icon: Target },
  { key: 'takeaway', label: { es: 'Idea para llevarte', en: 'Main takeaway' }, Icon: CheckCircle2 },
];

const LEVEL_LABELS = {
  beginner: { es: 'Principiante', en: 'Beginner' },
  university: { es: 'Universitario', en: 'University' },
  researcher: { es: 'Investigador', en: 'Researcher' },
};

const SHEET_COPY = {
  es: {
    analyzing: 'Analizando el paper',
    fullText: 'Basado en el paper completo',
    abstract: 'Basado en el abstract',
    savedResult: 'Resultado guardado',
    unavailableQuota: 'Cupo no disponible',
    oneUse: 'uso hoy',
    manyUses: 'usos hoy',
    keyPoints: 'Puntos clave',
    concepts: 'Conceptos esenciales',
    prerequisites: 'Para entenderlo mejor',
    limitations: 'Límites y cautelas',
    title: 'Explicar con IA',
    closeExplanation: 'Cerrar explicación',
    close: 'Cerrar',
    level: 'Nivel de explicación',
    explanationFor: 'Explicación para nivel',
    explainPaper: 'Explicar este paper',
    retryIn: 'Prueba de nuevo en',
    budgetResets: 'El presupuesto se restablece en',
    tryAgainIn: 'Vuelve a intentarlo en',
    quotaRenews: 'El cupo se renueva a las',
    localTime: 'hora local',
    retry: 'Reintentar',
    disclaimer: 'La IA puede cometer errores. Contrasta los detalles con el paper.',
  },
  en: {
    analyzing: 'Analyzing the paper',
    fullText: 'Based on the full paper',
    abstract: 'Based on the abstract',
    savedResult: 'Saved result',
    unavailableQuota: 'Usage unavailable',
    oneUse: 'use today',
    manyUses: 'uses today',
    keyPoints: 'Key points',
    concepts: 'Essential concepts',
    prerequisites: 'Helpful background',
    limitations: 'Limitations and cautions',
    title: 'Explain with AI',
    closeExplanation: 'Close explanation',
    close: 'Close',
    level: 'Explanation level',
    explanationFor: 'Explanation for',
    explainPaper: 'Explain this paper',
    retryIn: 'Try again in',
    budgetResets: 'The budget resets in',
    tryAgainIn: 'Try again in',
    quotaRenews: 'The quota renews at',
    localTime: 'local time',
    retry: 'Try again',
    disclaimer: 'AI can make mistakes. Check the details against the paper.',
  },
};

function ExplanationSkeleton({ language }) {
  const copy = SHEET_COPY[language];
  return (
    <div className="ai-explanation-loading" role="status" aria-live="polite">
      <div className="ai-explanation-orbit"><Sparkles size={22} /></div>
      <strong>{copy.analyzing}</strong>
      <div className="ai-explanation-skeleton-lines" aria-hidden="true">
        <span /><span /><span /><span />
      </div>
    </div>
  );
}

function TextBlock({ children }) {
  if (!children) return null;
  return <ScientificText>{normalizeAIExplanationMath(children)}</ScientificText>;
}

function ExplanationContent({ result, language }) {
  const copy = SHEET_COPY[language];
  const explanation = result.explanation || {};
  const remainingUses = Number.isFinite(Number(result.remainingUses))
    ? Math.max(0, Number(result.remainingUses))
    : null;
  return (
    <div className="ai-explanation-result">
      <div className="ai-explanation-context">
        <div className={`ai-explanation-source ai-explanation-source--${result.sourceBasis}`}>
          {result.sourceBasis === 'full_text' ? <FileCheck2 size={15} /> : <FileText size={15} />}
          <span>{result.sourceBasis === 'full_text' ? copy.fullText : copy.abstract}</span>
        </div>
        <div className="ai-explanation-model" title={result.model || undefined}>
          <Cpu size={14} />
          <span>{formatAIModelLabel(result.model, result.provider, language)}</span>
          <span className="ai-explanation-model-separator" aria-hidden="true">·</span>
          <span>{remainingUses === null
            ? result.cached ? copy.savedResult : copy.unavailableQuota
            : `${remainingUses} ${remainingUses === 1 ? copy.oneUse : copy.manyUses}`}</span>
        </div>
      </div>

      {SECTIONS.map(({ key, label, Icon }) => explanation[key] && (
        <section className={`ai-explanation-section ai-explanation-section--${key}`} key={key}>
          <h3><Icon size={17} /> {label[language]}</h3>
          <div className="ai-explanation-prose"><TextBlock>{explanation[key]}</TextBlock></div>
        </section>
      ))}

      {explanation.keyPoints?.length > 0 && (
        <section className="ai-explanation-section ai-explanation-section--key-points">
          <h3><ListChecks size={17} /> {copy.keyPoints}</h3>
          <ul>{explanation.keyPoints.map((point, index) => <li key={`${index}-${point}`}><TextBlock>{point}</TextBlock></li>)}</ul>
        </section>
      )}

      {explanation.concepts?.length > 0 && (
        <section className="ai-explanation-section">
          <h3><BrainCircuit size={17} /> {copy.concepts}</h3>
          <div className="ai-explanation-concepts">
            {explanation.concepts.map(concept => (
              <div className="ai-explanation-concept" key={concept.term}>
                <strong><TextBlock>{concept.term}</TextBlock></strong>
                <div><TextBlock>{concept.explanation}</TextBlock></div>
              </div>
            ))}
          </div>
        </section>
      )}

      {explanation.prerequisites?.length > 0 && (
        <section className="ai-explanation-section">
          <h3><KeyRound size={17} /> {copy.prerequisites}</h3>
          <ul>{explanation.prerequisites.map((item, index) => <li key={`${index}-${item}`}><TextBlock>{item}</TextBlock></li>)}</ul>
        </section>
      )}

      {explanation.limitations?.length > 0 && (
        <section className="ai-explanation-section ai-explanation-section--limitations">
          <h3><AlertCircle size={17} /> {copy.limitations}</h3>
          <ul>{explanation.limitations.map((item, index) => <li key={`${index}-${item}`}><TextBlock>{item}</TextBlock></li>)}</ul>
        </section>
      )}
    </div>
  );
}

export default function AIExplanationSheet({ paper, onClose }) {
  const { readingPreferences } = useAuth();
  const { language } = useLanguage();
  const { trackEvent, markActivation } = useAnalyticsConsent();
  const prefersReducedMotion = useReducedMotion();
  const [isMobileViewport, setIsMobileViewport] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches
  ));
  const copy = SHEET_COPY[language];
  const [level, setLevel] = useState(readingPreferences.aiExplanationLevel);
  const [results, setResults] = useState({});
  const [loadingLevel, setLoadingLevel] = useState(null);
  const [error, setError] = useState(null);
  const [quotaNow, setQuotaNow] = useState(() => Date.now());
  const [isClosing, setIsClosing] = useState(false);
  const closeTimerRef = useRef(null);
  const closingRef = useRef(false);
  const result = results[level];
  const stateTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.24, ease: [0.16, 1, 0.3, 1] };
  const layoutTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.38, ease: [0.16, 1, 0.3, 1] };
  const overlayTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: isClosing ? 0.22 : 0.3, ease: isClosing ? [0.4, 0, 1, 1] : [0.16, 1, 0.3, 1] };
  const sheetTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: isClosing ? 0.24 : 0.44, ease: isClosing ? [0.4, 0, 1, 1] : [0.16, 1, 0.3, 1] };
  const levelLabel = useMemo(
    () => LEVEL_LABELS[level]?.[language] || '',
    [language, level],
  );

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setIsClosing(true);
    closeTimerRef.current = setTimeout(onClose, prefersReducedMotion ? 0 : 250);
  }, [onClose, prefersReducedMotion]);
  const dialogRef = useDialogFocus(true, requestClose);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 640px)');
    const updateViewport = event => setIsMobileViewport(event.matches);
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', updateViewport);
      return () => mediaQuery.removeEventListener('change', updateViewport);
    }
    mediaQuery.addListener(updateViewport);
    return () => mediaQuery.removeListener(updateViewport);
  }, []);

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!error?.quota?.resetAt) return undefined;
    const interval = window.setInterval(() => setQuotaNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [error?.quota?.resetAt]);

  const handleExplain = async () => {
    if (loadingLevel) return;
    setError(null);
    setLoadingLevel(level);
    trackEvent('ai_explanation', { action: 'request', surface: 'feed' });
    try {
      const response = await explainPaper(paper, level, { language });
      setResults(previous => ({ ...previous, [level]: response }));
      trackEvent('ai_explanation', { action: 'complete', surface: 'feed' });
      markActivation();
    } catch (requestError) {
      trackEvent('ai_explanation', { action: 'error', surface: 'feed' });
      setError({
        message: ERROR_COPY[language][requestError?.code] || ERROR_COPY[language].AI_UNAVAILABLE,
        code: requestError?.code,
        quota: requestError?.quota || null,
      });
    } finally {
      setLoadingLevel(null);
    }
  };

  return (
    <motion.div
      className="ai-explanation-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: isClosing ? 0 : 1 }}
      transition={overlayTransition}
      onClick={requestClose}
    >
      <motion.div
        ref={dialogRef}
        className={`ai-explanation-sheet ${isMobileViewport ? 'is-mobile-sheet' : ''} ${isClosing ? 'is-closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-explanation-title"
        tabIndex={-1}
        initial={isMobileViewport || prefersReducedMotion
          ? false
          : { opacity: 0, y: 46, scale: 0.972 }}
        animate={isMobileViewport
          ? undefined
          : isClosing
            ? prefersReducedMotion
              ? { opacity: 0 }
              : { opacity: 0, y: 26, scale: 0.986 }
            : { opacity: 1, y: 0, scale: 1 }}
        transition={sheetTransition}
        onClick={event => event.stopPropagation()}
      >
        <div className="ai-explanation-grabber" aria-hidden="true" />
        <header className="ai-explanation-header">
          <div className="ai-explanation-heading">
            <span className="ai-explanation-heading-icon"><Sparkles size={19} /></span>
            <div>
              <h2 id="ai-explanation-title">{copy.title}</h2>
              <p>{paper.title}</p>
            </div>
          </div>
          <button
            className="ai-explanation-close"
            onClick={requestClose}
            aria-label={copy.closeExplanation}
            title={copy.close}
            data-dialog-initial-focus
          >
            <X size={20} />
          </button>
        </header>

        <div className="ai-explanation-levels" role="tablist" aria-label={copy.level}>
          {AI_EXPLANATION_LEVELS.map(item => (
            <button
              key={item.id}
              role="tab"
              aria-selected={level === item.id}
              className={level === item.id ? 'is-active' : ''}
              disabled={Boolean(loadingLevel)}
              onClick={() => { setLevel(item.id); setError(null); }}
            >
              {LEVEL_LABELS[item.id][language]}
            </button>
          ))}
        </div>

        <motion.div
          className="ai-explanation-body"
          layout="size"
          transition={{ layout: layoutTransition }}
          aria-busy={Boolean(loadingLevel)}
        >
          <div className="ai-explanation-stage">
            <AnimatePresence initial={false} mode="wait">
              {loadingLevel === level ? (
                <motion.div
                  key="loading"
                  className="ai-explanation-stage-state"
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
                  transition={stateTransition}
                >
                  <ExplanationSkeleton language={language} />
                </motion.div>
              ) : result ? (
                <motion.div
                  key="result"
                  className="ai-explanation-stage-state"
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
                  transition={stateTransition}
                >
                  <ExplanationContent result={result} language={language} />
                </motion.div>
              ) : (
                <motion.div
                  key="empty"
                  className="ai-explanation-stage-state"
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
                  transition={stateTransition}
                >
                  <div className="ai-explanation-empty">
                    <span><BrainCircuit size={30} /></span>
                    <h3>{copy.explanationFor} {levelLabel.toLowerCase()}</h3>
                    <button className="ai-explanation-generate" onClick={handleExplain}>
                      <Sparkles size={17} /> {copy.explainPaper}
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {error && (
            <motion.div
              className="ai-explanation-error"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              role="alert"
            >
              <AlertCircle size={18} />
              <span>
                {error.message}
                {error.quota?.resetAt && (
                  <small>
                    {error.quota.scope === 'provider-rate' ? (
                      <>{copy.retryIn} <strong>{formatQuotaCountdown(error.quota.resetAt, quotaNow)}</strong>.</>
                    ) : error.quota.scope === 'fallback-budget' ? (
                      <>{copy.budgetResets} <strong>{formatQuotaCountdown(error.quota.resetAt, quotaNow)}</strong>.</>
                    ) : (
                      <>{copy.tryAgainIn} <strong>{formatQuotaCountdown(error.quota.resetAt, quotaNow)}</strong>. {copy.quotaRenews} {formatQuotaResetTime(error.quota.resetAt)} ({copy.localTime}).</>
                    )}
                  </small>
                )}
              </span>
              {!['AI_QUOTA_EXHAUSTED', 'AI_FALLBACK_BUDGET_EXHAUSTED', 'AI_NOT_CONFIGURED', 'AI_AUTH_REQUIRED'].includes(error.code) && (
                <button onClick={handleExplain}>{copy.retry}</button>
              )}
            </motion.div>
          )}
        </motion.div>

        <AnimatePresence initial={false}>
          {result && loadingLevel !== level && (
            <motion.footer
              key="disclaimer"
              className="ai-explanation-footer"
              initial={prefersReducedMotion ? false : { opacity: 0, height: 0, y: 6 }}
              animate={{ opacity: 1, height: 'auto', y: 0 }}
              exit={prefersReducedMotion ? { opacity: 0, height: 0 } : { opacity: 0, height: 0, y: 6 }}
              transition={prefersReducedMotion
                ? { duration: 0 }
                : {
                  height: { duration: 0.28, ease: [0.16, 1, 0.3, 1] },
                  opacity: { duration: 0.18 },
                  y: { duration: 0.22, ease: [0.16, 1, 0.3, 1] },
                }}
              style={{ overflow: 'hidden' }}
            >
              <span>{copy.disclaimer}</span>
            </motion.footer>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
