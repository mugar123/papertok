import { useState, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { useFollowingUpdates } from '../../context/FollowingUpdatesContext';
import { useLanguage } from '../../context/LanguageContext';
import { RotateCw, Search } from 'lucide-react';
import './Navbar.css';

export default function Navbar() {
  const { user, profilePhoto } = useAuth();
  const { feedMode, setFeedMode, refreshFeed, isRefreshing } = useFeed();
  const { refresh: refreshFollowing, refreshing: isFollowingRefreshing } = useFollowingUpdates();
  const { isEnglish } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const pathname = location.pathname === '/' ? '/' : location.pathname.replace(/\/+$/, '');
  const [isReportRefreshing, setIsReportRefreshing] = useState(false);

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
              if (location.pathname !== '/') navigate('/');
              setFeedMode('top');
            }}
          >
            {isEnglish ? 'For you' : 'Para ti'}
          </button>

          <NavLink
            to="/research"
            className={`navbar-tab ${isResearchActive ? 'active' : ''}`}
          >
            Research
          </NavLink>

          <NavLink
            to="/following"
            className={`navbar-tab ${isFollowingActive ? 'active' : ''}`}
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
            onClick={() => navigate('/search')}
            title={isEnglish ? 'Search' : 'Buscar'}
          >
            <Search size={20} />
          </button>

          {user && (
            <div className="navbar-profile">
              {/* Straight to the profile, TikTok-style: no menu in between.
                  Settings and sign-out live behind the gear on that page.
                  The navigation is synchronous on purpose — <Routes> sits
                  inside an AnimatePresence with mode="wait", and a navigate()
                  from an async continuation can leave it stalled. */}
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
      </nav>

    </>
  );
}
