import type { AnimationEvent, MouseEvent, PointerEvent, RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { Menu } from '@base-ui/react/menu';
import { ruleTransform } from '../../utils/nav-rule.ts';
import { useAuth } from '../../context/auth-context.tsx';
import { useFeed } from '../../context/feed-context.tsx';
import { CaretDown, Check, MagnifyingGlass, Stack, UserCheck } from '@phosphor-icons/react';
import AccountMenu from './account-menu.tsx';
import { shouldOpenSearchOnSlash } from './search-shortcut.ts';

// The palette's chord is shown the way this keyboard spells it (search-shortcut.ts takes both).
const IS_MAC = typeof navigator !== 'undefined'
  && /mac|iphone|ipad/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '');
import './navbar.css';

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
function useActiveTabRule(rowRef: RefObject<HTMLDivElement | null>, tab: string, activeKey: string) {
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

const PAGE_PICKER_TABS = [
  { to: '/feed', label: 'For you', Icon: Stack },
  { to: '/following', label: 'Following', Icon: UserCheck },
];

export default function Navbar({ onOpenSearch = () => {}, searchOpen = false, onSearchSlot }: { onOpenSearch?: () => void; searchOpen?: boolean; onSearchSlot?: (node: HTMLDivElement | null) => void }) {
  const { user } = useAuth();
  const [arriving, setArriving] = useState(() => !navbarHasArrived);
  const handleArrived = (event: AnimationEvent<HTMLElement>) => {
    // Children animate too (the preferences sheet, the search state); only
    // the bar's own animationend retires the class, and mid-arrival a
    // child's would otherwise cut it short.
    if (event.target !== event.currentTarget) return;
    navbarHasArrived = true;
    setArriving(false);
  };
  const { setFeedMode } = useFeed();
  const navigate = useNavigate();
  const location = useLocation();
  const pathname = location.pathname === '/' ? '/' : location.pathname.replace(/\/+$/, '');
  // On /search the bar holds the page's own field, which SearchPage renders
  // into this slot; the shortcut focuses it rather than opening the palette.
  const onSearchPage = pathname === '/search';
  const searchSlotRef = useRef<HTMLDivElement | null>(null);
  const attachSearchSlot = useCallback((node: HTMLDivElement | null) => {
    searchSlotRef.current = node;
    onSearchSlot?.(node);
  }, [onSearchSlot]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      // Bound on `window`, so a modal dialog's inertness does not filter it:
      // the guard has to be asked explicitly (search-shortcut.ts).
      if (!shouldOpenSearchOnSlash(event, document)) return;
      event.preventDefault();
      if (onSearchPage) searchSlotRef.current?.querySelector('input')?.focus();
      else onOpenSearch();
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [onOpenSearch, onSearchPage]);

  const isFollowingActive = pathname === '/following';
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
  const activeTab = isHomeActive ? 'home' : isFollowingActive ? 'following' : '';
  const linksRef = useRef<HTMLDivElement | null>(null);
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
  const touchRef = useRef<{ tab: string; x: number; y: number; at: number } | null>(null);
  const handledRef = useRef(0);
  const pressTab = (event: PointerEvent<HTMLAnchorElement>, tab: string) => {
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
  const liftTab = (event: PointerEvent<HTMLAnchorElement>, tab: string, to: string) => {
    const start = touchRef.current;
    touchRef.current = null;
    if (event.pointerType !== 'touch' || !start || start.tab !== tab) return;
    if (Date.now() - start.at > 1500) return;
    if (Math.abs(event.clientX - start.x) > 12 || Math.abs(event.clientY - start.y) > 12) return;
    handledRef.current = Date.now();
    if (tab === 'home') setFeedMode('top');
    if (pathname !== to) void navigate(to);
  };
  const swallowSynthesisedClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (Date.now() - handledRef.current > 1500) return;
    handledRef.current = 0;
    event.preventDefault();
  };
  const rule = useActiveTabRule(linksRef, activeTab, activeTab);

  return (
    <nav
      className={arriving ? 'navbar navbar--arriving' : 'navbar'}
      onAnimationEnd={handleArrived}
      aria-label={'Main navigation'}
    >
      <div className={onSearchPage ? 'navbar-inner navbar-inner--search' : 'navbar-inner'}>
        {/* Sin `aria-label`. El botón ya se llama a sí mismo: el nombre sale de
            `.navbar-brand-word`, que dice «PaperTok» en texto. Con el
            `aria-label` puesto, la regla de 2.5.3 comparaba «PaperTok» con lo
            que se VE —la marca «PT» más la palabra— y la marca cuenta aunque
            sea `aria-hidden`, porque quien maneja la interfaz por voz la ve
            igual. Que el rótulo siga en el árbol por debajo de 768 px lo
            sostiene navbar.css: ahí se recorta, no se borra. */}
        <button
          type="button"
          className="navbar-brand"
          onClick={() => {
            if (location.pathname !== '/feed') void navigate('/feed');
          }}
        >
          <span className="navbar-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 17 10"><path d="M1.35 9.99Q0.70 9.99 0.43 9.79Q0.16 9.60 0.10 9.29Q0.05 8.99 0.05 8.67L0.05 1.31Q0.05 1.00 0.10 0.70Q0.16 0.40 0.43 0.21Q0.70 0.01 1.36 0.01L4.20 0.01Q4.74 0.01 5.37 0.24Q6.00 0.46 6.56 0.91Q7.12 1.37 7.48 2.05Q7.84 2.74 7.84 3.68Q7.84 4.61 7.48 5.29Q7.12 5.98 6.56 6.43Q6.00 6.88 5.37 7.10Q4.74 7.32 4.18 7.32L2.66 7.32L2.66 8.69Q2.66 9.00 2.60 9.30Q2.54 9.60 2.27 9.79Q2.00 9.99 1.35 9.99ZM2.66 2.62L2.66 4.71L4.20 4.71Q4.38 4.71 4.63 4.61Q4.87 4.52 5.05 4.29Q5.24 4.07 5.24 3.67Q5.24 3.37 5.10 3.13Q4.96 2.90 4.72 2.76Q4.48 2.62 4.18 2.62L2.66 2.62ZM9.35 0.00L15.87 0.00Q16.14 0.00 16.38 0.04Q16.62 0.09 16.79 0.31Q16.95 0.54 16.95 1.10Q16.95 1.64 16.79 1.88Q16.62 2.11 16.37 2.15Q16.12 2.20 15.85 2.20L13.89 2.20L13.89 8.73Q13.89 9.04 13.83 9.34Q13.77 9.63 13.51 9.81Q13.24 10 12.59 10Q11.96 10 11.69 9.81Q11.42 9.61 11.37 9.32Q11.32 9.03 11.32 8.72L11.32 2.20L9.33 2.20Q9.08 2.20 8.83 2.15Q8.58 2.10 8.41 1.87Q8.25 1.64 8.25 1.08Q8.25 0.54 8.41 0.31Q8.58 0.09 8.84 0.04Q9.09 0.00 9.35 0.00Z" /></svg>
          </span>
          <span className="navbar-brand-word">Paper<span>Tok</span></span>
        </button>

        {/* Open, the bar holds the state it put the reader in. Without it you
            clicked a bar and a sheet appeared somewhere else, with nothing
            connecting the two — and closing left nothing behind either. The
            transition is already on the element, so the state fades in and out
            rather than snapping. */}
        {/* On a phone the field takes the tabs' place, so the tabs move into
            this picker (hidden on wider screens, where the tabs show). */}
        {onSearchPage && (
          <Menu.Root>
            <Menu.Trigger className="navbar-page-picker" aria-label={'Search, switch page'}>
              {'Search'}
              <CaretDown size={12} aria-hidden="true" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner className="account-menu-positioner" align="start" sideOffset={8}>
                <Menu.Popup className="account-menu navbar-page-menu">
                  {PAGE_PICKER_TABS.map(({ to, label, Icon }) => (
                    <Menu.LinkItem key={to} className="account-menu-item" closeOnClick render={<Link to={to} />} onClick={to === '/feed' ? () => setFeedMode('top') : undefined}>
                      <Icon size={17} aria-hidden="true" /> {label}
                    </Menu.LinkItem>
                  ))}
                  <Menu.LinkItem className="account-menu-item" closeOnClick aria-current="page" render={<Link to={`/search${location.search}`} />}>
                    <MagnifyingGlass size={17} aria-hidden="true" /> {'Search'}
                    <Check size={15} aria-hidden="true" className="navbar-page-menu-check" />
                  </Menu.LinkItem>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        )}

        {onSearchPage ? (
          <div className="navbar-search-slot" ref={attachSearchSlot} />
        ) : (
          <button
            type="button"
            className={`navbar-search ${searchOpen ? 'is-open' : ''}`}
            onClick={onOpenSearch}
            aria-expanded={searchOpen}
          >
            <MagnifyingGlass size={15} aria-hidden="true" />
            <span>{'Search papers, authors, topics...'}</span>
            <kbd aria-hidden="true">{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
        )}

        <div className="navbar-links" ref={linksRef}>
          <span
            className={`navbar-link-rule${rule.measured ? ' is-measured' : ''}`}
            aria-hidden="true"
            style={{ transform: rule.transform || undefined, opacity: rule.transform ? 1 : 0 }}
          />
          {/* A NavLink like Following, not a <button> that calls
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
            <Stack size={15} aria-hidden="true" />
            {'For you'}
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
            {'Following'}
          </NavLink>
        </div>

        <div className="navbar-right">
          {!onSearchPage && (
            <button
              className={`navbar-icon-btn navbar-icon-btn--search-compact ${searchOpen ? 'is-open' : ''}`}
              aria-expanded={searchOpen}
              onClick={onOpenSearch}
              title={'Search'}
              aria-label={'Search'}
            >
              <MagnifyingGlass size={17} />
            </button>
          )}

          {user && (
            <div className="navbar-profile">
              <AccountMenu />
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
