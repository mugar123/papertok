import type { MouseEvent } from 'react'
import type { Paper } from './models/paper.ts'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import { waitForPendingWrites } from 'firebase/firestore'
import { db } from './services/firebase.ts'
import { flushAllInteractionProfiles } from './services/interaction-profile-store.ts'
import { primeAIUses } from './services/paper-rewrite-service.ts'
import PageTransition from './components/layout/page-transition.tsx'
import { PageTransitionCustomProvider, usePageTransitionCustom } from './hooks/use-page-transition-custom.ts'
import { useOverlayHistory } from './hooks/use-overlay-history.ts'
import { INITIAL_ACCOUNT_SCOPE, accountScopeKey, nextAccountScope } from './utils/account-scope.ts'
import { feedResumeMemory } from './utils/feed-resume-memory.ts'
import { clearAuthReturn, isInAppPath, offerAuthReturn, takeAuthReturn } from './utils/auth-return.ts'
import RouteFallback from './components/layout/route-fallback.tsx'
import RouteAnnouncer from './components/layout/route-announcer.tsx'
import { Toaster } from './components/ui/sonner.tsx'
import { TooltipProvider } from './components/ui/tooltip.tsx'
import NotFoundPage from './components/layout/not-found-page.tsx'
import { AuthProvider, useAuth } from './context/auth-context.tsx'
import { LanguageProvider } from './context/language-context.tsx'
import { ThemeProvider } from './context/theme-context.tsx'
import { AnalyticsProvider } from './context/analytics-context.tsx'
import { FeedProvider } from './context/feed-context.tsx'
import { SimilarFeedProvider } from './context/similar-feed-context.tsx'
import { FollowingProvider } from './context/following-context.tsx'
import { FollowingUpdatesProvider } from './context/following-updates-context.tsx'
import { EmailNotificationsProvider } from './context/email-notifications-context.tsx'
import ProtectedRoute from './components/auth/protected-route.tsx'
import FeedContainer from './components/feed/feed-container.tsx'
import Navbar from './components/layout/navbar.tsx'
import NudgeHost from './components/nudges/nudge-host.tsx'
import GuestWelcome from './components/public/guest-welcome.tsx'
import AuthPrompt from './components/public/auth-prompt.tsx'
import { normalizeAuthReason } from './components/public/auth-prompt-copy.ts'
import { getPublicPaperPath, isPublicRoute } from './utils/public-navigation.ts'
import { connectionIsFrugal, lazyWithPreload } from './utils/lazy-preload.ts'
import { reloadIfBehindDeploy } from './utils/service-worker-updates.ts'
import './app.css'

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

const InstitutionVerification = lazyWithPreload(() => import('./components/institution/institution-verification.tsx'))
const OnboardingFlow = lazyWithPreload(() => import('./components/onboarding/onboarding-flow.tsx'))
const ListsPage = lazyWithPreload(() => import('./components/lists/lists-page.tsx'))
const PDFViewer = lazyWithPreload(() => import('./components/pdf/pdf-viewer.tsx'))
const SaveToListModal = lazyWithPreload(() => import('./components/lists/save-to-list-modal.tsx'))
const SearchPage = lazyWithPreload(() => import('./components/search/search-page.tsx'))
const EntityExplorer = lazyWithPreload(() => import('./components/explorer/entity-explorer.tsx'))
const FollowingFeedPage = lazyWithPreload(() => import('./components/following/following-feed-page.tsx'))
const SettingsPage = lazyWithPreload(() => import('./components/settings/settings-page.tsx'))
const FollowingSettingsPage = lazyWithPreload(() => import('./components/settings/following-settings-page.tsx'))
const PublicPaperPage = lazyWithPreload(() => import('./components/public/public-paper-page.tsx'))
const PublicListPage = lazyWithPreload(() => import('./components/lists/public-list-page.tsx'))
const SearchCommand = lazyWithPreload(() => import('./components/search/search-command.tsx'))

function LoginRedirect() {
  const location = useLocation()
  const requested = location.state?.returnTo || new URLSearchParams(location.search).get('returnTo')
  return (
    <Navigate
      to="/onboarding"
      replace
      state={{ authRequired: true, returnTo: isInAppPath(requested) ? requested : '/feed' }}
    />
  )
}

