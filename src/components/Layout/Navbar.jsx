import { useState, useRef, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import './Navbar.css';

export default function Navbar() {
  const { user, signOut } = useAuth();
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef(null);
  const navigate = useNavigate();

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  return (
    <>
      {/* Desktop top navbar */}
      <nav className="navbar glass-strong">
        <NavLink to="/" className="navbar-logo">
          <span className="gradient-text">Paper</span>
          <span>Tok</span>
        </NavLink>

        <div className="navbar-right">
          <NavLink to="/" className={({ isActive }) => `navbar-link ${isActive ? 'navbar-link--active' : ''}`} end>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            <span>Feed</span>
          </NavLink>

          <NavLink to="/lists" className={({ isActive }) => `navbar-link ${isActive ? 'navbar-link--active' : ''}`}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
            <span>Listas</span>
          </NavLink>

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
                  onClick={() => { navigate('/onboarding'); setShowDropdown(false); }}
                >
                  🎯 Editar intereses
                </button>
                <button
                  className="navbar-dropdown-item navbar-dropdown-item--danger"
                  onClick={handleSignOut}
                >
                  🚪 Cerrar sesión
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* Mobile bottom navbar */}
      <nav className="navbar-mobile glass-strong">
        <NavLink to="/" className={({ isActive }) => `navbar-mobile-link ${isActive ? 'navbar-mobile-link--active' : ''}`} end>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
          <span>Feed</span>
        </NavLink>

        <NavLink to="/lists" className={({ isActive }) => `navbar-mobile-link ${isActive ? 'navbar-mobile-link--active' : ''}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
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
    </>
  );
}
