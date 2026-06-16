import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App.jsx'
import GlobalErrorBoundary from './GlobalErrorBoundary.jsx'
import 'katex/dist/katex.min.css'
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
