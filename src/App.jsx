import { useCallback, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
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
import GuestFeedPage from './components/Public/GuestFeedPage'
import AuthPrompt from './components/Public/AuthPrompt'
import PublicPaperPage from './components/Public/PublicPaperPage'
import PublicListPage from './components/Lists/PublicListPage'
import PublicProfilePage from './components/Public/PublicProfilePage'
import ProfilePage from './components/Profile/ProfilePage'
import { getPublicPaperPath } from './utils/publicNavigation'
import './App.css'

function AppContent() {
  const [pdfPaper, setPdfPaper] = useState(null)
  const [saveModalPaper, setSaveModalPaper] = useState(null)
  const [guestFeedReady, setGuestFeedReady] = useState(false)
  const [authPromptOpen, setAuthPromptOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const { user, loading: authLoading, onboardingComplete, profileLoadError } = useAuth()
  const normalizedPathname = location.pathname === '/' ? '/' : location.pathname.replace(/\/+$/, '')
  const navbarRoutes = ['/', '/lists', '/research', '/following', '/settings', '/settings/following', '/settings/profile']
  const showNavbar = navbarRoutes.includes(normalizedPathname)
    && Boolean(user)
    && !authLoading
    && onboardingComplete
    && !profileLoadError

  const requestAuthentication = useCallback(() => {
    setAuthPromptOpen(true)
  }, [])

  const continueToAuthentication = useCallback(() => {
    setAuthPromptOpen(false)
    const returnTo = `${location.pathname}${location.search}`
    navigate('/login', { state: { returnTo } })
  }, [location.pathname, location.search, navigate])

  return (
    <FeedProvider>
      {showNavbar && <Navbar />}
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
              authLoading || user ? (
                <ProtectedRoute>
                  <PageTransition>
                    <FeedContainer
                      onOpenPdf={setPdfPaper}
                      onSaveToList={setSaveModalPaper}
                    />
                  </PageTransition>
                </ProtectedRoute>
              ) : (
                <PageTransition>
                  <GuestFeedPage
                    onReady={setGuestFeedReady}
                    onAuthRequired={requestAuthentication}
                    onOpenPdf={setPdfPaper}
                  />
                </PageTransition>
              )
            }
          />
          <Route
            path="/lists"
            element={
              <ProtectedRoute>
                <PageTransition>
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
                  <SettingsPage />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings/profile"
            element={
              <PageTransition>
                <ProtectedRoute>
                  <ProfilePage />
                </ProtectedRoute>
              </PageTransition>
            }
          />
          <Route
            path="/settings/following"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <FollowingSettingsPage />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/explorer/:type/:id"
            element={
              <PageTransition>
                <EntityExplorer
                  publicMode={!user}
                  onAuthRequired={requestAuthentication}
                  onSaveToList={user ? setSaveModalPaper : requestAuthentication}
                />
              </PageTransition>
            }
          />
          <Route
            path="/public/entity/:type/:id"
            element={
              <PageTransition>
                <EntityExplorer
                  publicMode={!user}
                  onAuthRequired={requestAuthentication}
                  onSaveToList={user ? setSaveModalPaper : requestAuthentication}
                />
              </PageTransition>
            }
          />
          <Route
            path="/public/paper/:paperKey"
            element={
              <PageTransition>
                <PublicPaperPage
                  isAuthenticated={Boolean(user)}
                  onAuthRequired={requestAuthentication}
                  onOpenPdf={setPdfPaper}
                  onSaveToList={user ? setSaveModalPaper : requestAuthentication}
                />
              </PageTransition>
            }
          />
          <Route
            path="/public/user/:handle"
            element={
              <PageTransition>
                <PublicProfilePage onAuthRequired={requestAuthentication} />
              </PageTransition>
            }
          />
          <Route
            path="/public/list/:shareId"
            element={
              <PageTransition>
                <PublicListPage
                  buildPaperPath={getPublicPaperPath}
                  onAuthRequired={requestAuthentication}
                />
              </PageTransition>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AnimatePresence>

      <AnalyticsConsentBanner guestFeedReady={guestFeedReady} />

      <AnimatePresence>
        {authPromptOpen && (
          <AuthPrompt
            onClose={() => setAuthPromptOpen(false)}
            onContinue={continueToAuthentication}
          />
        )}
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
        </AnalyticsProvider>
      </LanguageProvider>
    </AuthProvider>
  )
}

export default App
