import React from 'react';
import { trackAppCrash } from './services/analyticsService.ts';
import { captureAppException } from './services/errorTracking.ts';

const COPY = {
  title: 'Something went wrong',
  body: 'PaperTok could not complete this action. Reload the page to try again.',
  retry: 'Reload',
  details: 'Technical details',
};

export default class GlobalErrorBoundary extends React.Component<React.PropsWithChildren, { hasError: boolean; error: Error | null; errorInfo: React.ErrorInfo | null }> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ errorInfo });
    console.error("Uncaught error:", error, errorInfo);
    void trackAppCrash();
    void captureAppException(error);
  }

  render() {
    if (this.state.hasError) {
      const copy = COPY;
      return (
        <div style={{ padding: '24px', background: '#0c0b10', color: '#f6f4fb', zIndex: 99999, position: 'fixed', inset: 0, overflow: 'auto', display: 'grid', placeItems: 'center', textAlign: 'center', fontFamily: 'Inter, system-ui, sans-serif' }}>
          <div style={{ maxWidth: '560px' }}>
            <h2 style={{ marginBottom: '10px' }}>{copy.title}</h2>
            <p style={{ color: '#a7a2b3', lineHeight: 1.6 }}>{copy.body}</p>
            <button type="button" onClick={() => window.location.reload()} style={{ marginTop: '16px', padding: '11px 18px', border: '1px solid #6d45bb', borderRadius: '6px', background: '#7c3aed', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
              {copy.retry}
            </button>
            {import.meta.env.DEV && (
              <details style={{ marginTop: '28px', textAlign: 'left', color: '#a7a2b3' }}>
                <summary>{copy.details}</summary>
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{this.state.error?.stack}</pre>
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{this.state.errorInfo?.componentStack}</pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
