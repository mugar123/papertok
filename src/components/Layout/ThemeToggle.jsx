import { useRef } from 'react';
import { Toggle } from '../ui/toggle.jsx';
import { useLanguage } from '../../context/LanguageContext';
import { useTheme } from '../../context/ThemeContext';
import './ThemeToggle.css';

/**
 * The ink switch: one more button in the utility group, next to reload — in
 * the bar for a session, in the guest header for a visitor. The host passes
 * its own chrome class (`.navbar-icon-btn`, `.guest-header-button`), which are
 * the same 32 × 32 control under two names; everything particular to this one
 * rides on `.theme-toggle`.
 *
 * The icon says where the reader is — an outlined sun on paper, a solid
 * crescent on ink — and `aria-pressed` says the same thing to a screen reader.
 * The name stays put while the state moves, which is the whole reason to use a
 * pressed button: a name that flips to "switch to light mode" *and* a pressed
 * state announces as "switch to light mode, button, pressed", and the listener
 * has to guess which half is the state. It is the ui `Toggle` (Base UI), which
 * owns `aria-pressed`; the stylesheet keys the morph off that same attribute,
 * so the drawing and the announcement cannot drift apart.
 *
 * The disc is one circle: `r 8` scaled to half for the sun, full and inked for
 * the moon, with a masked bite that slides in last. `vector-effect` keeps the
 * stroke at its lucide weight through the scale, so the moon does not come out
 * heavier than the icons either side of it.
 */
export default function ThemeToggle({ className = 'navbar-icon-btn' }) {
  const { isDark, toggleTheme } = useTheme();
  const { isEnglish } = useLanguage();
  const buttonRef = useRef(null);

  const label = isEnglish ? 'Dark mode' : 'Modo oscuro';

  return (
    <Toggle
      ref={buttonRef}
      size="icon"
      className={`${className} theme-toggle`}
      pressed={isDark}
      title={label}
      aria-label={label}
      onPressedChange={() => toggleTheme(buttonRef.current)}
    >
      <svg
        className="theme-toggle-disc"
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <g className="theme-toggle-rays">
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m4.93 4.93 1.41 1.41" />
          <path d="m17.66 17.66 1.41 1.41" />
          <path d="m6.34 17.66-1.41 1.41" />
          <path d="m19.07 4.93-1.41 1.41" />
        </g>
        {/* A stencil, not a palette: black and white here are "cut" and "keep",
            which is the one place a token would be wrong. */}
        <mask id="theme-toggle-mask">
          <rect x="-6" y="-6" width="36" height="36" fill="#ffffff" />
          <circle className="theme-toggle-bite" cx="12" cy="12" r="8" fill="#000000" />
        </mask>
        <circle
          className="theme-toggle-core"
          cx="12"
          cy="12"
          r="8"
          fill="currentColor"
          fillOpacity="0"
          vectorEffect="non-scaling-stroke"
          mask="url(#theme-toggle-mask)"
        />
      </svg>
    </Toggle>
  );
}
