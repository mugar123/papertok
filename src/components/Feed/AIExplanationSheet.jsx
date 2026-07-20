import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  BookOpen,
  BrainCircuit,
  CheckCircle2,
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
} from '../../services/aiExplanationService.js';
import ScientificText from '../ScientificText';
import { normalizeAIExplanationMath } from '../../utils/aiExplanationMath.js';
import './AIExplanationSheet.css';

const ERROR_COPY = {
  AI_AUTH_REQUIRED: 'Inicia sesión para utilizar las explicaciones con IA.',
  AI_QUOTA_EXHAUSTED: 'Se han agotado los usos de IA disponibles por hoy. Volverán a estar disponibles mañana.',
  AI_NOT_CONFIGURED: 'Las explicaciones con IA todavía no están disponibles.',
  AI_TIMEOUT: 'La explicación está tardando demasiado. Puedes volver a intentarlo.',
  AI_BUSY: 'El servicio de IA está recibiendo muchas solicitudes. Inténtalo de nuevo dentro de un momento.',
  AI_INVALID_PAPER: 'Este paper no contiene suficiente información para generar una explicación fiable.',
  AI_INVALID_RESPONSE: 'No se ha podido construir una explicación fiable. Inténtalo de nuevo.',
  AI_UNAVAILABLE: 'No se ha podido generar la explicación ahora mismo. Inténtalo de nuevo.',
};

const SECTIONS = [
  { key: 'overview', label: 'El paper en pocas palabras', Icon: BookOpen },
  { key: 'whyItMatters', label: 'Por qué importa', Icon: Lightbulb },
  { key: 'methodology', label: 'Cómo lo investigaron', Icon: FlaskConical },
  { key: 'results', label: 'Qué encontraron', Icon: Target },
  { key: 'takeaway', label: 'Idea para llevarte', Icon: CheckCircle2 },
];

function ExplanationSkeleton() {
  return (
    <div className="ai-explanation-loading" role="status" aria-live="polite">
      <div className="ai-explanation-orbit"><Sparkles size={22} /></div>
      <strong>Analizando el paper</strong>
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

function ExplanationContent({ result }) {
  const explanation = result.explanation || {};
  return (
    <motion.div
      className="ai-explanation-result"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className={`ai-explanation-source ai-explanation-source--${result.sourceBasis}`}>
        {result.sourceBasis === 'full_text' ? <FileCheck2 size={15} /> : <FileText size={15} />}
        <span>{result.sourceBasis === 'full_text' ? 'Basado en el paper completo' : 'Basado en el abstract'}</span>
      </div>

      {SECTIONS.map(({ key, label, Icon }) => explanation[key] && (
        <section className={`ai-explanation-section ai-explanation-section--${key}`} key={key}>
          <h3><Icon size={17} /> {label}</h3>
          <div className="ai-explanation-prose"><TextBlock>{explanation[key]}</TextBlock></div>
        </section>
      ))}

      {explanation.keyPoints?.length > 0 && (
        <section className="ai-explanation-section ai-explanation-section--key-points">
          <h3><ListChecks size={17} /> Puntos clave</h3>
          <ul>{explanation.keyPoints.map((point, index) => <li key={`${index}-${point}`}><TextBlock>{point}</TextBlock></li>)}</ul>
        </section>
      )}

      {explanation.concepts?.length > 0 && (
        <section className="ai-explanation-section">
          <h3><BrainCircuit size={17} /> Conceptos esenciales</h3>
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
          <h3><KeyRound size={17} /> Para entenderlo mejor</h3>
          <ul>{explanation.prerequisites.map((item, index) => <li key={`${index}-${item}`}><TextBlock>{item}</TextBlock></li>)}</ul>
        </section>
      )}

      {explanation.limitations?.length > 0 && (
        <section className="ai-explanation-section ai-explanation-section--limitations">
          <h3><AlertCircle size={17} /> Límites y cautelas</h3>
          <ul>{explanation.limitations.map((item, index) => <li key={`${index}-${item}`}><TextBlock>{item}</TextBlock></li>)}</ul>
        </section>
      )}
    </motion.div>
  );
}

export default function AIExplanationSheet({ paper, onClose }) {
  const [level, setLevel] = useState('university');
  const [results, setResults] = useState({});
  const [loadingLevel, setLoadingLevel] = useState(null);
  const [error, setError] = useState(null);
  const result = results[level];
  const levelLabel = useMemo(
    () => AI_EXPLANATION_LEVELS.find(item => item.id === level)?.label || '',
    [level],
  );

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleExplain = async () => {
    if (loadingLevel) return;
    setError(null);
    setLoadingLevel(level);
    try {
      const response = await explainPaper(paper, level);
      setResults(previous => ({ ...previous, [level]: response }));
    } catch (requestError) {
      setError(ERROR_COPY[requestError?.code] || ERROR_COPY.AI_UNAVAILABLE);
    } finally {
      setLoadingLevel(null);
    }
  };

  return (
    <motion.div
      className="ai-explanation-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="ai-explanation-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-explanation-title"
        initial={{ opacity: 0, y: 32, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.98 }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        onClick={event => event.stopPropagation()}
      >
        <div className="ai-explanation-grabber" aria-hidden="true" />
        <header className="ai-explanation-header">
          <div className="ai-explanation-heading">
            <span className="ai-explanation-heading-icon"><Sparkles size={19} /></span>
            <div>
              <h2 id="ai-explanation-title">Explicar con IA</h2>
              <p>{paper.title}</p>
            </div>
          </div>
          <button className="ai-explanation-close" onClick={onClose} aria-label="Cerrar explicación" title="Cerrar">
            <X size={20} />
          </button>
        </header>

        <div className="ai-explanation-levels" role="tablist" aria-label="Nivel de explicación">
          {AI_EXPLANATION_LEVELS.map(item => (
            <button
              key={item.id}
              role="tab"
              aria-selected={level === item.id}
              className={level === item.id ? 'is-active' : ''}
              disabled={Boolean(loadingLevel)}
              onClick={() => { setLevel(item.id); setError(null); }}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="ai-explanation-body">
          {loadingLevel === level ? (
            <ExplanationSkeleton />
          ) : result ? (
            <ExplanationContent result={result} />
          ) : (
            <div className="ai-explanation-empty">
              <span><BrainCircuit size={30} /></span>
              <h3>Explicación para nivel {levelLabel.toLowerCase()}</h3>
              <button className="ai-explanation-generate" onClick={handleExplain}>
                <Sparkles size={17} /> Explicar este paper
              </button>
            </div>
          )}

          {error && (
            <motion.div className="ai-explanation-error" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              {!/agotado|todavía no|Inicia sesión/.test(error) && (
                <button onClick={handleExplain}>Reintentar</button>
              )}
            </motion.div>
          )}
        </div>

        {result && loadingLevel !== level && (
          <footer className="ai-explanation-footer">
            <span>IA puede cometer errores. Contrasta los detalles con el paper.</span>
          </footer>
        )}
      </motion.div>
    </motion.div>
  );
}
