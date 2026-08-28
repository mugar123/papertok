import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import PageTransition from './components/Layout/PageTransition'
import RouteFallback from './components/Layout/RouteFallback'
import { AuthProvider, useAuth } from './context/AuthContext'
import { LanguageProvider, useLanguage } from './context/LanguageContext'
import { ThemeProvider } from './context/ThemeContext'
import { AnalyticsProvider } from './context/AnalyticsContext'
import { FeedProvider } from './context/FeedContext'
import { FollowingProvider } from './context/FollowingContext'
import { FollowingUpdatesProvider } from './context/FollowingUpdatesContext'
import { EmailNotificationsProvider } from './context/EmailNotificationsContext'
import ProtectedRoute from './components/Auth/ProtectedRoute'
import FeedContainer from './components/Feed/FeedContainer'
import Navbar from './components/Layout/Navbar'
import SearchCommand from './components/Search/SearchCommand'
import AnalyticsConsentBanner from './components/Privacy/AnalyticsConsentBanner'
import GuestFeedPage from './components/Public/GuestFeedPage'
import AuthPrompt from './components/Public/AuthPrompt'
import { getPublicPaperPath } from './utils/publicNavigation'
import './App.css'

// Only what the first paint of the feed needs loads eagerly. Everything below
// is its own chunk: the 2 MB single bundle was the measured cost of every
// screen riding in the boot graph (25 static screens, 0.9–1.3 s of parse), and
// React Router v7 navigations run inside startTransition, so switching to a
// route whose chunk is still downloading keeps the current screen on instead
// of flashing a fallback.

// The sign-in page rides in that same list rather than in the boot graph, as it
// used to: a session that already exists never renders it, and a guest reaches
// it by a redirect or a direct link — both can afford one chunk.
const LoginPage = lazy(() => import('./components/Auth/LoginPage'))
const OnboardingFlow = lazy(() => import('./components/Onboarding/OnboardingFlow'))
const ListsPage = lazy(() => import('./components/Lists/ListsPage'))
const PDFViewer = lazy(() => import('./components/PDF/PDFViewer'))
const SaveToListModal = lazy(() => import('./components/Lists/SaveToListModal'))
const CommentsSheet = lazy(() => import('./components/Comments/CommentsSheet'))
const SearchPage = lazy(() => import('./components/Search/SearchPage'))
const EntityExplorer = lazy(() => import('./components/Explorer/EntityExplorer'))
const ScientificReport = lazy(() => import('./components/Report/ScientificReport'))
const FollowingFeedPage = lazy(() => import('./components/Following/FollowingFeedPage'))
const SettingsPage = lazy(() => import('./components/Settings/SettingsPage'))
const FollowingSettingsPage = lazy(() => import('./components/Settings/FollowingSettingsPage'))
const MyCommentsPage = lazy(() => import('./components/Settings/MyCommentsPage'))
const ModerationPage = lazy(() => import('./components/Admin/ModerationPage'))
const PublicPaperPage = lazy(() => import('./components/Public/PublicPaperPage'))
const PublicListPage = lazy(() => import('./components/Lists/PublicListPage'))
const PublicProfilePage = lazy(() => import('./components/Public/PublicProfilePage'))
const ProfilePage = lazy(() => import('./components/Profile/ProfilePage'))

