import type { KeyboardEvent, MouseEvent, PointerEvent, ReactElement } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowRight, PencilSimple, Trash } from '@phosphor-icons/react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ui/context-menu.tsx';
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import { actionStart, toastError } from '../ui/toast.ts';
import { createLongPress } from '../feed/long-press.ts';
import { useCustomFeeds } from '../../hooks/use-custom-feeds.ts';
import useIsPhone from '../../hooks/use-is-phone.ts';
import { feedMovedAnnouncement, feedTabMoves, tabAfterDelete, type holdOutcome } from '../../utils/feed-tab-menu.ts';
import { allFeedTabs, customFeedIdFromPath } from '../../utils/feed-tabs.ts';
// The phone's drawer rows are the rail menus' (52px, share-panel.css).
import '../feed/share-panel.css';
import './feed-tab-menu.css';

type Command = 'edit' | 'left' | 'right' | 'delete';

const COPY = {
  edit: 'Edit feed',
  left: 'Move left',
  right: 'Move right',
  delete: 'Delete feed',
  moveFailed: 'The order could not be saved',
  tryAgain: 'Try again.',
};

/**
 * A feed's tab in the bar and its menu: Edit feed, Move left, Move right and
 * Delete feed. The same four are buttons in Settings › Feeds, the way that
 * needs no gesture.
 *
 * The tab (`link`, a NavLink the bar draws) is the menu's trigger itself,
 * rendered as the link, so the line holds the link and nothing around it: the
 * yellow rule, the edge fades and the reveal measure the link's own box.
 *
 * - A right click opens the menu under the tab, and so do the keyboard's menu
 *   key and Shift+F10 on the focused tab. Those are handled here rather than
 *   left to the browser, which sends nothing for them on a Mac.
 * - On a phone (`useIsPhone`) a finger held on the tab for half a second
 *   opens the commands as a drawer of 52px rows. Wider touch screens hold the
 *   tab through the context menu's own long press.
 *
 * Every opening asks the bar first (`onHold`): when a finger is pressing the
 * tab, the bar ends that press there, so lifting the finger does not also
 * navigate, and refuses a hold during which the line moved, as it refuses
 * such a tap.
 *
 * A command runs once the menu has left and given focus back to the tab, so
 * the window it opens (Edit feed, the delete confirmation) returns focus to
 * the tab in turn. After a move focus stays on the tab; after a delete it
 * goes to the tab that takes its place.
 *
 * Opened from the keyboard, the menu takes focus on its popup and the arrow
 * keys reach the items: Base UI 1.8 highlights the first item only for its
 * own trigger keys and offers no supported way to ask for it here.
 */
