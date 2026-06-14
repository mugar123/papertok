import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import AnimatedAtom from '../Feed/AnimatedAtom';

export default function ProtectedRoute({ children, requireOnboarding = true }) {
  const { user, loading, onboardingComplete } = useAuth();

  if (loading) {
    return (
      <div className="loading-screen">
        <AnimatedAtom size={80} strokeWidth={1} className="loading-atom" />
        <p className="loading-text">Cargando...</p>
        <style>{`
          .loading-screen {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            min-height: 100dvh;
            background: var(--bg-primary);
            gap: var(--space-4);
          }
          .loading-atom {
            color: var(--accent-primary);
            filter: drop-shadow(0 0 15px var(--accent-primary));
            animation: pulseAtom 2s infinite alternate ease-in-out;
          }
          @keyframes pulseAtom {
            0% { transform: scale(0.95); filter: drop-shadow(0 0 10px var(--accent-primary)); }
            100% { transform: scale(1.05); filter: drop-shadow(0 0 25px var(--accent-primary)); }
          }
          .loading-text {
            color: var(--text-secondary);
            font-size: var(--fs-sm);
          }
        `}</style>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (requireOnboarding && !onboardingComplete) {
    return <Navigate to="/onboarding" replace />;
  }

  return children;
}
