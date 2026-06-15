import { useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
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
import './App.css'

function AppContent() {
  const [pdfPaper, setPdfPaper] = useState(null)
  const [saveModalPaper, setSaveModalPaper] = useState(null)

  return (
    <FeedProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/onboarding"
          element={
            <ProtectedRoute requireOnboarding={false}>
              <OnboardingFlow />
            </ProtectedRoute>
          }
        />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Navbar />
              <FeedContainer
                onOpenPdf={setPdfPaper}
                onSaveToList={setSaveModalPaper}
              />
            </ProtectedRoute>
          }
        />
        <Route
          path="/lists"
          element={
            <ProtectedRoute>
              <Navbar />
              <ListsPage onOpenPdf={setPdfPaper} />
            </ProtectedRoute>
          }
        />
        <Route
          path="/search"
          element={
            <ProtectedRoute>
              <SearchPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

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
