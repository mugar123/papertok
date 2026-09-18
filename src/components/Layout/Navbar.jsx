import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { ruleTransform } from '../../utils/navRule.js';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import { Search, Layers, Newspaper, UserCheck } from 'lucide-react';
import NavPreferencesMenu from './NavPreferencesMenu';
import { shouldOpenSearchOnSlash } from './searchShortcut.js';
import './Navbar.css';

/**
 * The yellow rule under the tab you are on.
 *
 * It was a `::after` on the active link, which could only blink from one
 * link to the next; then a framer `layoutId` element, which travelled — but
 * in JavaScript, on the main thread, which is exactly the thread a tab switch
 * keeps busy mounting the next feed. Measured: the rule slid, froze short of
 * the word for ~200 ms while the cards mounted, and slid the rest.
 *
 * Now it is one element positioned with a transform the CSS transition
 * animates on the compositor, so it keeps moving whatever the main thread is
 * doing. This hook measures the active link — after every render, and again
 * when the row resizes (the active link is semibold, so activating one changes
 * its width and shifts its neighbours) — and returns the transform. The first
 * measurement is applied without a transition, so the rule does not slide in
 * from the row's left edge on load.
 */
function useActiveTabRule(rowRef, tab, activeKey) {
  const [rule, setRule] = useState({ transform: '', measured: false });

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const measure = () => {
      // By `data-tab` rather than `.active`: the hook is told which tab to
      // measure, so the caller owns that decision and this cannot drift from
      // the class the router appends.
      const link = tab ? row.querySelector(`.navbar-link[data-tab="${tab}"]`) : null;
      if (!link) {
        setRule(current => (current.transform ? { ...current, transform: '' } : current));
        return;
      }
      const inset = parseFloat(getComputedStyle(link).paddingLeft) || 0;
      const transform = ruleTransform(link.getBoundingClientRect(), row.getBoundingClientRect().left, inset);
      setRule(current => (current.transform === transform && current.measured ? current : { transform, measured: true }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    row.querySelectorAll('.navbar-link').forEach(link => observer.observe(link));
    return () => observer.disconnect();
  }, [rowRef, tab, activeKey]);

  return rule;
}

/**
 * Whether the bar has already arrived once this session.
 *
 * The bar is mounted the frame the auth gate lifts, above the atom veil
 * that is still covering the feed — and it used to pop in whole while
 * nothing else on screen moved. Its first mount fades in. Later mounts (back
 * from a route that draws no bar) come in with the page that brings them, so
 * the arrival is handed out once, module-wide: a remount must not replay it.
 */
let navbarHasArrived = false;

export default function Navbar({ onOpenSearch = () => {}, searchOpen = false }) {
  const { user, profilePhoto } = useAuth();
  const [arriving, setArriving] = useState(() => !navbarHasArrived);
  const handleArrived = (event) => {
    // Children animate too (the preferences sheet, the search state); only
    // the bar's own animationend retires the class, and mid-arrival a
    // child's would otherwise cut it short.
    if (event.target !== event.currentTarget) return;
    navbarHasArrived = true;
    setArriving(false);
  };
  const { setFeedMode } = useFeed();
  const { isEnglish } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const pathname = location.pathname === '/' ? '/' : location.pathname.replace(/\/+$/, '');

  useEffect(() => {
    const handleShortcut = (event) => {
      // Bound on `window`, so a modal dialog's inertness does not filter it:
      // the guard has to be asked explicitly (searchShortcut.js).
      if (!shouldOpenSearchOnSlash(event, document)) return;
      event.preventDefault();
      onOpenSearch();
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [onOpenSearch]);

  const isFollowingActive = pathname === '/following';
  const isResearchActive = pathname === '/research' || pathname === '/report';
  const isHomeActive = pathname === '/feed';
  // Which tab is current is the pathname, and nothing else. This used to also
  // require `feedMode === 'top'`, from a time when this feed had more than one
  // mode; `feedMode` has had exactly one reachable value since — FeedContext
  // initialises it to 'top', and `handleSetFeedMode`, whose only caller in the
  // app is the For you tab below (always with 'top'), returns early when the
  // mode is unchanged. The gate started to matter the moment that tab became a
  // NavLink (2026-09-05): React Router appends its own `active` class and sets
  // `aria-current="page"` from `isActive`, which is the pathname alone, so a
  // narrower hand-written condition could not have won — the tab would have
  // been marked current while this file claimed it was not. If a second feed
  // mode is ever added, this line and that `aria-current` have to be revisited
  // together: a `className` callback suppresses the appended class, but nothing
  // in NavLink's plain API gates `aria-current`.
  const activeTab = isHomeActive ? 'home' : isResearchActive ? 'research' : isFollowingActive ? 'following' : '';
  const linksRef = useRef(null);
  /**
   * The press is remembered only to decide, on `pointerup`, whether the finger
   * lifted on the tab it pressed.
   *
   * It used to ALSO carry the mark to the pressed tab a frame after touchdown,
   * because the mark otherwise waited ~200ms for the click handler to mount
   * the next page (measured 2026-09-18 at CPU ×6). Navigating on `pointerup`
   * removed that wait — the route commits within milliseconds of the finger
   * lifting — and the optimistic move then cost more than it bought: it aimed
   * the mark at the tab as it was, in normal weight, and the router re-aimed
   * it a moment later at the semibold word, which is wider. Measured the same
   * day: two targets per tap (`scaleX(0.6709)` then `scaleX(0.6789)`), the
   * second arriving 108ms in, with the mark already travelling. A CSS
   * transition re-aimed mid-flight restarts its 240ms clock from wherever it
   * is, so the mark slowed, sped up and eased again — the glitch the reader
   * saw. One measurement, one curve.
   */
  const touchRef = useRef(null);
  const handledRef = useRef(0);
  const pressTab = (event, tab) => {
    if (event.button !== 0 || event.pointerType !== 'touch') return;
    touchRef.current = { tab, x: event.clientX, y: event.clientY, at: Date.now() };
  };
  const releasePress = () => {
    touchRef.current = null;
  };
  /**
   * A finger that lifts on the tab it pressed navigates there, without waiting
   * for the click.
   *
   * On a phone the `click` is SYNTHESISED after the finger lifts, and the
   * system is free never to synthesise it: a gesture recogniser that decides
   * late, a double-tap window, a scroll it was still settling. The touch pair
   * arrives either way. Everything measured on this Mac delivers the click
   * (Chromium and WebKit, centre, edges, mid-scroll, 2026-09-18), and the bug
   * survived three fixes built on that assumption, so this stops assuming it:
   * the navigation rides the `pointerup`, which is the last event the page is
   * guaranteed to see.
   *
   * Touch only — a mouse keeps the anchor's own click, and so does the
   * keyboard. It navigates only when the finger lifts on the tab it pressed,
   * within 12px and 1.5s of pressing it, so a drag that starts on the bar is
   * not a navigation. `handledRef` then swallows the click if the system does
   * synthesise one, or react-router would push the same route twice and Back
   * would need two presses.
   */
  const liftTab = (event, tab, to) => {
    const start = touchRef.current;
    touchRef.current = null;
    if (event.pointerType !== 'touch' || !start || start.tab !== tab) return;
    if (Date.now() - start.at > 1500) return;
    if (Math.abs(event.clientX - start.x) > 12 || Math.abs(event.clientY - start.y) > 12) return;
    handledRef.current = Date.now();
    if (tab === 'home') setFeedMode('top');
    if (pathname !== to) navigate(to);
  };
  const swallowSynthesisedClick = (event) => {
    if (Date.now() - handledRef.current > 1500) return;
    handledRef.current = 0;
    event.preventDefault();
  };
  const rule = useActiveTabRule(linksRef, activeTab, `${activeTab}:${isEnglish}`);

  return (
    <nav
      className={arriving ? 'navbar navbar--arriving' : 'navbar'}
      onAnimationEnd={handleArrived}
      aria-label={isEnglish ? 'Main navigation' : 'Navegación principal'}
    >
      <div className="navbar-inner">
        {/* Sin `aria-label`. El botón ya se llama a sí mismo: el nombre sale de
            `.navbar-brand-word`, que dice «PaperTok» en texto. Con el
            `aria-label` puesto, la regla de 2.5.3 comparaba «PaperTok» con lo
            que se VE —la marca «PT» más la palabra— y la marca cuenta aunque
            sea `aria-hidden`, porque quien maneja la interfaz por voz la ve
            igual. Que el rótulo siga en el árbol por debajo de 768 px lo
            sostiene Navbar.css: ahí se recorta, no se borra. */}
        <button
          type="button"
          className="navbar-brand"
          onClick={() => {
            if (location.pathname !== '/feed') navigate('/feed');
          }}
        >
          <span className="navbar-brand-mark" aria-hidden="true">PT</span>
          <span className="navbar-brand-word">Paper<span>Tok</span></span>
        </button>

        {/* Open, the bar holds the state it put the reader in. Without it you
            clicked a bar and a sheet appeared somewhere else, with nothing
            connecting the two — and closing left nothing behind either. The
            transition is already on the element, so the state fades in and out
            rather than snapping. */}
        <button
          type="button"
          className={`navbar-search ${searchOpen ? 'is-open' : ''}`}
          onClick={onOpenSearch}
          aria-expanded={searchOpen}
        >
          <Search size={15} aria-hidden="true" />
          <span>{isEnglish ? 'Search papers, authors, topics...' : 'Buscar papers, autores, temas...'}</span>
          <kbd aria-hidden="true">/</kbd>
        </button>

        <div className="navbar-links" ref={linksRef}>
          <span
            className={`navbar-link-rule${rule.measured ? ' is-measured' : ''}`}
            aria-hidden="true"
            style={{ transform: rule.transform || undefined, opacity: rule.transform ? 1 : 0 }}
          />
          {/* A NavLink like its two siblings, not a <button> that calls
              navigate('/feed'). On the phone (2026-09-05) the tap from Following
              to here needed several tries while the other way took one, and
              the element was the only asymmetry in the bar: an anchor still
              navigates when React's click never runs — the browser follows the
              href — and a button does nothing at all. What that fallback COSTS
              changed with the router: under the old HashRouter it was a
              same-document hop that fired `popstate` (the one event
              react-router's history listens to), and now `/feed` is a real
              path, so the browser leaves the document and the app boots cold.
              The reader still lands on the feed, which is the whole point of
              the fallback, and it is still strictly better than a button that
              swallows the tap — but it is a reload, so the primary path stays
              the pointerup below and this is only the belt to it. `end` so
              nothing nested under /feed could ever mark this tab. React Router
              runs this onClick before its own and navigates unless it was
              defaultPrevented, so the mode reset rides along unchanged. */}
          <NavLink
            to="/feed"
            end
            data-tab="home"
            className={`navbar-link ${isHomeActive ? 'active' : ''}`}
            onClick={(event) => { swallowSynthesisedClick(event); setFeedMode('top'); }}
            onPointerDown={(event) => pressTab(event, 'home')}
            onPointerUp={(event) => liftTab(event, 'home', '/feed')}
            onPointerCancel={releasePress}
          >
            <Layers size={15} aria-hidden="true" />
            {isEnglish ? 'For you' : 'Para ti'}
          </NavLink>

          <NavLink
            to="/research"
            data-tab="research"
            className={`navbar-link ${isResearchActive ? 'active' : ''}`}
            onClick={swallowSynthesisedClick}
            onPointerDown={(event) => pressTab(event, 'research')}
            onPointerUp={(event) => liftTab(event, 'research', '/research')}
            onPointerCancel={releasePress}
          >
            <Newspaper size={15} aria-hidden="true" />
            Research
          </NavLink>

          <NavLink
            to="/following"
            data-tab="following"
            className={`navbar-link ${isFollowingActive ? 'active' : ''}`}
            onClick={swallowSynthesisedClick}
            onPointerDown={(event) => pressTab(event, 'following')}
            onPointerUp={(event) => liftTab(event, 'following', '/following')}
            onPointerCancel={releasePress}
          >
            <UserCheck size={15} aria-hidden="true" />
            {isEnglish ? 'Following' : 'Siguiendo'}
          </NavLink>
        </div>

        <div className="navbar-right">
          <button
            className={`navbar-icon-btn navbar-icon-btn--search-compact ${searchOpen ? 'is-open' : ''}`}
            aria-expanded={searchOpen}
            onClick={onOpenSearch}
            title={isEnglish ? 'Search' : 'Buscar'}
            aria-label={isEnglish ? 'Search' : 'Buscar'}
          >
            <Search size={17} />
          </button>

          {/* Regla 6: las utilidades se agrupan a la derecha tras la regla de
              1px. Tema e idioma viven plegados tras el botón de preferencias:
              cambian cómo se ve la aplicación, no lo que está mostrando. */}
          <NavPreferencesMenu />

          {user && (
            <div className="navbar-profile">
              {/* Straight to the profile, TikTok-style: no menu in between.
                  Settings and sign-out live behind the gear on that page, and
                  My lists behind the profile's own Lists tab, so the menu this
                  replaces costs nothing. The navigation is synchronous on
                  purpose — <Routes> sits inside an AnimatePresence with
                  mode="wait", and a navigate() from an async continuation can
                  leave it stalled. */}
              <button
                className={`navbar-avatar-btn ${pathname === '/profile' ? 'active' : ''}`}
                aria-label={isEnglish ? 'My profile' : 'Mi perfil'}
                title={isEnglish ? 'My profile' : 'Mi perfil'}
                onClick={() => navigate('/profile')}
              >
                {profilePhoto || user.photoURL ? (
                  <img
                    src={profilePhoto || user.photoURL}
                    alt="Profile"
                    className="navbar-avatar"
                    referrerPolicy="no-referrer"
                    // Always visible above the fold on every route -- lazy
                    // loading would only delay it for no benefit. `.navbar-avatar`
                    // renders at 26x26.
                    decoding="async"
                    width="26"
                    height="26"
                  />
                ) : (
                  <div className="navbar-avatar navbar-avatar--fallback">
                    {user.email?.charAt(0).toUpperCase() || 'U'}
                  </div>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
