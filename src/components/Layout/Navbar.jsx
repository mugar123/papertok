import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { ruleTransform } from '../../utils/navRule.js';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import { Search, Layers, Newspaper, UserCheck } from 'lucide-react';
import NavPreferencesMenu from './NavPreferencesMenu';
import './Navbar.css';

/**
 * The yellow rule under the tab you are on.
 *
 * It was a `::after` on the active link, which could only blink from one
 * link to the next; then a framer `layoutId` element, which travelled — but
 * in JavaScript, on the main thread, which is exactly the thread a tab switch
 * keeps busy mounting the next feed. Measured: the rule slid, froze short of
 * the word for ~200 ms while the cards mounted, and slid the rest.
 *
 * Now it is one element positioned with a transform the CSS transition
 * animates on the compositor, so it keeps moving whatever the main thread is
 * doing. This hook measures the active link — after every render, and again
 * when the row resizes (the active link is semibold, so activating one changes
 * its width and shifts its neighbours) — and returns the transform. The first
 * measurement is applied without a transition, so the rule does not slide in
 * from the row's left edge on load.
 */
function useActiveTabRule(rowRef, activeKey) {
  const [rule, setRule] = useState({ transform: '', measured: false });

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const measure = () => {
      const link = row.querySelector('.navbar-link.active');
      if (!link) {
        setRule(current => (current.transform ? { ...current, transform: '' } : current));
        return;
      }
      const inset = parseFloat(getComputedStyle(link).paddingLeft) || 0;
      const transform = ruleTransform(link.getBoundingClientRect(), row.getBoundingClientRect().left, inset);
      setRule(current => (current.transform === transform && current.measured ? current : { transform, measured: true }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    row.querySelectorAll('.navbar-link').forEach(link => observer.observe(link));
    return () => observer.disconnect();
  }, [rowRef, activeKey]);

  return rule;
}

export default function Navbar({ onOpenSearch = () => {}, searchOpen = false }) {
  const { user, profilePhoto } = useAuth();
  const { feedMode, setFeedMode } = useFeed();
  const { isEnglish } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const pathname = location.pathname === '/' ? '/' : location.pathname.replace(/\/+$/, '');

  useEffect(() => {
    const handleShortcut = (event) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      const isTyping = target instanceof Element && target.closest(
        'input, textarea, select, [contenteditable="true"]',
      );
      if (isTyping) return;
      event.preventDefault();
      onOpenSearch();
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [onOpenSearch]);

  const isFollowingActive = pathname === '/following';
  const isResearchActive = pathname === '/research' || pathname === '/report';
  const isHomeActive = pathname === '/';
  const activeTab = isHomeActive && feedMode === 'top' ? 'home' : isResearchActive ? 'research' : isFollowingActive ? 'following' : '';
  const linksRef = useRef(null);
  const rule = useActiveTabRule(linksRef, `${activeTab}:${isEnglish}`);

  return (
    <nav className="navbar" aria-label={isEnglish ? 'Main navigation' : 'Navegación principal'}>
      <div className="navbar-inner">
        <button
          type="button"
          className="navbar-brand"
          onClick={() => {
            if (location.pathname !== '/') navigate('/');
          }}
          aria-label="PaperTok"
        >
          <span className="navbar-brand-mark" aria-hidden="true">PT</span>
          <span className="navbar-brand-word">Paper<span>Tok</span></span>
        </button>

        {/* Open, the bar holds the state it put the reader in. Without it you
            clicked a bar and a sheet appeared somewhere else, with nothing
            connecting the two — and closing left nothing behind either. The
            transition is already on the element, so the state fades in and out
            rather than snapping. */}
        <button
          type="button"
          className={`navbar-search ${searchOpen ? 'is-open' : ''}`}
          onClick={onOpenSearch}
          aria-expanded={searchOpen}
        >
          <Search size={15} aria-hidden="true" />
          <span>{isEnglish ? 'Search papers, authors, topics...' : 'Buscar papers, autores, temas...'}</span>
          <kbd aria-hidden="true">/</kbd>
        </button>

        <div className="navbar-links" ref={linksRef}>
          <span
            className={`navbar-link-rule${rule.measured ? ' is-measured' : ''}`}
            aria-hidden="true"
            style={{ transform: rule.transform || undefined, opacity: rule.transform ? 1 : 0 }}
          />
          <button
            type="button"
            className={`navbar-link ${isHomeActive && feedMode === 'top' ? 'active' : ''}`}
            aria-current={isHomeActive && feedMode === 'top' ? 'page' : undefined}
            onClick={() => {
              if (location.pathname !== '/') navigate('/');
              setFeedMode('top');
            }}
          >
            <Layers size={15} aria-hidden="true" />
            {isEnglish ? 'For you' : 'Para ti'}
          </button>

          <NavLink
            to="/research"
            className={`navbar-link ${isResearchActive ? 'active' : ''}`}
          >
            <Newspaper size={15} aria-hidden="true" />
            Research
          </NavLink>

          <NavLink
            to="/following"
            className={`navbar-link ${isFollowingActive ? 'active' : ''}`}
          >
            <UserCheck size={15} aria-hidden="true" />
            {isEnglish ? 'Following' : 'Siguiendo'}
          </NavLink>
        </div>

        <div className="navbar-right">
          <button
            className={`navbar-icon-btn navbar-icon-btn--search-compact ${searchOpen ? 'is-open' : ''}`}
            aria-expanded={searchOpen}
            onClick={onOpenSearch}
            title={isEnglish ? 'Search' : 'Buscar'}
            aria-label={isEnglish ? 'Search' : 'Buscar'}
          >
            <Search size={17} />
          </button>

          {/* Regla 6: las utilidades se agrupan a la derecha tras la regla de
              1px. Tema e idioma viven plegados tras el botón de preferencias:
              cambian cómo se ve la aplicación, no lo que está mostrando. */}
          <NavPreferencesMenu />

          {user && (
            <div className="navbar-profile">
              {/* Straight to the profile, TikTok-style: no menu in between.
                  Settings and sign-out live behind the gear on that page, and
                  My lists behind the profile's own Lists tab, so the menu this
                  replaces costs nothing. The navigation is synchronous on
                  purpose — <Routes> sits inside an AnimatePresence with
                  mode="wait", and a navigate() from an async continuation can
                  leave it stalled. */}
              <button
                className={`navbar-avatar-btn ${pathname === '/profile' ? 'active' : ''}`}
                aria-label={isEnglish ? 'My profile' : 'Mi perfil'}
                title={isEnglish ? 'My profile' : 'Mi perfil'}
                onClick={() => navigate('/profile')}
              >
                {profilePhoto || user.photoURL ? (
                  <img
                    src={profilePhoto || user.photoURL}
                    alt="Profile"
                    className="navbar-avatar"
                    referrerPolicy="no-referrer"
                    // Always visible above the fold on every route -- lazy
                    // loading would only delay it for no benefit. `.navbar-avatar`
                    // renders at 26x26.
                    decoding="async"
                    width="26"
                    height="26"
                  />
                ) : (
                  <div className="navbar-avatar navbar-avatar--fallback">
                    {user.email?.charAt(0).toUpperCase() || 'U'}
                  </div>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
