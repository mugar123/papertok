import { useState, useRef, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { useFollowingUpdates } from '../../context/FollowingUpdatesContext';
import { useLanguage } from '../../context/LanguageContext';
import { Bookmark, LogOut, Settings2, RotateCw, Search, Layers, Newspaper, UserCheck } from 'lucide-react';
import './Navbar.css';

export default function Navbar({ onOpenSearch = () => {} }) {
  const { user, profilePhoto, signOut } = useAuth();
  const { feedMode, setFeedMode, refreshFeed, isRefreshing } = useFeed();
  const { refresh: refreshFollowing, refreshing: isFollowingRefreshing } = useFollowingUpdates();
  const { isEnglish } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const pathname = location.pathname === '/' ? '/' : location.pathname.replace(/\/+$/, '');
  const [showDropdown, setShowDropdown] = useState(false);
  const [isReportRefreshing, setIsReportRefreshing] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

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
    <nav className="navbar">
      <div className="navbar-inner">
        <button
          type="button"
          className="navbar-brand"
          onClick={() => {
            setShowDropdown(false);
            if (location.pathname !== '/') navigate('/');
          }}
          aria-label="PaperTok"
        >
          <span className="navbar-brand-mark" aria-hidden="true">PT</span>
          <span className="navbar-brand-word">Paper<span>Tok</span></span>
        </button>

        <button
          type="button"
          className="navbar-search"
          onClick={() => { setShowDropdown(false); onOpenSearch(); }}
        >
          <Search size={15} aria-hidden="true" />
          <span>{isEnglish ? 'Search papers, authors, topics...' : 'Buscar papers, autores, temas...'}</span>
          <kbd aria-hidden="true">/</kbd>
        </button>

        <div className="navbar-links">
          <button
            type="button"
            className={`navbar-link ${isHomeActive && feedMode === 'top' ? 'active' : ''}`}
            onClick={() => {
              setShowDropdown(false);
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
            onClick={() => setShowDropdown(false)}
          >
            <Newspaper size={15} aria-hidden="true" />
            Research
          </NavLink>

          <NavLink
            to="/following"
            className={`navbar-link ${isFollowingActive ? 'active' : ''}`}
            onClick={() => setShowDropdown(false)}
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
            className="navbar-icon-btn navbar-icon-btn--search-compact"
            onClick={() => { setShowDropdown(false); onOpenSearch(); }}
            title={isEnglish ? 'Search' : 'Buscar'}
            aria-label={isEnglish ? 'Search' : 'Buscar'}
          >
            <Search size={17} />
          </button>

          {user && (
            <div className="navbar-profile" ref={dropdownRef}>
              <button
                className={`navbar-avatar-btn ${location.pathname === '/settings' ? 'active' : ''}`}
                aria-label={isEnglish ? 'Open user menu' : 'Abrir menú de usuario'}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowDropdown(!showDropdown);
                }}
              >
                {profilePhoto || user.photoURL ? (
                  <img src={profilePhoto || user.photoURL} alt="Profile" className="navbar-avatar" referrerPolicy="no-referrer" />
                ) : (
                  <div className="navbar-avatar navbar-avatar--fallback">
                    {user.email?.charAt(0).toUpperCase() || 'U'}
                  </div>
                )}
              </button>

              {showDropdown && (
                <div className="navbar-dropdown">
                  <div className="navbar-dropdown-header">
                    <p className="navbar-dropdown-name">{user?.displayName}</p>
                    <p className="navbar-dropdown-email">{user?.email}</p>
                  </div>
                  <div className="navbar-dropdown-divider" />
                  <button
                    className="navbar-dropdown-item"
                    onClick={() => { navigate('/lists'); setShowDropdown(false); }}
                  >
                    <Bookmark size={15} strokeWidth={2} aria-hidden="true" />
                    {isEnglish ? 'My lists' : 'Mis listas'}
                  </button>
                  <button
                    className="navbar-dropdown-item"
                    onClick={() => { navigate('/settings'); setShowDropdown(false); }}
                  >
                    <Settings2 size={15} strokeWidth={2} aria-hidden="true" />
                    {isEnglish ? 'Settings' : 'Ajustes'}
                  </button>
                  <div className="navbar-dropdown-divider" />
                  <button
                    className="navbar-dropdown-item navbar-dropdown-item--danger"
                    onClick={handleSignOut}
                  >
                    <LogOut size={15} strokeWidth={2} aria-hidden="true" />
                    {isEnglish ? 'Sign out' : 'Cerrar sesión'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
