import { useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import { Search, Layers, Newspaper, UserCheck } from 'lucide-react';
import NavPreferencesMenu from './NavPreferencesMenu';
import './Navbar.css';

/**
 * How the rule travels: a tween that ends, not a spring that approaches.
 *
 * It was a spring — `stiffness: 420, damping: 38, mass: 0.7`, a damping ratio
 * of about 1.11, so overdamped, so an exponential tail. Measured on the longest
 * hop ("For you" to Following, 133px): the first 90% of the travel took 224ms
 * and the last 10% took another 216ms. Half the animation was spent drifting
 * the final thirteen pixels. And because the rule grows as it goes — the two
 * words are not the same width — the left edge was home while the right edge
 * still had ten pixels to cover, so it read as the bar arriving short of the
 * word, stopping, and then creeping right.
 *
 * A spring cannot fix that by retuning: every variant measured (bounce 0,
 * bounce 0.15, a critically damped one) still spent 43–50% of its time on that
 * last tenth, because that is the shape of a spring. A bounded tween does not
 * have a tail: this one spends 28%, and both edges land on the same frame.
 */
const RULE_TRAVEL = { duration: 0.28, ease: [0.4, 0, 0.2, 1] };

/**
 * The yellow rule under the tab you are on.
 *
 * It used to be `.navbar-link.active::after`: a pseudo-element that blinked out
 * of one link and into the next, so the three feeds read as three unrelated
 * places. One element with a shared `layoutId` is the same rule travelling —
 * framer measures where it was and where it landed and tweens between the two,
 * width included, which is what ties "For you", Research and Following
 * together as one row.
 */
function ActiveTabRule({ reduced }) {
  return (
    <motion.span
      className="navbar-link-rule"
      layoutId="navbar-active-tab"
      aria-hidden="true"
      transition={reduced ? { duration: 0 } : RULE_TRAVEL}
    />
  );
}

export default function Navbar({ onOpenSearch = () => {}, searchOpen = false }) {
  const { user, profilePhoto } = useAuth();
  const { feedMode, setFeedMode } = useFeed();
  const { isEnglish } = useLanguage();
  const reduced = useReducedMotion();
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

        <div className="navbar-links">
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
            {isHomeActive && feedMode === 'top' && <ActiveTabRule reduced={reduced} />}
          </button>

          <NavLink
            to="/research"
            className={`navbar-link ${isResearchActive ? 'active' : ''}`}
          >
            <Newspaper size={15} aria-hidden="true" />
            Research
            {isResearchActive && <ActiveTabRule reduced={reduced} />}
          </NavLink>

          <NavLink
            to="/following"
            className={`navbar-link ${isFollowingActive ? 'active' : ''}`}
          >
            <UserCheck size={15} aria-hidden="true" />
            {isEnglish ? 'Following' : 'Siguiendo'}
            {isFollowingActive && <ActiveTabRule reduced={reduced} />}
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
