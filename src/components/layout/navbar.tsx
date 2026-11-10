import type { AnimationEvent, MouseEvent, PointerEvent, RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { Menu } from '@base-ui/react/menu';
import { useReducedMotion } from 'framer-motion';
import { animateSize, EASE_OUT } from '../../utils/motion-curves.ts';
import { ruleTransform } from '../../utils/nav-rule.ts';
import { fadingEdges, lineScrollEvent, pressedStillLine, revealScrollLeft } from '../../utils/scroll-line.ts';
import { useAuth } from '../../context/auth-context.tsx';
import { useFeed } from '../../context/feed-context.tsx';
import { useFollowingUpdates } from '../../context/following-updates-context.tsx';
import { useCustomFeeds } from '../../hooks/use-custom-feeds.ts';
import { useFeedTabs } from '../../hooks/use-feed-tabs.ts';
import type { Icon } from '@phosphor-icons/react';
import type { FeedTabEntry, FeedTabKey } from '../../utils/feed-tabs.ts';
import { CaretDown, Check, MagnifyingGlass, Plus, Stack, UserCheck } from '@phosphor-icons/react';
import { customFeedIdFromPath } from '../../utils/feed-tabs.ts';
import AccountMenu from './account-menu.tsx';
import RailMenu from '../feed/rail-menu.tsx';
import FeedTabMenu from '../custom-feeds/feed-tab-menu.tsx';
import { holdOutcome } from '../../utils/feed-tab-menu.ts';
import { DrawerClose } from '../ui/drawer.tsx';
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
 * doing. This hook measures the active link — when the active tab or the
 * list of tabs changes, and again when the row or any link resizes (the
 * active link is semibold, so activating one changes its width and shifts its
 * neighbours) — and returns the transform. The first
 * measurement is applied without a transition, so the rule does not slide in
 * from the row's left edge on load.
 *
 * The row scrolls sideways once the reader's feeds no longer fit, and the rule
 * is its child, so it scrolls with the tabs: the transform is in the row's
 * content coordinates, which is why the row's left edge is taken back by its
 * `scrollLeft`. Scrolling then changes nothing this measures, and the rule
 * needs no re-measuring on scroll. The tabs changing (a feed created, renamed,
 * moved or deleted) re-runs the effect, so the new links are observed too.
 * A feed's tab is its menu's trigger rendered as the link itself
 * (feed-tab-menu.tsx), so the line holds links alone and each is measured by
 * its own box.
 */
function useActiveTabRule(rowRef: RefObject<HTMLDivElement | null>, tab: string, tabs: readonly FeedTabEntry[]) {
  const [rule, setRule] = useState({ transform: '', measured: false });

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const measure = () => {
      // By `data-tab` rather than `.active`: the hook is told which tab to
      // measure, so the caller owns that decision and this cannot drift from
      // the class the router appends.
      const link = tab ? tabLink(row, tab) : null;
      if (!link) {
        setRule(current => (current.transform ? { ...current, transform: '' } : current));
        return;
      }
      const inset = parseFloat(getComputedStyle(link).paddingLeft) || 0;
      const transform = ruleTransform(link.getBoundingClientRect(), row.getBoundingClientRect().left - row.scrollLeft, inset);
      setRule(current => (current.transform === transform && current.measured ? current : { transform, measured: true }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    row.querySelectorAll('.navbar-link').forEach(link => observer.observe(link));
    return () => observer.disconnect();
  }, [rowRef, tab, tabs]);

  return rule;
}

function tabLink(row: HTMLElement, tab: string) {
  return row.querySelector<HTMLElement>(`.navbar-link[data-tab="${CSS.escape(tab)}"]`);
}

/**
 * Which ends of the tab line have more tabs beyond them. navbar.css fades
 * those ends, and only those: an end with nothing past it stays sharp.
 * Re-read on scroll and whenever the row or a tab changes size.
 */
function useScrollLineEdges(rowRef: RefObject<HTMLDivElement | null>, tabs: readonly FeedTabEntry[]) {
  const [edges, setEdges] = useState({ start: false, end: false });

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const measure = () => {
      const next = fadingEdges(row.scrollLeft, row.scrollWidth, row.clientWidth);
      setEdges(current => (current.start === next.start && current.end === next.end ? current : next));
    };
    measure();
    row.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(row);
    row.querySelectorAll('.navbar-link').forEach(link => observer?.observe(link));
    return () => {
      row.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [rowRef, tabs]);

  return edges;
}

/**
 * The time of the tab line's last `scroll` event, so a press can tell whether
 * it landed on a line still gliding (see `pressedStillLine`).
 *
 * The line's own reveal of the current tab (`useRevealActiveTab`) is not the
 * line gliding under a finger: it records the `scrollLeft` it heads for in
 * `revealToRef`, and its events are not counted until the line gets there
 * (`lineScrollEvent`) or stops (`scrollend`). A finger that touches the line
 * meanwhile takes it over, so from that press on every event counts again.
 */
function useLineScrollClock(rowRef: RefObject<HTMLDivElement | null>) {
  const lastScrollAtRef = useRef(-Infinity);
  const revealToRef = useRef<number | null>(null);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const tick = () => {
      const event = lineScrollEvent(revealToRef.current, row.scrollLeft);
      revealToRef.current = event.revealTo;
      if (event.moved) lastScrollAtRef.current = Date.now();
    };
    const endReveal = () => { revealToRef.current = null; };
    row.addEventListener('scroll', tick, { passive: true });
    row.addEventListener('scrollend', endReveal);
    row.addEventListener('pointerdown', endReveal, { capture: true, passive: true });
    return () => {
      row.removeEventListener('scroll', tick);
      row.removeEventListener('scrollend', endReveal);
      row.removeEventListener('pointerdown', endReveal, { capture: true });
    };
  }, [rowRef]);

  return { lastScrollAtRef, revealToRef };
}

