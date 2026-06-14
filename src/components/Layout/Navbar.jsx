import { useState, useRef, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { LogOut, Settings2, Bookmark, Home } from 'lucide-react';
import EditInterestsModal from '../Settings/EditInterestsModal';
import './Navbar.css';

export default function Navbar() {
  const { user, signOut } = useAuth();
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

  return (
    <>
      {/* Desktop top navbar */}
      <nav className="navbar glass-strong">
        <div className="navbar-left">
          <NavLink to="/" className="navbar-logo">
            <span className="gradient-text">Paper</span>
            <span className="logo-tok">Tok</span>
          </NavLink>
        </div>

        <div className="navbar-center">
          <NavLink to="/" className={({ isActive }) => `navbar-link ${isActive ? 'navbar-link--active' : ''}`} end>
            <Home size={20} />
            <span>Feed</span>
          </NavLink>

          <NavLink to="/lists" className={({ isActive }) => `navbar-link ${isActive ? 'navbar-link--active' : ''}`}>
            <Bookmark size={20} />
            <span>Listas</span>
          </NavLink>
        </div>

        <div className="navbar-right">
          {/* Profile */}
          <div className="navbar-profile" ref={dropdownRef}>
            <button
              className="navbar-avatar-btn"
              onClick={(e) => {
                e.stopPropagation();
                setShowDropdown(!showDropdown);
              }}
            >
              {user?.photoURL ? (
                <img src={user.photoURL} alt="" className="navbar-avatar" referrerPolicy="no-referrer" />
              ) : (
                <div className="navbar-avatar navbar-avatar--fallback">
                  {user?.displayName?.[0] || '?'}
                </div>
              )}
            </button>

            {showDropdown && (
              <div className="navbar-dropdown glass-strong">
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
        </div>
      </nav>

      {/* Mobile bottom navbar */}
      <nav className="navbar-mobile glass-strong">
        <NavLink to="/" className={({ isActive }) => `navbar-mobile-link ${isActive ? 'navbar-mobile-link--active' : ''}`} end>
          <Home size={24} />
          <span>Feed</span>
        </NavLink>

        <NavLink to="/lists" className={({ isActive }) => `navbar-mobile-link ${isActive ? 'navbar-mobile-link--active' : ''}`}>
          <Bookmark size={24} />
          <span>Listas</span>
        </NavLink>

        <button
          className="navbar-mobile-link"
          onClick={() => setShowDropdown(!showDropdown)}
        >
          {user?.photoURL ? (
            <img src={user.photoURL} alt="" className="navbar-avatar navbar-avatar--small" referrerPolicy="no-referrer" />
          ) : (
            <div className="navbar-avatar navbar-avatar--small navbar-avatar--fallback">
              {user?.displayName?.[0] || '?'}
            </div>
          )}
          <span>Perfil</span>
        </button>
      </nav>

      <EditInterestsModal 
        isOpen={isEditInterestsOpen} 
        onClose={() => setIsEditInterestsOpen(false)} 
      />
    </>
  );
}