function AppContent() {
  const [pdfPaper, setPdfPaper] = useState(null)
  const [saveModalPaper, setSaveModalPaper] = useState(null)
  // The comment sheet is hosted here, next to the PDF viewer and the save
  // modal, for the same reason those are: the feed hands over a paper and
  // nothing else, so no social service ever enters the feed's module graph
  // and a feed load keeps costing one read.
  const [commentsPaper, setCommentsPaper] = useState(null)
  const [guestFeedReady, setGuestFeedReady] = useState(false)
  const [authPromptOpen, setAuthPromptOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const location = useLocation()
  const { user, loading: authLoading, onboardingComplete, profileLoadError } = useAuth()
  const { isEnglish } = useLanguage()
  const normalizedPathname = location.pathname === '/' ? '/' : location.pathname.replace(/\/+$/, '')
  const navbarRoutes = ['/', '/lists', '/research', '/following', '/profile', '/settings', '/settings/following', '/settings/profile', '/settings/comments']
  // The paper, profile and list pages keep the app chrome for a signed-in user —
  // reaching a paper from Liked, a profile from the follow sheet, or a list from
  // someone's shared link, must not feel like leaving the app. Signed-out
  // visitors on a shared link still get the standalone page (`user` gates below).
  const showNavbar = (navbarRoutes.includes(normalizedPathname)
    || normalizedPathname.startsWith('/public/paper/')
    || normalizedPathname.startsWith('/public/user/')
    || normalizedPathname.startsWith('/public/list/'))
    && Boolean(user)
    && !authLoading
    && onboardingComplete
    && !profileLoadError

  const requestAuthentication = useCallback(() => {
    setAuthPromptOpen(true)
  }, [])

  // Warm the chunks a session is most likely to need next — the three
  // overlays any card can open, and the other navbar feeds — once the first
  // screen has had the network and the main thread to itself for a while.
  // Skipped on a connection that says it is paying for every byte: Save-Data
  // or an effective 2G link. `navigator.connection` is absent in Safari, and
  // an unknown connection prefetches as before — guessing "slow" for every
  // iPhone would cost more than it saves.
  useEffect(() => {
    const prefetch = () => {
      const conn = navigator.connection
      const frugal = conn && (conn.saveData || /2g/.test(conn.effectiveType || ''))
      if (frugal) return
      import('./components/Comments/CommentsSheet').catch(() => {})
      import('./components/PDF/PDFViewer').catch(() => {})
      import('./components/Lists/SaveToListModal').catch(() => {})
      import('./components/Report/ScientificReport').catch(() => {})
      import('./components/Following/FollowingFeedPage').catch(() => {})
    }
    const schedule = window.requestIdleCallback || (fn => setTimeout(fn, 0))
    const timer = setTimeout(() => schedule(prefetch), 2500)
    return () => clearTimeout(timer)
  }, [])

  return (
    <FeedProvider feedRouteActive={normalizedPathname === '/'}>
      {showNavbar && <Navbar searchOpen={searchOpen} onOpenSearch={() => setSearchOpen(true)} />}
      <Suspense fallback={<RouteFallback />}>
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
                      onOpenComments={setCommentsPaper}
                    />
                  </PageTransition>
                </ProtectedRoute>
              ) : (
                <PageTransition>
                  <GuestFeedPage
                    onReady={setGuestFeedReady}
                    onAuthRequired={requestAuthentication}
                    onOpenPdf={setPdfPaper}
                    onOpenComments={setCommentsPaper}
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
                    onOpenComments={setCommentsPaper}
                  />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          {/* One search box. Papers, institutions, topics and projects come
              from OpenAlex and OpenAIRE over HTTP; people come from
              `userSearch/` in Firestore, behind a session the rules require of
              the query itself. The Users pill filters this page rather than
              leaving it, and it is also the spend gate: with any other filter
              selected, no Firestore query is issued. */}
          <Route
            path="/search"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <SearchPage
                    onSaveToList={setSaveModalPaper}
                    onAuthRequired={requestAuthentication}
                  />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          {/* The standalone /search/users page is gone, not redirected: F9's UI
              was never deployed, so no link to it exists anywhere. */}
          {/* The user's own profile: the same page as /public/user/:handle,
              in owner mode. It renders even before a public profile exists. */}
          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <PublicProfilePage selfMode />
                </PageTransition>
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
            path="/settings/comments"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <MyCommentsPage />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          {/* Unlisted, not secret: the rules deny the queue to any uid that
              is not the admin's, and the page says so. */}
          <Route
            path="/admin/moderation"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <ModerationPage />
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
      </Suspense>

      {user && <SearchCommand open={searchOpen} onOpenChange={setSearchOpen} />}

      <AnalyticsConsentBanner guestFeedReady={guestFeedReady} />

      <AnimatePresence>
        {authPromptOpen && (
          <AuthPrompt
            onClose={() => setAuthPromptOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Each overlay suspends on its own: while its chunk downloads (idle
          prefetch usually has it already) nothing flashes, and the rest of
          the screen stays interactive. */}
      <Suspense fallback={null}>
        <AnimatePresence>
          {commentsPaper && (
            <CommentsSheet
              paper={commentsPaper}
              isAuthenticated={Boolean(user)}
              isEnglish={isEnglish}
              onClose={() => setCommentsPaper(null)}
              onAuthRequired={requestAuthentication}
            />
          )}
        </AnimatePresence>
      </Suspense>

      <Suspense fallback={null}>
        {pdfPaper && (
          <PDFViewer paper={pdfPaper} onClose={() => setPdfPaper(null)} />
        )}
      </Suspense>

      <Suspense fallback={null}>
        {saveModalPaper && (
          <SaveToListModal
            paper={saveModalPaper}
            onClose={() => setSaveModalPaper(null)}
          />
        )}
      </Suspense>
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
    <ThemeProvider>
      <AuthProvider>
        <LanguageProvider>
          <AnalyticsProvider>
            <UserScopedAppContent />
          </AnalyticsProvider>
        </LanguageProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}

export default App