/**
 * Brings the current tab into view inside the line when it changes, when it
 * first appears (a feed's tab arrives after its page on a cold load), and when
 * the tabs change around it so that it moves within the line (a feed before it
 * renamed, created, moved or deleted): the position it was revealed at is kept
 * with it. A tab that did not move is left where the reader scrolled it.
 *
 * Not `scrollIntoView`: that scrolls every scrollable ancestor too, and the
 * page under a fixed bar must not move because a tab changed. This scrolls
 * the line alone, by the least distance, keeping the fade's width clear
 * (`scroll-padding-inline`, the same space keyboard focus keeps), and without
 * motion on the first placement or when the reader asks for reduced motion.
 * Where it heads goes in `revealToRef`, so the scroll clock knows the events
 * that follow are the line's own.
 */
function useRevealActiveTab(rowRef: RefObject<HTMLDivElement | null>, tab: string, tabs: readonly FeedTabEntry[], revealToRef: RefObject<number | null>) {
  const reduceMotion = useReducedMotion();
  const revealedRef = useRef<{ tab: string; left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    if (!tab) {
      if (revealedRef.current) revealedRef.current = { tab: '', left: 0, width: 0 };
      return;
    }
    const link = tabLink(row, tab);
    if (!link) return;
    const rect = link.getBoundingClientRect();
    const origin = row.getBoundingClientRect().left - row.scrollLeft;
    const itemLeft = rect.left - origin;
    const last = revealedRef.current;
    if (last && last.tab === tab && Math.abs(last.left - itemLeft) < 1 && Math.abs(last.width - rect.width) < 1) return;
    const first = last === null;
    revealedRef.current = { tab, left: itemLeft, width: rect.width };
    const padding = parseFloat(getComputedStyle(row).scrollPaddingLeft) || 0;
    const left = revealScrollLeft(itemLeft, rect.width, row.scrollLeft, row.clientWidth, padding);
    if (Math.abs(left - row.scrollLeft) < 1) return;
    // Where the line can actually get to, or the reveal would never arrive.
    revealToRef.current = Math.min(left, row.scrollWidth - row.clientWidth);
    row.scrollTo({ left, behavior: first || reduceMotion ? 'instant' : 'smooth' });
  }, [rowRef, tab, tabs, reduceMotion, revealToRef]);
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

const TAB_ICONS: Record<FeedTabKey, Icon> = { home: Stack, following: UserCheck };

const isFixedTab = (key: string): key is FeedTabKey => Object.hasOwn(TAB_ICONS, key);

