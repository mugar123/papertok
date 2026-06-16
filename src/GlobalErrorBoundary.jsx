import React from 'react';

export default class GlobalErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', background: '#220000', color: '#ffaaaa', zIndex: 99999, position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'auto', fontFamily: 'monospace' }}>
          <h2>Application Error</h2>
          <p>Please take a screenshot of this error and share it!</p>
          <hr />
          <h3>{this.state.error?.toString()}</h3>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.error?.stack}</pre>
          <hr />
          <h4>Component Stack:</h4>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.errorInfo?.componentStack}</pre>
        </div>
      );
    }

    return this.props.children;
  }
}