export default function FeedTabMenu({ feedId, name, link, onHold, onAnnounce }: {
  feedId: string;
  name: string;
  link: ReactElement;
  onHold: () => ReturnType<typeof holdOutcome>;
  onAnnounce: (text: string) => void;
}) {
  const { feeds, moveFeed, openFeedEditor, confirmDeleteFeed } = useCustomFeeds();
  const { pathname } = useLocation();
  const isPhone = useIsPhone();
  const moves = feedTabMoves(feeds, feedId);
  const linkRef = useRef<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const chosen = useRef<Command | null>(null);

  // The phone's hold, made at each press with that render's `onHold` and
  // kept until the next, so a re-render during the hold keeps it.
  const holdRef = useRef<ReturnType<typeof createLongPress> | null>(null);
  const pressForHold = (event: PointerEvent) => {
    holdRef.current?.onPointerCancel();
    holdRef.current = createLongPress(() => {
      if (onHold() !== 'refused') setSheetOpen(true);
    });
    holdRef.current.onPointerDown(event);
  };
  // A tab that leaves mid-hold must not open its drawer afterwards.
  useEffect(() => () => holdRef.current?.onPointerCancel(), []);

  // A swap of two tabs puts one of their links back into the line, and the
  // browser takes focus off a link it re-inserts. Once the new order has
  // rendered, focus that was on this tab, or fell to the page from it, goes
  // back to it; focus the reader put elsewhere meanwhile stays there.
  const [settledMoves, setSettledMoves] = useState(0);
  const refocusAfterMove = useRef(false);
  useLayoutEffect(() => {
    if (!refocusAfterMove.current) return;
    refocusAfterMove.current = false;
    const focused = document.activeElement;
    const link = linkRef.current;
    if (link && (!focused || focused === document.body || focused === link)) link.focus({ preventScroll: true });
  }, [settledMoves]);

  const move = async (delta: -1 | 1) => {
    const startedAt = actionStart();
    const said = feedMovedAnnouncement(feeds, feedId, delta);
    // Run as the menu leaves, while focus is on its way back to the tab.
    const focused = document.activeElement;
    const focusWasHere = !focused || focused === document.body || focused === linkRef.current || focused.closest('[role="menu"], [role="dialog"]') !== null;
    try {
      await moveFeed(feedId, delta);
      if (said) onAnnounce(said);
      refocusAfterMove.current = focusWasHere;
      setSettledMoves(current => current + 1);
    } catch (error) {
      // Nothing moved before the write committed, so the tabs are still the server's order.
      console.error('The order could not be saved', error);
      toastError(COPY.moveFailed, { description: COPY.tryAgain, startedAt });
    }
  };

  // Deleted, this tab leaves the bar, so focus goes to the tab that takes its
  // place. Not when this feed is the page on screen: that page goes to For
  // you and the route announcer moves focus to the new page.
  const confirmDelete = () => {
    if (customFeedIdFromPath(pathname) === feedId) {
      confirmDeleteFeed(feedId);
      return;
    }
    const target = tabAfterDelete(allFeedTabs(feeds).map(tab => tab.key), `feed:${feedId}`);
    confirmDeleteFeed(feedId, {
      focusAfterDelete: () => document.querySelector<HTMLElement>(`.navbar-link[data-tab="${CSS.escape(target)}"]`),
    });
  };

  const settle = (open: boolean) => {
    if (open) return;
    const command = chosen.current;
    chosen.current = null;
    if (command === 'edit') openFeedEditor({ feedId });
    else if (command === 'delete') confirmDelete();
    else if (command) void move(command === 'left' ? -1 : 1);
  };

  // Back to the tab when focus left with the menu, not when the reader closed
  // it by putting focus somewhere else.
  const returnFocus = () => {
    const focused = document.activeElement;
    const leftWithMenu = !focused || focused === document.body || focused.closest('[role="menu"], [role="dialog"]') !== null;
    return leftWithMenu ? linkRef.current : false;
  };

  const openFromKeyboard = (event: KeyboardEvent) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    if (isPhone) setSheetOpen(true);
    else setMenuOpen(true);
  };

  const sheetRow = (command: Command, Icon: typeof PencilSimple, disabled = false) => (
    <li>
      <button
        type="button"
        className={`pc-share-row${command === 'delete' ? ' feed-tab-menu-danger' : ''}`}
        disabled={disabled}
        onClick={() => {
          chosen.current = command;
          setSheetOpen(false);
        }}
      >
        <Icon size={20} aria-hidden="true" />
        {COPY[command]}
      </button>
    </li>
  );

  return (
    <>
      <ContextMenu
        open={menuOpen}
        disabled={isPhone}
        onOpenChange={(open, details) => {
          // A finger held on the tab of a touch screen wider than a phone,
          // through the menu's own long press or the browser's `contextmenu`.
          if (open && onHold() === 'refused') {
            details.cancel();
            return;
          }
          setMenuOpen(open);
        }}
        onOpenChangeComplete={settle}
      >
        <ContextMenuTrigger
          // Typed for the <div> it would draw; it draws the tab's <a>.
          ref={(node) => { linkRef.current = node; }}
          render={link}
          onKeyDown={openFromKeyboard}
          {...(isPhone ? {
            onPointerDown: pressForHold,
            onPointerMove: (event: PointerEvent) => holdRef.current?.onPointerMove(event),
            onPointerUp: () => holdRef.current?.onPointerUp(),
            onPointerCancel: () => holdRef.current?.onPointerCancel(),
            onContextMenu: (event: MouseEvent) => holdRef.current?.onContextMenu(event),
          } : {})}
        />
        <ContextMenuContent anchor={linkRef} side="bottom" sideOffset={4} aria-label={name} finalFocus={returnFocus}>
          <ContextMenuItem onClick={() => { chosen.current = 'edit'; }}>
            <PencilSimple size={16} aria-hidden="true" />
            {COPY.edit}
          </ContextMenuItem>
          <ContextMenuItem disabled={!moves.left} onClick={() => { chosen.current = 'left'; }}>
            <ArrowLeft size={16} aria-hidden="true" />
            {COPY.left}
          </ContextMenuItem>
          <ContextMenuItem disabled={!moves.right} onClick={() => { chosen.current = 'right'; }}>
            <ArrowRight size={16} aria-hidden="true" />
            {COPY.right}
          </ContextMenuItem>
          <ContextMenuItem className="feed-tab-menu-danger" onClick={() => { chosen.current = 'delete'; }}>
            <Trash size={16} aria-hidden="true" />
            {COPY.delete}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isPhone && (
        <Drawer open={sheetOpen} onOpenChange={setSheetOpen} onOpenChangeComplete={settle}>
          <DrawerContent className="pc-share-sheet feed-tab-menu-sheet" finalFocus={returnFocus}>
            <DrawerHandle />
            <DrawerTitle render={<h2 />} className="pc-share-sheet-title feed-tab-menu-title">
              <span dir="auto">{name}</span>
            </DrawerTitle>
            <ul className="pc-menu-group">
              {sheetRow('edit', PencilSimple)}
              {sheetRow('left', ArrowLeft, !moves.left)}
              {sheetRow('right', ArrowRight, !moves.right)}
              {sheetRow('delete', Trash)}
            </ul>
          </DrawerContent>
        </Drawer>
      )}
    </>
  );
}
