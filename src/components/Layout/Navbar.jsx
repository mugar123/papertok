import { useState, useRef, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { useFollowingUpdates } from '../../context/FollowingUpdatesContext';
import { useLanguage } from '../../context/LanguageContext';
import { Bookmark, LogOut, Settings2, RotateCw, Search } from 'lucide-react';
import './Navbar.css';

export default function Navbar() {
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
    navigate('/login');
  };

  const isFollowingActive = pathname === '/following';
  const isResearchActive = pathname === '/research' || pathname === '/report';
  const isHomeActive = pathname === '/';

  let sliderTransform = 'translateX(0)';
  if (isResearchActive) {
    sliderTransform = 'translateX(100%)';
  } else if (isFollowingActive) {
    sliderTransform = 'translateX(200%)';
  }

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
    <>
      <nav className="navbar glass-strong">
        <div className="navbar-left">
          {showReloadButton && (
            <button
              className={`navbar-action-btn ${reloadSpinning ? 'spinning' : ''}`}
              onClick={handleReload}
              title={isEnglish ? 'Reload' : 'Recargar'}
            >
              <RotateCw size={20} />
            </button>
          )}
        </div>

        <div className="navbar-center-pill">
          <button
            className={`navbar-tab ${isHomeActive && feedMode === 'top' ? 'active' : ''}`}
            onClick={() => {
              setShowDropdown(false);
              if (location.pathname !== '/') navigate('/');
              setFeedMode('top');
            }}
          >
            {isEnglish ? 'For you' : 'Para ti'}
          </button>

          <NavLink
            to="/research"
            className={`navbar-tab ${isResearchActive ? 'active' : ''}`}
            onClick={() => setShowDropdown(false)}
          >
            Research
          </NavLink>

          <NavLink
            to="/following"
            className={`navbar-tab ${isFollowingActive ? 'active' : ''}`}
            onClick={() => setShowDropdown(false)}
          >
            {isEnglish ? 'Following' : 'Siguiendo'}
          </NavLink>

          {/* Slider indicator */}
          <div
            className={`navbar-slider ${!isHomeActive && !isResearchActive && !isFollowingActive ? 'is-hidden' : ''}`}
            style={{
              transform: sliderTransform
            }}
          />
        </div>

        <div className="navbar-right">
          <button
            className="navbar-action-btn"
            onClick={() => { setShowDropdown(false); navigate('/search'); }}
            title={isEnglish ? 'Search' : 'Buscar'}
          >
            <Search size={20} />
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
                    <Bookmark size={16} strokeWidth={2} style={{ display: 'inline-block', verticalAlign: 'text-bottom', marginRight: '8px' }} />
                    {isEnglish ? 'My lists' : 'Mis listas'}
                  </button>
                  <button
                    className="navbar-dropdown-item"
                    onClick={() => { navigate('/settings'); setShowDropdown(false); }}
                  >
                    <Settings2 size={16} strokeWidth={2} style={{ display: 'inline-block', verticalAlign: 'text-bottom', marginRight: '8px' }} />
                    {isEnglish ? 'Settings' : 'Ajustes'}
                  </button>
                  <button
                    className="navbar-dropdown-item navbar-dropdown-item--danger"
                    onClick={handleSignOut}
                  >
                    <LogOut size={16} strokeWidth={2} style={{ display: 'inline-block', verticalAlign: 'text-bottom', marginRight: '8px' }} />
                    {isEnglish ? 'Sign out' : 'Cerrar sesión'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </nav>

    </>
  );
}
