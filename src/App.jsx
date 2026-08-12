import { useState } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import PageTransition from './components/Layout/PageTransition'
import { AuthProvider, useAuth } from './context/AuthContext'
import { LanguageProvider } from './context/LanguageContext'
import { AnalyticsProvider } from './context/AnalyticsContext'
import { FeedProvider } from './context/FeedContext'
import { FollowingProvider } from './context/FollowingContext'
import { FollowingUpdatesProvider } from './context/FollowingUpdatesContext'
import { EmailNotificationsProvider } from './context/EmailNotificationsContext'
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
import ScientificReport from './components/Report/ScientificReport'
import FollowingFeedPage from './components/Following/FollowingFeedPage'
import SettingsPage from './components/Settings/SettingsPage'
import FollowingSettingsPage from './components/Settings/FollowingSettingsPage'
import AnalyticsConsentBanner from './components/Privacy/AnalyticsConsentBanner'
import './App.css'

function AppContent() {
  const [pdfPaper, setPdfPaper] = useState(null)
  const [saveModalPaper, setSaveModalPaper] = useState(null)
  const location = useLocation()

    return (
      <FeedProvider>
        <AnimatePresence mode="wait" initial={false}>
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
                  <ListsPage onOpenPdf={setPdfPaper} onEditPaper={setSaveModalPaper} />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/research"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <Navbar />
                  <ScientificReport
                    onOpenPdf={setPdfPaper}
                    onSaveToList={setSaveModalPaper}
                  />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          {/* Legacy Novedades/Reporte links keep working. */}
          <Route path="/report" element={<Navigate to="/research" replace />} />
          <Route
            path="/following"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <Navbar />
                  <FollowingFeedPage
                    onOpenPdf={setPdfPaper}
                    onSaveToList={setSaveModalPaper}
                  />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/search"
            element={
              <ProtectedRoute>
                <PageTransition><SearchPage onSaveToList={setSaveModalPaper} /></PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <Navbar />
                  <SettingsPage />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings/following"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <Navbar />
                  <FollowingSettingsPage />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/explorer/:type/:id"
            element={
              <ProtectedRoute>
                <PageTransition><EntityExplorer onSaveToList={setSaveModalPaper} /></PageTransition>
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

function UserScopedAppContent() {
  const { user } = useAuth()
  return (
    <FollowingProvider key={user?.uid || 'signed-out'}>
      <FollowingUpdatesProvider>
        <EmailNotificationsProvider>
          <AppContent />
        </EmailNotificationsProvider>
      </FollowingUpdatesProvider>
    </FollowingProvider>
  )
}

function App() {
  return (
    <AuthProvider>
      <LanguageProvider>
        <AnalyticsProvider>
          <UserScopedAppContent />
          <AnalyticsConsentBanner />
        </AnalyticsProvider>
      </LanguageProvider>
    </AuthProvider>
  )
}

export default App
