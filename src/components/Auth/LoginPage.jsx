import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { FileText, Bookmark, Microscope, FlaskConical, Atom, Dna, Brain, Cpu, Database, Orbit, Network, Activity } from 'lucide-react';
import './LoginPage.css';

const FLOATING_ICONS = [FileText, Bookmark, Microscope, FlaskConical, Atom, Dna, Brain, Cpu, Database, Orbit, Network, Activity];

export default function LoginPage() {
  const { signInWithGoogle, error, user, onboardingComplete } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  // Redirect if already authenticated
  useEffect(() => {
    if (user) {
      if (onboardingComplete) {
        navigate('/', { replace: true });
      } else {
        navigate('/onboarding', { replace: true });
      }
    }
  }, [user, onboardingComplete, navigate]);

  const handleSignIn = async () => {
    setIsLoading(true);
    await signInWithGoogle();
    setIsLoading(false);
  };

  const floatingElements = useMemo(() => {
    return Array.from({ length: 25 }).map((_, i) => {
      const Icon = FLOATING_ICONS[i % FLOATING_ICONS.length];
      const x = Math.floor(Math.random() * 100);
      const y = Math.floor(Math.random() * 100);
      const delay = (Math.random() * 5).toFixed(2);
      const size = Math.floor(Math.random() * 24) + 20; // 20 to 44
      const opacity = (Math.random() * 0.15 + 0.05).toFixed(2); // 0.05 to 0.20
      const duration = (Math.random() * 4 + 8).toFixed(2); // 8s to 12s
      return { id: i, Icon, x, y, delay, size, opacity, duration };
    });
  }, []);

  return (
    <div className="login-page">
      {/* Animated background */}
      <div className="login-bg">
        <div className="login-bg-orb login-bg-orb--1" />
        <div className="login-bg-orb login-bg-orb--2" />
        <div className="login-bg-orb login-bg-orb--3" />
      </div>

      {/* Floating paper icons */}
      <div className="floating-papers">
        {floatingElements.map((el) => (
          <span
            key={el.id}
            className="floating-paper"
            style={{
              '--delay': `${el.delay}s`,
              '--duration': `${el.duration}s`,
              '--x': `${el.x}%`,
              '--y': `${el.y}%`,
              color: `rgba(255,255,255,${el.opacity})`,
            }}
          >
            <el.Icon size={el.size} />
          </span>
        ))}
      </div>

      {/* Main content */}
      <div className="login-content">
        <div className="login-logo">
          <h1 className="login-wordmark">
            <span className="gradient-text">Paper</span>
            <span className="login-tok">Tok</span>
          </h1>
        </div>

        <p className="login-tagline">
          Descubre papers científicos<br />como nunca antes
        </p>

        <p className="login-description">
          Un feed personalizado estilo TikTok con los papers más recientes de arXiv.
          Desliza, explora y construye tu biblioteca científica.
        </p>

        <button
          className={`login-google-btn ${isLoading ? 'login-google-btn--loading' : ''}`}
          onClick={handleSignIn}
          disabled={isLoading}
          id="google-sign-in-btn"
        >
          {isLoading ? (
            <div className="login-spinner" />
          ) : (
            <>
              <svg className="login-google-icon" viewBox="0 0 24 24" width="24" height="24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              <span>Continuar con Google</span>
            </>
          )}
        </button>

        {error && <p className="login-error">{error}</p>}

        <p className="login-powered">
          Powered by <strong>arXiv</strong>
        </p>
      </div>
    </div>
  );
}
