import { useState, useRef, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { useFollowingUpdates } from '../../context/FollowingUpdatesContext';
import { Inbox, LogOut, Settings2, RotateCw, Search } from 'lucide-react';
import EditInterestsModal from '../Settings/EditInterestsModal';
import './Navbar.css';

export default function Navbar() {
  const { user, signOut } = useAuth();
  const { feedMode, setFeedMode, refreshFeed, isRefreshing } = useFeed();
  const { unreadCount } = useFollowingUpdates();
  const navigate = useNavigate();
  const location = useLocation();
  const [showDropdown, setShowDropdown] = useState(false);
  const [isEditInterestsOpen, setIsEditInterestsOpen] = useState(false);
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

  const handleRefresh = () => {
    refreshFeed();
  };

  const isReportActive = location.pathname === '/report';
  const isListsActive = location.pathname === '/lists';
  const isHomeActive = location.pathname === '/';
  const isFollowingActive = location.pathname === '/following';

  let sliderTransform = 'translateX(0)';
  if (isReportActive) {
    sliderTransform = 'translateX(100%)';
  } else if (isListsActive) {
    sliderTransform = 'translateX(200%)';
  }

  return (
    <>
      <nav className="navbar glass-strong">
        <div className="navbar-left">
          {(isHomeActive || isReportActive) && (
            <button 
              className={`navbar-action-btn ${(isHomeActive && isRefreshing) || (isReportActive && isReportRefreshing) ? 'spinning' : ''}`}
              onClick={() => {
                if (isHomeActive) handleRefresh();
                if (isReportActive) window.dispatchEvent(new Event('refreshScientificReport'));
              }}
              title="Recargar"
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
            Para ti
          </button>
          
          <NavLink 
            to="/report" 
            className={`navbar-tab ${isReportActive ? 'active' : ''}`}
          >
            Reporte
          </NavLink>

          <NavLink 
            to="/lists" 
            className={`navbar-tab ${isListsActive ? 'active' : ''}`}
          >
            Listas
          </NavLink>
          
          {/* Slider indicator */}
          <div 
            className="navbar-slider" 
            style={{ 
              transform: sliderTransform
            }} 
          />
        </div>

        <div className="navbar-right">
          <button
            className={`navbar-action-btn navbar-inbox-btn ${isFollowingActive ? 'active' : ''}`}
            onClick={() => navigate('/following')}
            title="Novedades seguidas"
            aria-label={unreadCount ? `Novedades seguidas, ${unreadCount} sin ver` : 'Novedades seguidas'}
          >
            <Inbox size={20} />
            {unreadCount > 0 && <span className="navbar-inbox-count">{unreadCount > 99 ? '99+' : unreadCount}</span>}
          </button>
          <button 
            className="navbar-action-btn"
            onClick={() => navigate('/search')}
            title="Buscar"
          >
            <Search size={20} />
          </button>
          
          {user && (
            <div className="navbar-profile" ref={dropdownRef}>
              <button
                className="navbar-avatar-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowDropdown(!showDropdown);
                }}
              >
                {user.photoURL ? (
                  <img src={user.photoURL} alt="Profile" className="navbar-avatar" referrerPolicy="no-referrer" />
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
                    onClick={() => { setIsEditInterestsOpen(true); setShowDropdown(false); }}
                  >
                    <Settings2 size={16} strokeWidth={2} style={{ display: 'inline-block', verticalAlign: 'text-bottom', marginRight: '8px' }} />
                    Editar intereses
                  </button>
                  <button
                    className="navbar-dropdown-item navbar-dropdown-item--danger"
                    onClick={handleSignOut}
                  >
                    <LogOut size={16} strokeWidth={2} style={{ display: 'inline-block', verticalAlign: 'text-bottom', marginRight: '8px' }} />
                    Cerrar sesión
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </nav>

      <EditInterestsModal 
        isOpen={isEditInterestsOpen} 
        onClose={() => setIsEditInterestsOpen(false)} 
      />
    </>
  );
}