/**
 * A tab's name. The fixed tabs carry their icon; a feed's tab is its name
 * alone, as the reader wrote it: in its own direction (`dir="auto"` isolates
 * a right-to-left name from the bar), cut with an ellipsis by navbar.css when
 * long. The text stays whole, so the accessible name does.
 */
function TabName({ tab, iconSize }: { tab: FeedTabEntry; iconSize: number }) {
  if (!isFixedTab(tab.key)) return <span className="navbar-link-label" dir="auto">{tab.label}</span>;
  const TabIcon = TAB_ICONS[tab.key];
  return <><TabIcon size={iconSize} aria-hidden="true" />{tab.label}</>;
}

/**
 * A tab of the line. A feed's tab is also its menu's trigger (FeedTabMenu),
 * rendered as this same link, so nothing wraps it in the line.
 */
function FeedTabLink({ tab, active, onTabClick, onTabPress, onTabLift, onTabRelease, onTabHold, onAnnounce }: {
  tab: FeedTabEntry;
  active: boolean;
  onTabClick: (event: MouseEvent<HTMLAnchorElement>, tab: FeedTabEntry) => void;
  onTabPress: (event: PointerEvent<HTMLAnchorElement>, tab: FeedTabEntry) => void;
  onTabLift: (event: PointerEvent<HTMLAnchorElement>, tab: FeedTabEntry) => void;
  onTabRelease: () => void;
  onTabHold: (tab: FeedTabEntry) => ReturnType<typeof holdOutcome>;
  onAnnounce: (text: string) => void;
}) {
  const link = (
    <NavLink
      to={tab.path}
      end
      data-tab={tab.key}
      className={`navbar-link ${active ? 'active' : ''}`}
      onClick={(event) => onTabClick(event, tab)}
      onPointerDown={(event) => onTabPress(event, tab)}
      onPointerUp={(event) => onTabLift(event, tab)}
      onPointerCancel={onTabRelease}
    >
      <TabName tab={tab} iconSize={15} />
    </NavLink>
  );
  const feedId = customFeedIdFromPath(tab.path);
  if (!feedId) return link;
  return <FeedTabMenu feedId={feedId} name={tab.label} link={link} onHold={() => onTabHold(tab)} onAnnounce={onAnnounce} />;
}

function PagePicker({ search, tabs }: { search: string; tabs: readonly FeedTabEntry[] }) {
  const searchRow = `/search${search}`;
  return (
    <RailMenu
      title={'Go to'}
      side="bottom"
      align="start"
      trigger={(
        <button type="button" className="navbar-page-picker" aria-label={'Search, switch page'}>
          {'Search'}
          <CaretDown size={12} aria-hidden="true" />
        </button>
      )}
      menu={(
        <>
          {tabs.map(tab => (
            <Menu.LinkItem key={tab.key} className="pc-share-menu-item" closeOnClick render={<Link to={tab.path} />}>
              <TabName tab={tab} iconSize={16} />
            </Menu.LinkItem>
          ))}
          <Menu.LinkItem className="pc-share-menu-item navbar-page-row" closeOnClick aria-current="page" render={<Link to={searchRow} />}>
            <MagnifyingGlass size={16} aria-hidden="true" /> {'Search'}
            <Check size={15} aria-hidden="true" className="navbar-page-check" />
          </Menu.LinkItem>
        </>
      )}
      sheet={(
        <>
          {tabs.map(tab => (
            <li key={tab.key}>
              <Link to={tab.path} className="pc-share-row">
                <TabName tab={tab} iconSize={20} />
              </Link>
            </li>
          ))}
          <li>
            <DrawerClose className="pc-share-row navbar-page-row" aria-current="page">
              <MagnifyingGlass size={20} aria-hidden="true" /> {'Search'}
              <Check size={18} aria-hidden="true" className="navbar-page-check" />
            </DrawerClose>
          </li>
        </>
      )}
    />
  );
}

