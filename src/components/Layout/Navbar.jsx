import { useState, useRef, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { LogOut, Settings2, RotateCw } from 'lucide-react';
import EditInterestsModal from '../Settings/EditInterestsModal';
import './Navbar.css';

export default function Navbar() {
  const { user, signOut } = useAuth();
  const { feedMode, setFeedMode, refreshFeed, isRefreshing } = useFeed();
  const navigate = useNavigate();
  const location = useLocation();
  const [showDropdown, setShowDropdown] = useState(false);
  const [isEditInterestsOpen, setIsEditInterestsOpen] = useState(false);
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

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  const handleRefresh = () => {
    refreshFeed();
  };

  const isListsActive = location.pathname === '/lists';

  return (
    <>
      <nav className="navbar glass-strong">
        <div className="navbar-left">
          {!isListsActive && (
            <button 
              className={`navbar-action-btn ${isRefreshing ? 'spinning' : ''}`}
              onClick={handleRefresh}
              title="Recargar"
            >
              <RotateCw size={20} />
            </button>
          )}
        </div>

        <div className="navbar-center-pill">
          <NavLink 
            to="/lists" 
            className={`navbar-tab ${isListsActive ? 'active' : ''}`}
          >
            Listas
          </NavLink>
          
          <button 
            className={`navbar-tab ${!isListsActive && feedMode === 'top' ? 'active' : ''}`}
            onClick={() => {
              if (isListsActive) navigate('/');
              setFeedMode('top');
            }}
          >
            Destacados
          </button>
          
          <button 
            className={`navbar-tab ${!isListsActive && feedMode === 'recent' ? 'active' : ''}`}
            onClick={() => {
              if (isListsActive) navigate('/');
              setFeedMode('recent');
            }}
          >
            Recientes
          </button>
          
          {/* Slider indicator */}
          <div 
            className="navbar-slider" 
            style={{ 
              transform: isListsActive 
                ? 'translateX(0)' 
                : (!isListsActive && feedMode === 'top') 
                  ? 'translateX(100%)' 
                  : 'translateX(200%)' 
            }} 
          />
        </div>

        <div className="navbar-right">
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