function AppContent() {
  const [pdfPaper, setPdfPaper] = useState<Paper | null>(null)
  // Back closes the PDF viewer instead of leaving PaperTok: see use-overlay-history.ts.
  // Through the viewer's own close, the one the X uses — it owns `open` and
  // reports back only when its leave has played; `setPdfPaper(null)` is just
  // the fallback for before the lazy chunk has mounted.
  const pdfCloseRef = useRef<(() => void) | null>(null)
  const requestPdfClose = useCallback(() => {
    if (pdfCloseRef.current) pdfCloseRef.current()
    else setPdfPaper(null)
  }, [])
  useOverlayHistory(Boolean(pdfPaper), requestPdfClose, 'pdf')
  // Every pointer opens the PDF here, in the viewer. A touch screen used to be
  // sent to the browser's viewer in a new tab, because a framed PDF is
  // crippled there (2026-08-29); the viewer now draws the pages itself on a
  // touch screen (pdf-pages.tsx), so the paper stays in PaperTok on a phone as
  // it does on a desktop (2026-10-09).
  const openPdf = setPdfPaper
  const [saveModalPaper, setSaveModalPaper] = useState<Paper | null>(null)
  const [authPromptOpen, setAuthPromptOpen] = useState(false)
  const [authPromptReason, setAuthPromptReason] = useState('default')
  const [searchOpen, setSearchOpen] = useState(false)
  // The palette mounts on its first open and then stays mounted, closed or
  // not. Its exit is Base UI's dialog keeping the sheet on screen while
  // `scSheetOut` runs (search-command.css), and it can only do that inside a
  // component that still exists: mounted behind `searchOpen &&`, a close
  // removed the whole tree in the same commit — gone from the DOM 2 ms after
  // the click, the closed state never observed — and the exit had never
  // played once. The lazy chunk still waits for the first open, which is
  // what the conditional mount was for; a closed palette costs one idle hook.
  const [searchMounted, setSearchMounted] = useState(false)
  // Whoever opened the palette gets the focus back when it closes. The
  // palette has no Base UI Trigger — the navbar's two buttons and the `/`
  // shortcut all call this — so the dialog has nothing to return focus to on
  // its own; measured 2026-09-22, Escape left the focus on `body`. A ref,
  // read at close time, so a button that re-rendered meanwhile still counts.
  const searchOpenerRef = useRef<HTMLElement | null>(null)
  const [searchSlot, setSearchSlot] = useState<HTMLElement | null>(null)
  const openSearch = useCallback(() => {
    searchOpenerRef.current = document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body
      ? document.activeElement
      : [...document.querySelectorAll<HTMLElement>('.navbar-search, .navbar-icon-btn--search-compact')]
        .find((el) => el.getClientRects().length > 0) ?? null
    setSearchMounted(true)
    setSearchOpen(true)
  }, [])
  const location = useLocation()
  // A deploy this tab is behind on is applied when the reader changes page,
  // once Firestore has acknowledged every write issued by then, the
  // interaction aggregate flushed here included (utils/service-worker-updates.ts).
  // The liked, saved and read lists load from that aggregate after the reload.
  // Without the flush its write waits for the debounce timer, the tab being
  // hidden or pagehide, and the reload fires the last two only as it unloads
  // the page.
  useEffect(() => {
    void reloadIfBehindDeploy(location.pathname, () => Promise.all([flushAllInteractionProfiles(), waitForPendingWrites(db)]))
  }, [location.pathname])
  // The ONE place this is computed. Every PageTransition reads it from the
  // provider below, and AnimatePresence hands it to the page on its way out —
  // which cannot work it out for itself, because it is kept mounted inside a
  // <Routes> still providing the location it was rendered for.
  const pageTransitionCustom = usePageTransitionCustom()
  const { user, loading: authLoading, onboardingComplete, profileLoadError } = useAuth()
  const normalizedPathname = location.pathname === '/' ? '/' : location.pathname.replace(/\/+$/, '')
  const navbarRoutes = ['/feed', '/lists', '/following', '/search', '/settings', '/settings/profile', '/settings/discovery', '/settings/reading', '/settings/notifications', '/settings/privacy', '/settings/following']
  // The paper, list and entity pages keep the app chrome for a signed-in
  // user — reaching a paper from a list, a list from someone's shared link,
  // or an author from a card, must not feel like leaving the app. Measured
  // before the entity pages joined: the bar unmounted in the frame after the
  // tap and left an empty band over the card while it dissolved. Signed-out
  // visitors still get the standalone page (`user` gates below).
  const showNavbar = (navbarRoutes.includes(normalizedPathname)
    || normalizedPathname.startsWith('/public/paper/')
    || normalizedPathname.startsWith('/public/list/')
    || normalizedPathname.startsWith('/explorer/'))
    && Boolean(user)
    && !authLoading
    && onboardingComplete
    && !profileLoadError

  // A door opened from the page itself (Save, Like, the header's Sign in)
  // means "stay here": it drops any trip an earlier bounce left waiting.
  // The door says why it opened: `reason` is one of authPromptCopy's keys,
  // and anything else — the click event of an `onClick={requestAuthentication}`,
  // the paper of an `onSaveToList` — is the general door.
  const requestAuthentication = useCallback((reason?: unknown) => {
    clearAuthReturn()
    setAuthPromptOpen(true)
    setAuthPromptReason(normalizeAuthReason(reason))
  }, [])

  // There is no sign-in page. A guest bounced off a protected route (or an
  // old /login link) lands on the onboarding with `authRequired` in the
  // location state: the sign-in dialog opens over the welcome, and the route
  // they asked for waits in `utils/auth-return.ts` until a session exists —
  // outside this component, because signing in remounts it (see that file).
  // Each arrival is read once (keyed on the history entry, adjusted during
  // render so the door is in the same paint as the welcome), and the state is
  // then cleared from the entry so a reload does not reopen it.
  const navigate = useNavigate()
  const authArrivalKey = location.state?.authRequired ? location.key : null
  const arrivalReturnTo = authArrivalKey ? location.state?.returnTo : undefined
  const [consumedAuthArrival, setConsumedAuthArrival] = useState<string | null>(null)
  if (authArrivalKey && authArrivalKey !== consumedAuthArrival) {
    setConsumedAuthArrival(authArrivalKey)
    if (!user) setAuthPromptOpen(true)
  }
  useEffect(() => {
    if (!authArrivalKey) return
    offerAuthReturn(arrivalReturnTo)
    void navigate(`${location.pathname}${location.search}`, { replace: true, state: null })
  }, [authArrivalKey, arrivalReturnTo, navigate, location.pathname, location.search])
  // Once the session exists, the trip ends where it began — once per trip.
  useEffect(() => {
    if (!user || authLoading) return
    const destination = takeAuthReturn()
    if (destination) void navigate(destination, { replace: true })
  }, [user, authLoading, navigate])

  // A new account created from a public page's door has nowhere to go: those
  // routes are not behind ProtectedRoute, so nothing asked it to choose its
  // interests, and the bar (which needs `onboardingComplete`) never came. The
  // onboarding opens with this page as the way back. `replace`, because a
  // Back into an un-onboarded public page would only bring the account here
  // again. Not while the profile is loading or failed to: the route's own
  // handling covers those, and a redirect on a guess would be wrong.
  useEffect(() => {
    if (!user || authLoading || onboardingComplete || profileLoadError) return
    if (!isPublicRoute(location.pathname)) return
    void navigate('/onboarding', { replace: true, state: { returnTo: `${location.pathname}${location.search}` } })
  }, [user, authLoading, onboardingComplete, profileLoadError, location.pathname, location.search, navigate])

  // Warm the chunks a session is most likely to need next — the overlays any
  // card can open, and the other navbar feeds — once the first screen has
  // had the network and the main thread to itself for a while. Skipped on a
  // connection that says it is paying for every byte: Save-Data or an
  // effective 2G link. `navigator.connection` is absent in Safari, and an
  // unknown connection prefetches as before — guessing "slow" for every
  // iPhone would cost more than it saves.
  //
  // Only with a session. A guest has none of the taps these chunks are for:
  // the avatar and the gear live in the Navbar, which renders only
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
      if (connectionIsFrugal()) return
      // Everything goes through `preload()`, not a bare `import()`: the
      // import warms the module cache, but the first render of a `lazy`
      // component still suspends on it (see utils/lazy-preload.ts), and React
      // then commits the Suspense fallback and holds it for its 300 ms
      // throttle. Measured on the screens: a 300 ms blank beat between exit
      // and entrance on the first visit to Research or Following, chunk
      // cached or not. Measured on the overlays (on the comments sheet, since
      // removed): it appeared ~420 ms after the tap that opened it the first
      // time in a session, chunk cached or not, and at once every time after.
      // Preloaded, the first time is every other time.
      PDFViewer.preload().catch(() => {})
      SaveToListModal.preload().catch(() => {})
      FollowingFeedPage.preload().catch(() => {})
      // Settings is one tap from every screen, in the account menu. Fetched
      // on first visit instead, its chunk was what a deploy most often took
      // away from an open tab: a 404 on the chunk, the forced reload in
      // main.jsx, and the feed coming back from the top — which read as the
      // whole feed reloading.
      SettingsPage.preload().catch(() => {})
      // Every card links to authors, topics and projects; the first of those
      // opened in a session used to pay the chunk and the fallback throttle.
      EntityExplorer.preload().catch(() => {})
      import('./components/reader/paper-reader.tsx').catch(() => {})
      SearchCommand.preload().catch(() => {})
    }
    const schedule = window.requestIdleCallback || (fn => setTimeout(fn, 0))
    const timer = setTimeout(() => schedule(prefetch), 2500)
    return () => clearTimeout(timer)
  }, [sessionUid])

  // Not held for the idle prefetch above: a reader opened in the first seconds
  // would still grow its uses pill late. One small request per session.
  useEffect(() => {
    if (sessionUid) primeAIUses(sessionUid)
  }, [sessionUid])

  // The href stays for assistive technology; the click is handled here rather
  // than left to the browser, for two reasons that outlived the one this
  // handler was written for.
  //
  // The original: the router read the URL fragment, so letting
  // href="#main-content" through rewrote the whole route — react-router saw
  // "/main-content", matched nothing, and the catch-all below ejected a
  // keyboard user from whatever page they were on. Verified live from #/login
  // at the time: the hash became #main-content, then #/, and the login page
  // was gone. That hazard is gone with the router (src/main.tsx mounts a
  // BrowserRouter now; the path is the route and a fragment is just a place on
  // the page), and the handler stays anyway because:
  //
  //   - a fragment jump scrolls reliably but does NOT reliably move KEYBOARD
  //     focus — Safari in particular leaves focus behind — and a skip link
  //     that scrolls without moving focus has skipped nothing for the one
  //     person using it. `focus()` is the guarantee, not a nicety;
  //   - and it keeps `#main-content` out of the address, so nothing the reader
  //     copies or shares carries it.
  const handleSkipLinkClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    document.getElementById('main-content')?.focus()
  }

  return (
    <FeedProvider feedRouteActive={normalizedPathname === '/feed'}>
    <SimilarFeedProvider onOpenPdf={openPdf} onSaveToList={setSaveModalPaper}>
      <a className="skip-link" href="#main-content" onClick={handleSkipLinkClick}>
        {'Skip to content'}
      </a>
      <RouteAnnouncer />
      {/* The one place toasts render; anything calls `toast()` from 'sonner'. */}
      <Toaster />
      {showNavbar && <Navbar searchOpen={searchOpen} onOpenSearch={openSearch} onSearchSlot={setSearchSlot} />}
      {/* Focus target for the skip link and for route changes (RouteAnnouncer).
          A div, not <main>: several routes render their own <main> inside. */}
      <div id="main-content" tabIndex={-1}>
      <Suspense fallback={<RouteFallback />}>
      {/* `mode="sync"`: the page leaving and the page arriving share the
          screen, the deeper one on top (page-transition.css). `custom` so the
          page on its way OUT reads the navigation that ejects it
          (usePresenceData) rather than the one that mounted it: AnimatePresence
          keeps the previous <Routes> element itself. `initial={false}` keeps
          the motion elements inside the first page from replaying their
          `initial` on the app's first render. */}
      <PageTransitionCustomProvider value={pageTransitionCustom}>
      <AnimatePresence mode="sync" initial={false} custom={pageTransitionCustom}>
        <Routes location={location} key={location.pathname.startsWith('/settings/') ? '/settings' : location.pathname}>
          {/* The sign-in page is gone; the address still works for old links
              and bookmarks: the onboarding, with the sign-in dialog open. */}
          {/* The entry address, by its own route rather than the wildcard
              (which answers an undeclared address with NotFoundPage): an
              account goes to its feed, a visitor to the onboarding. While the
              session is unknown it is the feed, whose veil is the boot screen;
              ProtectedRoute sends a visitor on from there. */}
          <Route path="/" element={<Navigate to={authLoading || user ? '/feed' : '/onboarding'} replace />} />
          <Route path="/institution/verify" element={<InstitutionVerification />} />
          <Route path="/login" element={<LoginRedirect />} />
          {/* Signed out, the onboarding is the welcome, and it ends in a
              sign-up: there is no guest feed. Signed in, it is the account's
              own steps, which adopt what the welcome answered. */}
          <Route
            path="/onboarding"
            element={
              authLoading || user ? (
                <ProtectedRoute requireOnboarding={false}>
                  <PageTransition><OnboardingFlow /></PageTransition>
                </ProtectedRoute>
              ) : (
                <PageTransition>
                  <GuestWelcome onSignIn={requestAuthentication} />
                </PageTransition>
              )
            }
          />
          <Route
            path="/feed"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <FeedContainer
                    landmark={{
                      label: 'Paper feed',
                      heading: 'For you',
                    }}
                    onOpenPdf={openPdf}
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
                  <ListsPage onOpenPdf={openPdf} onEditPaper={setSaveModalPaper} />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          {/* Research was removed while the MVP is trimmed down. Its address
              and the legacy Novedades/Reporte one land on the feed instead of
              the not-found page. */}
          <Route path="/research" element={<Navigate to="/feed" replace />} />
          <Route path="/report" element={<Navigate to="/feed" replace />} />
          <Route
            path="/following"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <FollowingFeedPage
                    onOpenPdf={openPdf}
                    onSaveToList={setSaveModalPaper}
                  />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          {/* One search box. Papers, institutions, topics and projects come
              from OpenAlex and OpenAIRE over HTTP. */}
          <Route
            path="/search"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <SearchPage onSaveToList={setSaveModalPaper} searchSlot={searchSlot} />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          {/* The profile page was removed with following people. Its address
              lands on the lists, where the likes and saves it showed live. */}
          <Route path="/profile" element={<Navigate to="/lists" replace />} />
          {/* One route per settings page; the bare address opens the first. */}
          <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
          <Route
            path="/settings/profile"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <SettingsPage page="profile" />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings/discovery"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <SettingsPage page="discovery" />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings/reading"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <SettingsPage page="reading" />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings/notifications"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <SettingsPage page="notifications" />
                </PageTransition>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings/privacy"
            element={
              <ProtectedRoute>
                <PageTransition>
                  <SettingsPage page="privacy" />
                </PageTransition>
              </ProtectedRoute>
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
          <Route
            path="*"
            element={
              <PageTransition>
                <NotFoundPage />
              </PageTransition>
            }
          />
        </Routes>
      </AnimatePresence>
      </PageTransitionCustomProvider>
      </Suspense>
      </div>

      {user && searchMounted && (
        <Suspense fallback={null}>
          <SearchCommand open={searchOpen} onOpenChange={setSearchOpen} finalFocus={searchOpenerRef} />
        </Suspense>
      )}

      <NudgeHost />

      <AnimatePresence>
        {authPromptOpen && (
          <AuthPrompt
            reason={authPromptReason}
            onClose={() => {
              setAuthPromptOpen(false)
              // The next door — a bounce off a protected route opens this
              // without a reason — must not inherit this one's.
              setAuthPromptReason('default')
            }}
          />
        )}
      </AnimatePresence>

      {/* Each overlay suspends on its own: while its chunk downloads (idle
          prefetch usually has it already) nothing flashes, and the rest of
          the screen stays interactive. */}
      <Suspense fallback={null}>
        {pdfPaper && (
          <PDFViewer paper={pdfPaper} closeRef={pdfCloseRef} onClose={() => setPdfPaper(null)} />
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
    </SimilarFeedProvider>
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
  // <Routes> included, mid-paint. `utils/account-scope.ts` has the measurement.
  // State adjusted during render, the documented way to derive state from a
  // prop; the key reads `scope` rather than the state so this render already
  // mounts under the right one.
  const [previousScope, setPreviousScope] = useState<ReturnType<typeof nextAccountScope>>(INITIAL_ACCOUNT_SCOPE)
  const scope = nextAccountScope(previousScope, { uid: user?.uid, authLoading })
  if (scope !== previousScope) setPreviousScope(scope)
  // The places this tab's feeds were left on belong to the account that left
  // them: after a sign-out or a switch, every feed opens on its first card.
  useEffect(() => {
    if (scope.generation > 0) feedResumeMemory.clear()
  }, [scope.generation])
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
            <TooltipProvider>
              <UserScopedAppContent />
            </TooltipProvider>
          </AnalyticsProvider>
        </LanguageProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}

export default App
