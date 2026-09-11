import { Suspense, useCallback, useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import PageTransition from './components/Layout/PageTransition'
import { PageTransitionCustomProvider, usePageTransitionCustom } from './hooks/usePageTransitionCustom'
import { useOverlayHistory } from './hooks/useOverlayHistory.js'
import { safeExternalUrl } from './utils/externalUrl.js'
import { INITIAL_ACCOUNT_SCOPE, accountScopeKey, nextAccountScope } from './utils/accountScope.js'
import RouteFallback from './components/Layout/RouteFallback'
import RouteAnnouncer from './components/Layout/RouteAnnouncer'
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
import AnalyticsConsentBanner from './components/Privacy/AnalyticsConsentBanner'
import GuestFeedPage from './components/Public/GuestFeedPage'
import AuthPrompt from './components/Public/AuthPrompt'
import { getPublicPaperPath } from './utils/publicNavigation'
import { lazyWithPreload } from './utils/lazyPreload'
import './App.css'

// Only what the first paint of the feed needs loads eagerly. Everything below
// is its own chunk: the 2 MB single bundle was the measured cost of every
// screen riding in the boot graph (25 static screens, 0.9–1.3 s of parse).
//
// The router commits a navigation synchronously (`useTransitions={false}` in
// main.jsx), and `AnimatePresence mode="sync"` mounts the incoming screen in
// that same commit, beside the outgoing one. A screen whose chunk is cold
// suspends inside its own PageTransition's Suspense boundary, so the
// RouteFallback (delayed 320 ms by its stylesheet) is drawn within the page
// arriving. The page leaving does not wait for it: it is held for exactly as
// long as the page on top takes to arrive (300 ms; 180 between tabs), then
// hands itself back, so a cold chunk can leave a blank between the held page
// going and the fallback revealing (up to ~140 ms between tabs) — still
// sooner than the fallback ever appeared under `mode="wait"`. The
// screens are preloadable (`lazyWithPreload`) so the ones prefetched below
// never suspend at all.

// The sign-in page rides in that same list rather than in the boot graph, as it
// used to: a session that already exists never renders it, and a guest reaches
// it by a redirect or a direct link — both can afford one chunk.
const LoginPage = lazyWithPreload(() => import('./components/Auth/LoginPage'))
const OnboardingFlow = lazyWithPreload(() => import('./components/Onboarding/OnboardingFlow'))
const ListsPage = lazyWithPreload(() => import('./components/Lists/ListsPage'))
const PDFViewer = lazyWithPreload(() => import('./components/PDF/PDFViewer'))
const SaveToListModal = lazyWithPreload(() => import('./components/Lists/SaveToListModal'))
const CommentsSheet = lazyWithPreload(() => import('./components/Comments/CommentsSheet'))
const SearchPage = lazyWithPreload(() => import('./components/Search/SearchPage'))
const EntityExplorer = lazyWithPreload(() => import('./components/Explorer/EntityExplorer'))
const ScientificReport = lazyWithPreload(() => import('./components/Report/ScientificReport'))
const FollowingFeedPage = lazyWithPreload(() => import('./components/Following/FollowingFeedPage'))
const SettingsPage = lazyWithPreload(() => import('./components/Settings/SettingsPage'))
const FollowingSettingsPage = lazyWithPreload(() => import('./components/Settings/FollowingSettingsPage'))
const MyCommentsPage = lazyWithPreload(() => import('./components/Settings/MyCommentsPage'))
const ModerationPage = lazyWithPreload(() => import('./components/Admin/ModerationPage'))
const PublicPaperPage = lazyWithPreload(() => import('./components/Public/PublicPaperPage'))
const PublicListPage = lazyWithPreload(() => import('./components/Lists/PublicListPage'))
const PublicProfilePage = lazyWithPreload(() => import('./components/Public/PublicProfilePage'))
const ProfilePage = lazyWithPreload(() => import('./components/Profile/ProfilePage'))
const SearchCommand = lazyWithPreload(() => import('./components/Search/SearchCommand'))

function AppContent() {
  const [pdfPaper, setPdfPaper] = useState(null)
  // Back closes the PDF viewer instead of leaving PaperTok: see useOverlayHistory.js.
  useOverlayHistory(Boolean(pdfPaper), () => setPdfPaper(null), 'pdf')
  // On a coarse pointer, "open the PDF" means the browser's own viewer in a
  // new tab, straight away: framed PDFs are crippled on every touch platform
  // (iOS paints only the first page; Android Chrome renders nothing), and the
  // hand-off card the overlay showed instead was one tap of ceremony nobody
  // asked for (2026-08-29). The overlay stays the desktop route, and the
  // fallthrough (no usable URL, or no matchMedia) still mounts it — its own
  // hand-off card is the belt to this suspender.
  const openPdf = useCallback((paper) => {
    try {
      if (window.matchMedia('(pointer: coarse)').matches) {
        const candidate = paper.pdfUrl || (paper.arxivId ? `https://arxiv.org/pdf/${paper.arxivId}` : '')
        const url = safeExternalUrl(candidate)
        // `window.open` answers null when a popup blocker eats it; falling
        // through to the overlay then still gives the reader its hand-off
        // link instead of a tap that visibly did nothing.
        if (url && window.open(url, '_blank', 'noopener')) return
      }
    } catch { /* matchMedia absence falls through to the overlay */ }
    setPdfPaper(paper)
  }, [])
  const [saveModalPaper, setSaveModalPaper] = useState(null)
  // The comment sheet is hosted here, next to the PDF viewer and the save
  // modal, for the same reason those are: the feed hands over a paper and
  // nothing else, so no social service ever enters the feed's module graph
  // and a feed load keeps costing one read.
  const [commentsPaper, setCommentsPaper] = useState(null)
  const [guestFeedReady, setGuestFeedReady] = useState(false)
  // While the guest is being asked what they are into, the consent banner
  // waits: two panels arriving on the same first paint would be a wall.
  const [guestInterestsOpen, setGuestInterestsOpen] = useState(false)
  const [authPromptOpen, setAuthPromptOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  // The palette mounts on its first open and then stays mounted, closed or
  // not. Its exit is Base UI's dialog keeping the sheet on screen while
  // `scSheetOut` runs (SearchCommand.css), and it can only do that inside a
  // component that still exists: mounted behind `searchOpen &&`, a close
  // removed the whole tree in the same commit — gone from the DOM 2 ms after
  // the click, the closed state never observed — and the exit had never
  // played once. The lazy chunk still waits for the first open, which is
  // what the conditional mount was for; a closed palette costs one idle hook.
  const [searchMounted, setSearchMounted] = useState(false)
  const openSearch = useCallback(() => {
    setSearchMounted(true)
    setSearchOpen(true)
  }, [])
  const location = useLocation()
  // The ONE place this is computed. Every PageTransition reads it from the
  // provider below, and AnimatePresence hands it to the page on its way out —
  // which cannot work it out for itself, because it is kept mounted inside a
  // <Routes> still providing the location it was rendered for.
  const pageTransitionCustom = usePageTransitionCustom()
  const { user, loading: authLoading, onboardingComplete, profileLoadError } = useAuth()
  const { isEnglish } = useLanguage()
  const normalizedPathname = location.pathname === '/' ? '/' : location.pathname.replace(/\/+$/, '')
  const navbarRoutes = ['/', '/lists', '/research', '/following', '/profile', '/settings', '/settings/following', '/settings/profile', '/settings/comments']
  // The paper, profile, list and entity pages keep the app chrome for a
  // signed-in user — reaching a paper from Liked, a profile from the follow
  // sheet, a list from someone's shared link, or an author from a card, must
  // not feel like leaving the app. Measured before the entity pages joined:
  // the bar unmounted in the frame after the tap and left an empty band over
  // the card while it dissolved. Signed-out visitors still get the standalone
  // page (`user` gates below).
  const showNavbar = (navbarRoutes.includes(normalizedPathname)
    || normalizedPathname.startsWith('/public/paper/')
    || normalizedPathname.startsWith('/public/user/')
    || normalizedPathname.startsWith('/public/list/')
    || normalizedPathname.startsWith('/explorer/'))
    && Boolean(user)
    && !authLoading
    && onboardingComplete
    && !profileLoadError

  const requestAuthentication = useCallback(() => {
    setAuthPromptOpen(true)
  }, [])

  // Warm the chunks a session is most likely to need next — the overlays any
  // card can open, and the other navbar feeds — once the first screen has
  // had the network and the main thread to itself for a while. Skipped on a
  // connection that says it is paying for every byte: Save-Data or an
  // effective 2G link. `navigator.connection` is absent in Safari, and an
  // unknown connection prefetches as before — guessing "slow" for every
  // iPhone would cost more than it saves.
  //
  // Only with a session. A guest on /login has none of the taps these chunks
  // are for: the avatar and the gear live in the Navbar, which renders only
  // for a signed-in user (`showNavbar` above), and the overlays open from
  // cards a guest does not see. The 2.5 s count from the session arriving,
  // which on a cold load is a few hundred ms after mount; a session that ends
  // before the timer fires cancels it. Keyed on the uid, not the user object:
  // AuthContext calls setUser on every auth event, and a fresh object with
  // the same uid must not re-arm the timer.
  const sessionUid = user?.uid ?? null
  useEffect(() => {
    if (!sessionUid) return
    const prefetch = () => {
      const conn = navigator.connection
      const frugal = conn && (conn.saveData || /2g/.test(conn.effectiveType || ''))
      if (frugal) return
      // Everything goes through `preload()`, not a bare `import()`: the
      // import warms the module cache, but the first render of a `lazy`
      // component still suspends on it (see utils/lazyPreload.js), and React
      // then commits the Suspense fallback and holds it for its 300 ms
      // throttle. Measured on the screens: a 300 ms blank beat between exit
      // and entrance on the first visit to Research or Following, chunk
      // cached or not. Measured on the overlays: the comments sheet appeared
      // ~420 ms after the tap that opened it the first time in a session,
      // chunk cached or not, and at once every time after. Preloaded, the
      // first time is every other time.
      CommentsSheet.preload().catch(() => {})
      PDFViewer.preload().catch(() => {})
      SaveToListModal.preload().catch(() => {})
      ScientificReport.preload().catch(() => {})
      FollowingFeedPage.preload().catch(() => {})
      // The avatar and the gear are one tap from every screen. Fetched on
      // first visit instead, the profile and settings chunks were what a
      // deploy most often took away from an open tab: a 404 on the chunk,
      // the forced reload in main.jsx, and the feed coming back from the top
      // — which read as the whole feed reloading.
      PublicProfilePage.preload().catch(() => {})
      SettingsPage.preload().catch(() => {})
      // One row inside Settings; small chunk, and the first visit used to pay
      // it on top of the cold Firestore read the page then makes.
      MyCommentsPage.preload().catch(() => {})
      // Every card links to authors, topics and projects; the first of those
      // opened in a session used to pay the chunk and the fallback throttle.
      EntityExplorer.preload().catch(() => {})
      import('./components/Reader/PaperReader.jsx').catch(() => {})
      SearchCommand.preload().catch(() => {})
    }
    const schedule = window.requestIdleCallback || (fn => setTimeout(fn, 0))
    const timer = setTimeout(() => schedule(prefetch), 2500)
    return () => clearTimeout(timer)
  }, [sessionUid])

  // HashRouter (src/main.jsx) treats the URL fragment as the route. Letting
  // href="#main-content" reach the browser would rewrite the whole hash, so
  // react-router would read "/main-content" as the pathname, match no route,
  // and the catch-all `<Route path="*">` below would redirect to "/" —
  // ejecting a keyboard user from whatever route they were actually on (e.g.
  // /login). The href stays for assistive technology; the click is handled
  // here instead of letting the fragment reach the router.
  const handleSkipLinkClick = (event) => {
    event.preventDefault()
    document.getElementById('main-content')?.focus()
  }

  return (
    <FeedProvider feedRouteActive={normalizedPathname === '/'}>
      <a className="skip-link" href="#main-content" onClick={handleSkipLinkClick}>
        {isEnglish ? 'Skip to content' : 'Saltar al contenido'}
      </a>
      <RouteAnnouncer />
      {showNavbar && <Navbar searchOpen={searchOpen} onOpenSearch={openSearch} />}
      {/* Focus target for the skip link and for route changes (RouteAnnouncer).
          A div, not <main>: several routes render their own <main> inside. */}
      <div id="main-content" tabIndex={-1}>
      <Suspense fallback={<RouteFallback />}>
      {/* `mode="sync"`: the page leaving and the page arriving share the
          screen, the deeper one on top (PageTransition.css). `custom` so the
          page on its way OUT reads the navigation that ejects it
          (usePresenceData) rather than the one that mounted it: AnimatePresence
          keeps the previous <Routes> element itself. `initial={false}` keeps
          the motion elements inside the first page from replaying their
          `initial` on the app's first render. */}
      <PageTransitionCustomProvider value={pageTransitionCustom}>
      <AnimatePresence mode="sync" initial={false} custom={pageTransitionCustom}>
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
                      landmark={{
                        label: isEnglish ? 'Paper feed' : 'Feed de papers',
                        heading: isEnglish ? 'For you' : 'Para ti',
                      }}
                      onOpenPdf={openPdf}
                      onSaveToList={setSaveModalPaper}
                      onOpenComments={setCommentsPaper}
                    />
                  </PageTransition>
                </ProtectedRoute>
              ) : (
                <PageTransition>
                  <GuestFeedPage
                    onReady={setGuestFeedReady}
                    onInterestsPromptChange={setGuestInterestsOpen}
                    interestsPromptSuspended={authPromptOpen}
                    onAuthRequired={requestAuthentication}
                    onOpenPdf={openPdf}
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
                  <ListsPage onOpenPdf={openPdf} onEditPaper={setSaveModalPaper} />
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
                    onOpenPdf={openPdf}
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
                    onOpenPdf={openPdf}
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
                  appChrome={showNavbar}
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
                  onOpenPdf={openPdf}
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
      </PageTransitionCustomProvider>
      </Suspense>
      </div>

      {user && searchMounted && (
        <Suspense fallback={null}>
          <SearchCommand open={searchOpen} onOpenChange={setSearchOpen} />
        </Suspense>
      )}

      <AnalyticsConsentBanner guestFeedReady={guestFeedReady && !guestInterestsOpen} />

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
  const { user, loading: authLoading } = useAuth()
  // This key exists to isolate per-account state (e507856, "isolate
  // recommendation state"): everything below it is rebuilt when the reader
  // becomes SOMEBODY ELSE. It must not be rebuilt when the account merely
  // becomes KNOWN, which is what keying on `user?.uid || 'signed-out'` did —
  // `user` is null on the first render of every load, so the key flipped once
  // on every signed-in cold load and React destroyed this whole tree,
  // <Routes> included, mid-paint. `utils/accountScope.js` has the measurement.
  // State adjusted during render, the documented way to derive state from a
  // prop; the key reads `scope` rather than the state so this render already
  // mounts under the right one.
  const [previousScope, setPreviousScope] = useState(INITIAL_ACCOUNT_SCOPE)
  const scope = nextAccountScope(previousScope, { uid: user?.uid, authLoading })
  if (scope !== previousScope) setPreviousScope(scope)
  return (
    <FollowingProvider key={accountScopeKey(scope)}>
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
