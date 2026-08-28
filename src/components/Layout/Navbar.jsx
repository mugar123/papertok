import { useState, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { useFollowingUpdates } from '../../context/FollowingUpdatesContext';
import { useLanguage } from '../../context/LanguageContext';
import { RotateCw, Search, Layers, Newspaper, UserCheck } from 'lucide-react';
import ThemeToggle from './ThemeToggle';
import './Navbar.css';

export default function Navbar({ onOpenSearch = () => {}, searchOpen = false }) {
  const { user, profilePhoto } = useAuth();
  const { feedMode, setFeedMode, refreshFeed, isRefreshing } = useFeed();
  const { refresh: refreshFollowing, refreshing: isFollowingRefreshing } = useFollowingUpdates();
  const { isEnglish } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const pathname = location.pathname === '/' ? '/' : location.pathname.replace(/\/+$/, '');
  const [isReportRefreshing, setIsReportRefreshing] = useState(false);

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

  useEffect(() => {
    const onStart = () => setIsReportRefreshing(true);
    const onEnd = () => setIsReportRefreshing(false);
    window.addEventListener('reportLoadingStart', onStart);
    window.addEventListener('reportLoadingEnd', onEnd);
    return () => {
      window.removeEventListener('reportLoadingStart', onStart);
      window.removeEventListener('reportLoadingEnd', onEnd);
    };
  }, []);

  const isFollowingActive = pathname === '/following';
  const isResearchActive = pathname === '/research' || pathname === '/report';
  const isHomeActive = pathname === '/';

  const showReloadButton = isHomeActive || isResearchActive || isFollowingActive;
  const reloadSpinning = (isHomeActive && isRefreshing)
    || (isResearchActive && isReportRefreshing)
    || (isFollowingActive && isFollowingRefreshing);

  const handleReload = () => {
    if (isHomeActive) refreshFeed();
    else if (isResearchActive) window.dispatchEvent(new Event('refreshScientificReport'));
    else if (isFollowingActive) refreshFollowing();
  };

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
          {showReloadButton && (
            <button
              className={`navbar-icon-btn ${reloadSpinning ? 'spinning' : ''}`}
              onClick={handleReload}
              title={isEnglish ? 'Reload' : 'Recargar'}
              aria-label={isEnglish ? 'Reload' : 'Recargar'}
            >
              <RotateCw size={17} />
            </button>
          )}

          <button
            className={`navbar-icon-btn navbar-icon-btn--search-compact ${searchOpen ? 'is-open' : ''}`}
            aria-expanded={searchOpen}
            onClick={onOpenSearch}
            title={isEnglish ? 'Search' : 'Buscar'}
            aria-label={isEnglish ? 'Search' : 'Buscar'}
          >
            <Search size={17} />
          </button>

          {/* Rule 6: utilities cluster on the right, behind the 1px rule. The
              theme belongs with reload, not with the feeds — it changes how the
              app looks, not what it is showing. */}
          <ThemeToggle />

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
                  <img src={profilePhoto || user.photoURL} alt="Profile" className="navbar-avatar" referrerPolicy="no-referrer" />
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
