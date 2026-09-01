import { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Check, Moon, Settings, SlidersHorizontal, Sun } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useTheme } from '../../context/ThemeContext';
import './NavPreferencesMenu.css';

/** Kept in step with the exit animation in NavPreferencesMenu.css. */
const MENU_EXIT_MS = 140;

/**
 * Las preferencias rápidas de la barra, plegadas tras un solo icono: el tema
 * dejó de ocupar un botón propio y el idioma gana su primer acceso fuera de
 * /settings. Es un disclosure, no un menu ARIA: dentro hay toggles con estado,
 * y un role="menu" prometería flechas y items sin estado que esto no tiene.
 */
export default function NavPreferencesMenu() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  const rootRef = useRef(null);
  const themeRowRef = useRef(null);
  const closeTimer = useRef(null);
  const { isDark, toggleTheme } = useTheme();
  const { language, isEnglish, setLanguage } = useLanguage();
  const { user } = useAuth();
  const navigate = useNavigate();
  const visible = open || closing;

  const closeMenu = useCallback(() => {
    if (!open || closing || closeTimer.current) return;
    if (prefersReducedMotion) {
      setOpen(false);
      return;
    }
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
      setClosing(false);
    }, MENU_EXIT_MS);
  }, [open, closing, prefersReducedMotion]);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) closeMenu();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, closeMenu]);

  const label = isEnglish ? 'Preferences' : 'Preferencias';

  return (
    <div className="nav-prefs" ref={rootRef}>
      <button
        type="button"
        className={`navbar-icon-btn nav-prefs-trigger ${visible ? 'is-open' : ''}`}
        aria-expanded={visible}
        aria-label={label}
        title={label}
        onClick={() => {
          if (closing) return;
          if (open) closeMenu();
          else setOpen(true);
        }}
      >
        <SlidersHorizontal size={17} aria-hidden="true" />
      </button>

      {visible && (
        <div
          className={`nav-prefs-menu${closing ? ' is-closing' : ''}`}
          role="group"
          aria-label={label}
        >
          <button
            type="button"
            ref={themeRowRef}
            className="nav-prefs-row"
            aria-pressed={isDark}
            onClick={() => toggleTheme(themeRowRef.current)}
          >
            {isDark ? <Moon size={15} aria-hidden="true" /> : <Sun size={15} aria-hidden="true" />}
            <span>{isEnglish ? 'Dark mode' : 'Modo oscuro'}</span>
            {isDark && <Check size={14} className="nav-prefs-check" aria-hidden="true" />}
          </button>

          <div className="nav-prefs-row nav-prefs-row--static">
            <span>{isEnglish ? 'Language' : 'Idioma'}</span>
            <div className="nav-prefs-lang" role="group" aria-label={isEnglish ? 'Language' : 'Idioma'}>
              <button
                type="button"
                aria-pressed={language === 'es'}
                onClick={() => { setLanguage('es'); }}
              >
                ES
              </button>
              <button
                type="button"
                aria-pressed={language === 'en'}
                onClick={() => { setLanguage('en'); }}
              >
                EN
              </button>
            </div>
          </div>

          {user && (
            <>
              <div className="nav-prefs-divider" role="separator" />
              <button
                type="button"
                className="nav-prefs-row"
                onClick={() => {
                  closeMenu();
                  navigate('/settings');
                }}
              >
                <Settings size={15} aria-hidden="true" />
                <span>{isEnglish ? 'All settings' : 'Todos los ajustes'}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
