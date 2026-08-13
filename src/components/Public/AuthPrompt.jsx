import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, LockKeyhole, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext.jsx';
import './AuthPrompt.css';

export default function AuthPrompt({ onClose, onContinue }) {
  const { isEnglish } = useLanguage();
  const prefersReducedMotion = useReducedMotion();

  return (
    <motion.div
      className="public-auth-prompt-backdrop"
      role="presentation"
      initial={prefersReducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.section
        className="public-auth-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-auth-prompt-title"
        initial={prefersReducedMotion ? false : { opacity: 0, y: 18, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.99 }}
        transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="public-auth-prompt-close" onClick={onClose} aria-label={isEnglish ? 'Close' : 'Cerrar'}>
          <X size={18} />
        </button>
        <span className="public-auth-prompt-icon" aria-hidden="true"><LockKeyhole size={22} /></span>
        <h2 id="public-auth-prompt-title">
          {isEnglish ? 'Make PaperTok yours' : 'Haz que PaperTok sea tuyo'}
        </h2>
        <p>
          {isEnglish
            ? 'Create a free account to like, save, follow research and train your recommendation feed.'
            : 'Crea una cuenta gratuita para dar me gusta, guardar, seguir investigación y entrenar tus recomendaciones.'}
        </p>
        <button type="button" className="public-auth-prompt-continue" onClick={onContinue}>
          {isEnglish ? 'Continue with Google' : 'Continuar con Google'} <ArrowRight size={17} />
        </button>
      </motion.section>
    </motion.div>
  );
}