function useSearchFieldResize(fieldRef: RefObject<HTMLElement | null>, onSearchPage: boolean) {
  const widthRef = useRef(0);
  const reduceMotion = useReducedMotion();

  useLayoutEffect(() => {
    const field = fieldRef.current;
    const from = widthRef.current;
    if (!field || reduceMotion || !from || !field.offsetWidth) return;
    // The field's flex rules would override the width it animates through.
    animateSize(field, 'width', from, 260, EASE_OUT, { flex: 'none' });
  }, [fieldRef, onSearchPage, reduceMotion]);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const observer = new ResizeObserver(() => { widthRef.current = field.offsetWidth; });
    observer.observe(field);
    return () => observer.disconnect();
  }, [fieldRef, onSearchPage]);
}

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
  const { setFeedMode, refreshFeed, isRefreshing } = useFeed();
  const followingUpdates = useFollowingUpdates();
  const { openFeedEditor, requestRefresh } = useCustomFeeds();
  // The fixed tabs, then the reader's feeds once they have loaded; until then
  // the line holds the fixed tabs and the "+".
  const tabs = useFeedTabs();
  const navigate = useNavigate();
  const location = useLocation();
  const pathname = location.pathname === '/' ? '/' : location.pathname.replace(/\/+$/, '');
  const onSearchPage = pathname === '/search';
  const searchFieldRef = useRef<HTMLElement | null>(null);
  const attachSearchField = useCallback((node: HTMLElement | null) => {
    searchFieldRef.current = node;
  }, []);
  const attachSearchSlot = useCallback((node: HTMLDivElement | null) => {
    searchFieldRef.current = node;
    onSearchSlot?.(node);
  }, [onSearchSlot]);
  useSearchFieldResize(searchFieldRef, onSearchPage);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      // Bound on `window`, so a modal dialog's inertness does not filter it:
      // the guard has to be asked explicitly (search-shortcut.ts).
      if (onSearchPage || !shouldOpenSearchOnSlash(event, document)) return;
      event.preventDefault();
      onOpenSearch();
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [onOpenSearch, onSearchPage]);

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
  // in NavLink's plain API gates `aria-current`. The reader's own feeds are
  // tabs in the same list, and the same holds for them: a feed's tab is
  // current when the pathname is its `/feeds/<id>`.
  const activeTab = tabs.find(tab => tab.path === pathname)?.key ?? '';
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
  const touchRef = useRef<{ tab: string; x: number; y: number; at: number; scrollLeft: number } | null>(null);
  const handledRef = useRef<{ tab: string; at: number } | null>(null);
  const { lastScrollAtRef: lastLineScrollAtRef, revealToRef } = useLineScrollClock(linksRef);
  const pressTab = (event: PointerEvent<HTMLAnchorElement>, tab: FeedTabEntry) => {
    if (event.button !== 0 || event.pointerType !== 'touch') return;
    const scrollLeft = linksRef.current?.scrollLeft ?? 0;
    touchRef.current = { tab: tab.key, x: event.clientX, y: event.clientY, at: Date.now(), scrollLeft };
  };
  /** For you starts from its top mode; pressing the tab you are already on reloads its feed. */
  const chooseTab = (tab: FeedTabEntry) => {
    if (tab.key === 'home') setFeedMode('top');
    if (pathname !== tab.path) return;
    const customFeedId = customFeedIdFromPath(tab.path);
    if (customFeedId) requestRefresh(customFeedId);
    else if (tab.key === 'following') void followingUpdates.refresh();
    else if (!isRefreshing) void refreshFeed();
  };
  const releasePress = () => {
    touchRef.current = null;
  };
  /** Whether the line stayed still from a press until now (`pressedStillLine`). */
  const pressedStillSince = (start: { at: number; scrollLeft: number }) => pressedStillLine({
    pressedAt: start.at,
    lastScrollAt: lastLineScrollAtRef.current,
    scrollLeftAtPress: start.scrollLeft,
    scrollLeftAtLift: linksRef.current?.scrollLeft ?? 0,
  });
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
   * would need two presses. It holds the tab it was set for, and swallows a
   * click on that tab only: a tap on another tab right after is its own.
   *
   * The tabs scroll sideways once the reader's feeds fill the line, and two
   * presses on it are not taps. A finger that drags the line: the browser
   * takes the pan and sends `pointercancel`, which forgets the press, and a
   * slower drag still fails the 12px test before it lifts. A finger that
   * touches the line while it still glides from a fling, to stop it: no pan
   * starts, so no `pointercancel` comes, and the browser suppresses the click
   * instead. `pressedStillLine` (utils/scroll-line.ts) refuses that press, and
   * any press during which the line moved, so it neither navigates nor reloads
   * the tab under the finger; the click is swallowed too, in case one comes.
   * A tap on a still line is unchanged.
   */
  const liftTab = (event: PointerEvent<HTMLAnchorElement>, tab: FeedTabEntry) => {
    const start = touchRef.current;
    touchRef.current = null;
    if (event.pointerType !== 'touch' || !start || start.tab !== tab.key) return;
    if (Date.now() - start.at > 1500) return;
    if (Math.abs(event.clientX - start.x) > 12 || Math.abs(event.clientY - start.y) > 12) return;
    handledRef.current = { tab: tab.key, at: Date.now() };
    if (!pressedStillSince(start)) return;
    chooseTab(tab);
    if (pathname !== tab.path) void navigate(tab.path);
  };
  /**
   * A feed's tab menu (FeedTabMenu) asks here whenever it opens. When a finger
   * is pressing that tab, however the menu came to open, the press ends there,
   * so the finger lifting neither chooses nor reloads the tab, and a click
   * that follows is swallowed as after a tap; a press during which the line
   * moved is refused, as such a tap is (`holdOutcome`).
   */
  const holdTab = (tab: FeedTabEntry) => {
    const start = touchRef.current;
    const outcome = holdOutcome(start?.tab ?? null, tab.key, () => start !== null && pressedStillSince(start));
    if (outcome === 'none') return outcome;
    touchRef.current = null;
    handledRef.current = { tab: tab.key, at: Date.now() };
    return outcome;
  };
  const handleTabClick = (event: MouseEvent<HTMLAnchorElement>, tab: FeedTabEntry) => {
    const handled = handledRef.current;
    if (handled?.tab === tab.key && Date.now() - handled.at <= 1500) {
      handledRef.current = null;
      event.preventDefault();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (pathname === tab.path) event.preventDefault();
    chooseTab(tab);
  };
  // A move made from a tab's menu, said once it is saved; numbered so the same
  // words said twice change the status line and are announced again.
  const [moved, setMoved] = useState({ text: '', n: 0 });
  const announceMove = useCallback((text: string) => {
    setMoved(current => ({ text, n: current.n + 1 }));
  }, []);
  const rule = useActiveTabRule(linksRef, activeTab, tabs);
  const edges = useScrollLineEdges(linksRef, tabs);
  useRevealActiveTab(linksRef, activeTab, tabs, revealToRef);

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

        {onSearchPage && <PagePicker search={location.search} tabs={tabs} />}

        {/* Open, the bar holds the state it put the reader in. Without it you
            clicked a bar and a sheet appeared somewhere else, with nothing
            connecting the two — and closing left nothing behind either. The
            transition is already on the element, so the state fades in and out
            rather than snapping. */}
        {onSearchPage ? (
          <div className="navbar-search-slot" ref={attachSearchSlot} />
        ) : (
          <button
            type="button"
            ref={attachSearchField}
            className={`navbar-search ${searchOpen ? 'is-open' : ''}`}
            onClick={onOpenSearch}
            aria-expanded={searchOpen}
          >
            <MagnifyingGlass size={15} aria-hidden="true" />
            <span>{'Search papers, authors, topics...'}</span>
            <kbd aria-hidden="true">{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
        )}

        <div
          className="navbar-links"
          ref={linksRef}
          data-fade-start={edges.start || undefined}
          data-fade-end={edges.end || undefined}
        >
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
          {tabs.map(tab => (
            <FeedTabLink
              key={tab.key}
              tab={tab}
              active={pathname === tab.path}
              onTabClick={handleTabClick}
              onTabPress={pressTab}
              onTabLift={liftTab}
              onTabRelease={releasePress}
              onTabHold={holdTab}
              onAnnounce={announceMove}
            />
          ))}
          {/* The last item of the line. Never current, so the rule never
              comes here (it has no `data-tab`). */}
          <button
            type="button"
            className="navbar-link navbar-link--add"
            aria-label={'New feed'}
            title={'New feed'}
            onClick={() => openFeedEditor()}
          >
            <Plus size={15} aria-hidden="true" />
          </button>
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
      {/* Present before the first move: a live region speaks only when its
          text changes. Every other announcement ends in a no-break space. */}
      <p className="visually-hidden" role="status">{moved.n % 2 ? `${moved.text}\u00A0` : moved.text}</p>
    </nav>
  );
}
