import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App.jsx'
import GlobalErrorBoundary from './GlobalErrorBoundary.jsx'
// KaTeX's stylesheet ships with the on-demand KaTeX chunk (see
// components/ScientificText.js); loading it here put 23 KB of CSS in front of
// every first paint, math or no math.
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter>
      <GlobalErrorBoundary>
        <App />
      </GlobalErrorBoundary>
    </HashRouter>
  </React.StrictMode>,
)
