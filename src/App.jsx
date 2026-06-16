import { useState } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import PageTransition from './components/Layout/PageTransition'
import { AuthProvider } from './context/AuthContext'
import { FeedProvider } from './context/FeedContext'
import LoginPage from './components/Auth/LoginPage'
import ProtectedRoute from './components/Auth/ProtectedRoute'
import OnboardingFlow from './components/Onboarding/OnboardingFlow'
import FeedContainer from './components/Feed/FeedContainer'
import ListsPage from './components/Lists/ListsPage'
import Navbar from './components/Layout/Navbar'
import PDFViewer from './components/PDF/PDFViewer'
import SaveToListModal from './components/Lists/SaveToListModal'
import SearchPage from './components/Search/SearchPage'
import EntityExplorer from './components/Explorer/EntityExplorer'
import './App.css'

function AppContent() {
  const [pdfPaper, setPdfPaper] = useState(null)
  const [saveModalPaper, setSaveModalPaper] = useState(null)
  const location = useLocation()

  return (
    <FeedProvider>
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/login" element={<PageTransition><LoginPage /></PageTransition>} />
          <Route
            path="/onboarding"
            element={
              <ProtectedRoute requireOnboarding={false}>
                <PageTransition><OnboardingFlow /></PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <Navbar />
                  <FeedContainer
                    onOpenPdf={setPdfPaper}
                    onSaveToList={setSaveModalPaper}
                  />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/lists"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <Navbar />
                  <ListsPage onOpenPdf={setPdfPaper} />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/search"
            element={
              <ProtectedRoute>
                <PageTransition><SearchPage /></PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/explorer/:type/:id"
            element={
              <ProtectedRoute>
                <PageTransition><EntityExplorer /></PageTransition>
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AnimatePresence>

      {pdfPaper && (
        <PDFViewer paper={pdfPaper} onClose={() => setPdfPaper(null)} />
      )}

      {saveModalPaper && (
        <SaveToListModal
          paper={saveModalPaper}
          onClose={() => setSaveModalPaper(null)}
        />
      )}
    </FeedProvider>
  )
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}

export default App
