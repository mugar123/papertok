import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Moon, Settings, SlidersHorizontal, Sun } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.jsx';
import { Toggle } from '../ui/toggle.jsx';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.jsx';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useTheme } from '../../context/ThemeContext';
import './NavPreferencesMenu.css';

/**
 * Las preferencias rápidas de la barra, plegadas tras un solo icono: el tema
 * dejó de ocupar un botón propio y el idioma gana su primer acceso fuera de
 * /settings. Es un Popover con un `role="group"` dentro, no un menu ARIA: hay
 * toggles con estado, y un role="menu" prometería flechas y items sin estado
 * que esto no tiene. Base UI ancla el panel al botón, lo cierra con Escape y
 * al pulsar fuera, y espera a que la salida CSS termine antes de desmontar.
 */
export default function NavPreferencesMenu() {
  const [open, setOpen] = useState(false);
  const themeRowRef = useRef(null);
  const { isDark, toggleTheme } = useTheme();
  const { language, isEnglish, setLanguage } = useLanguage();
  const { user } = useAuth();
  const navigate = useNavigate();

  const label = isEnglish ? 'Preferences' : 'Preferencias';
  const languageLabel = isEnglish ? 'Language' : 'Idioma';

  return (
    <div className="nav-prefs">
      <Popover open={open} onOpenChange={setOpen}>
        {/* Base UI stamps `aria-expanded` and `data-popup-open` on the trigger;
            the open look keys off the latter. */}
        <PopoverTrigger
          render={<button type="button" className="navbar-icon-btn nav-prefs-trigger" />}
          aria-label={label}
          title={label}
        >
          <SlidersHorizontal size={17} aria-hidden="true" />
        </PopoverTrigger>

        <PopoverContent
          className="nav-prefs-menu"
          role="group"
          aria-label={label}
          side="bottom"
          align="end"
          sideOffset={10}
        >
          <Toggle
            ref={themeRowRef}
            className="nav-prefs-row"
            pressed={isDark}
            onPressedChange={() => toggleTheme(themeRowRef.current)}
          >
            {isDark ? <Moon size={15} aria-hidden="true" /> : <Sun size={15} aria-hidden="true" />}
            <span>{isEnglish ? 'Dark mode' : 'Modo oscuro'}</span>
            {isDark && <Check size={14} className="nav-prefs-check" aria-hidden="true" />}
          </Toggle>

          <div className="nav-prefs-row nav-prefs-row--static">
            <span>{languageLabel}</span>
            {/* Single-select: the group reports `[]` when the pressed language
                is pressed again, and "no language" is not a state we have. */}
            <ToggleGroup
              className="nav-prefs-lang"
              aria-label={languageLabel}
              value={[language]}
              onValueChange={([next]) => { if (next) setLanguage(next); }}
            >
              <ToggleGroupItem value="es">ES</ToggleGroupItem>
              <ToggleGroupItem value="en">EN</ToggleGroupItem>
            </ToggleGroup>
          </div>

          {user && (
            <>
              <div className="nav-prefs-divider" role="separator" />
              <button
                type="button"
                className="nav-prefs-row"
                onClick={() => {
                  setOpen(false);
                  navigate('/settings');
                }}
              >
                <Settings size={15} aria-hidden="true" />
                <span>{isEnglish ? 'All settings' : 'Todos los ajustes'}</span>
              </button>
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
