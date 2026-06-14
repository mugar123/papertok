import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export default function ProtectedRoute({ children, requireOnboarding = true }) {
  const { user, loading, onboardingComplete } = useAuth();

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner-large" />
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
          .loading-spinner-large {
            width: 48px;
            height: 48px;
            border: 3px solid var(--border-default);
            border-top-color: var(--accent-primary);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
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
