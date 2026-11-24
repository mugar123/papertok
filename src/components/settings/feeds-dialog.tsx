import type { ComponentType, ReactNode, Ref } from 'react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowsClockwise, ArrowUp, CircleNotch, CloudSlash, PencilSimple, Plus, Trash, Tray } from '@phosphor-icons/react';
import type { IconProps } from '@phosphor-icons/react';
import { useCustomFeeds } from '../../hooks/use-custom-feeds.ts';
import useIsPhone from '../../hooks/use-is-phone.ts';
import { feedPositionSentence, MAX_CUSTOM_FEEDS } from '../../utils/custom-feeds.ts';
import { actionStart, toastError } from '../ui/toast.ts';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import { feedRows, focusAfterMove, liveStatusText, rowAfterDelete, type FeedRow } from './feeds-settings-rows.ts';
import './edit-interests-modal.css';
import './settings-sheet.css';
import './feeds-dialog.css';

type Direction = 'up' | 'down';

const COPY = {
  title: 'Feeds',
  description: 'Each feed is a tab after Following, in this order.',
  newFeed: 'New feed',
  count: (n: number) => `${n} of ${MAX_CUSTOM_FEEDS} feeds`,
  loading: 'Loading your feeds...',
  unavailableTitle: 'Your feeds could not be loaded',
  unavailable: 'Check your connection and try again.',
  tryAgain: 'Try again',
  emptyTitle: 'You have no feeds yet',
  empty: 'A feed is a tab of its own, made from areas, topics, authors, journals and keywords.',
  order: { newest: 'Newest first', best: 'Best match' },
  moveFailed: 'The order could not be saved',
};

/**
 * Settings › Discovery › Feeds: the account's feeds in their tab order, each
 * with Move up, Move down, Edit and Delete, and New feed at the foot. These
 * are the commands of a feed tab's menu (feed-tab-menu.tsx), here as visible
 * buttons, so none of them needs a right click or a long press.
 *
 * A dialog on a desktop and a bottom drawer on a phone, as Interests is. Edit
 * and Delete open the feed window and the delete confirmation over it, and
 * focus comes back here when they close.
 */
export default function FeedsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const isPhone = useIsPhone();
  const { feeds, status, moveFeed, openFeedEditor, confirmDeleteFeed, retry } = useCustomFeeds();
  const rows = useMemo(() => feedRows(feeds), [feeds]);

  // Feeds whose move is being saved; their move buttons wait for it.
  const [moving, setMoving] = useState<ReadonlySet<string>>(() => new Set());
  // A confirmed move is worded once, in the first render after it resolves,
  // which already shows the order the write committed.
  const [confirmedMoveId, setConfirmedMoveId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState({ text: '', n: 0 });
  if (confirmedMoveId !== null) {
    setConfirmedMoveId(null);
    setAnnouncement(current => ({ text: feedPositionSentence(feeds, confirmedMoveId), n: current.n + 1 }));
  }

  // After a move settles, focus goes back to the row's move buttons: the
  // pressed one, or the other when the feed reached an end. The row can be
  // put back in the DOM as the list reorders, which drops its focus, so the
  // hand-off also covers focus that fell to the body.
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusHandOff = useRef<{ id: string; pressed: Direction } | null>(null);
  useLayoutEffect(() => {
    const handOff = focusHandOff.current;
    if (!handOff || moving.has(handOff.id)) return;
    focusHandOff.current = null;
    const row = rows.find(entry => entry.feed.id === handOff.id);
    if (!row) return;
    const { activeElement, body } = document;
    if (activeElement !== body && activeElement !== moveButtons.current.get(`${handOff.id}:${handOff.pressed}`)) return;
    const target = focusAfterMove(row, handOff.pressed);
    if (target) moveButtons.current.get(`${handOff.id}:${target}`)?.focus();
  });

  // A deleted feed's row leaves with the button that asked, so focus goes to
  // the Edit button of the row that takes its place, else of the row before
  // it, else to New feed.
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const newFeedButton = useRef<HTMLButtonElement | null>(null);
  const confirmDelete = (id: string) => {
    const nextId = rowAfterDelete(feeds, id);
    confirmDeleteFeed(id, {
      focusAfterDelete: () => (nextId ? editButtons.current.get(nextId) : undefined) ?? newFeedButton.current,
    });
  };

  const move = async (id: string, pressed: Direction) => {
    const startedAt = actionStart();
    setMoving(current => new Set(current).add(id));
    focusHandOff.current = { id, pressed };
    try {
      await moveFeed(id, pressed === 'up' ? -1 : 1);
      setConfirmedMoveId(id);
    } catch {
      // Nothing was shown before the write committed, so the list is still the server's.
      toastError(COPY.moveFailed, { description: 'Try again.', startedAt });
    } finally {
      setMoving((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const editButtonRef = (id: string) => (button: HTMLButtonElement | null) => {
    if (!button) return;
    editButtons.current.set(id, button);
    return () => { editButtons.current.delete(id); };
  };
  const moveButtonRef = (key: string) => (button: HTMLButtonElement | null) => {
    if (!button) return;
    moveButtons.current.set(key, button);
    return () => { moveButtons.current.delete(key); };
  };

  let body: ReactNode;
  if (status === 'loading') {
    body = (
      <div className="fsd-loading" role="status">
        <CircleNotch size={20} aria-hidden="true" />
        <span>{COPY.loading}</span>
      </div>
    );
  } else if (status === 'unavailable') {
    body = (
      <EmptyState
        as="h3"
        role="alert"
        icon
        art={<CloudSlash />}
        title={COPY.unavailableTitle}
        actions={(
          <Button size="sm" onClick={retry}>
            <ArrowsClockwise size={16} aria-hidden="true" />
            {COPY.tryAgain}
          </Button>
        )}
      >
        {COPY.unavailable}
      </EmptyState>
    );
  } else if (rows.length === 0) {
    body = <EmptyState as="h3" icon art={<Tray />} title={COPY.emptyTitle}>{COPY.empty}</EmptyState>;
  } else {
    body = (
      <ol className="fsd-list" aria-label={'Your feeds'}>
        {rows.map((row, index) => (
          <FeedsDialogRow
            key={row.feed.id}
            row={row}
            position={index + 1}
            saving={moving.has(row.feed.id)}
            editRef={editButtonRef(row.feed.id)}
            moveRef={direction => moveButtonRef(`${row.feed.id}:${direction}`)}
            onMove={direction => { void move(row.feed.id, direction); }}
            onEdit={() => openFeedEditor({ feedId: row.feed.id })}
            onDelete={() => confirmDelete(row.feed.id)}
          />
        ))}
      </ol>
    );
  }

  const full = feeds.length >= MAX_CUSTOM_FEEDS;
  const footer = (
    <div className="eim-footer fsd-footer">
      {status === 'ready' && <span className="eim-selected-count fsd-count">{COPY.count(feeds.length)}</span>}
      <Button ref={newFeedButton} size="lg" disabled={status !== 'ready' || full} onClick={() => openFeedEditor()}>
        <Plus size={16} aria-hidden="true" />
        {COPY.newFeed}
      </Button>
    </div>
  );
  const announcer = <p className="visually-hidden" role="status">{liveStatusText(announcement.text, announcement.n)}</p>;

  if (isPhone) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="settings-sheet" overlayClassName="settings-sheet-backdrop">
          <DrawerHandle />
          <div className="settings-sheet-head">
            <DrawerTitle render={<h2 />}>{COPY.title}</DrawerTitle>
            <p>{COPY.description}</p>
          </div>
          <div className="settings-sheet-body fsd-body" data-base-ui-swipe-ignore="">{body}</div>
          {footer}
          {announcer}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal>
      <DialogContent className="eim-modal fsd-modal" overlayClassName="eim-overlay" closeLabel={'Close'}>
        <div className="eim-header">
          <div className="eim-header-text">
            <DialogTitle>{COPY.title}</DialogTitle>
            <DialogDescription>{COPY.description}</DialogDescription>
          </div>
        </div>
        <div className="eim-body fsd-body">{body}</div>
        {footer}
        {announcer}
      </DialogContent>
    </Dialog>
  );
}

function FeedsDialogRow({ row, position, saving, editRef, moveRef, onMove, onEdit, onDelete }: {
  row: FeedRow;
  position: number;
  saving: boolean;
  editRef: Ref<HTMLButtonElement>;
  moveRef: (direction: Direction) => Ref<HTMLButtonElement>;
  onMove: (direction: Direction) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { feed, ingredients, names, canMoveUp, canMoveDown } = row;
  return (
    <li className="fsd-row">
      <span className="fsd-position" aria-hidden="true">{String(position).padStart(2, '0')}</span>
      <div className="fsd-copy">
        <h3 className="fsd-name" dir="auto">{feed.name}</h3>
        <p className="fsd-meta">
          <span className="fsd-order">{COPY.order[feed.order]}</span>
          <span className="fsd-ingredients">{ingredients}</span>
        </p>
      </div>
      <div className="fsd-actions">
        {/* While its move is saved, the pressed button keeps focus (disabled
            but focusable); at an end it is disabled outright. */}
        <RowButton ref={moveRef('up')} Icon={ArrowUp} label={names.moveUp} disabled={saving || !canMoveUp} focusableWhenDisabled={saving} onClick={() => onMove('up')} />
        <RowButton ref={moveRef('down')} Icon={ArrowDown} label={names.moveDown} disabled={saving || !canMoveDown} focusableWhenDisabled={saving} onClick={() => onMove('down')} />
        <RowButton ref={editRef} Icon={PencilSimple} label={names.edit} className="fsd-edit" onClick={onEdit} />
        <RowButton Icon={Trash} label={names.delete} className="fsd-delete" onClick={onDelete} />
      </div>
    </li>
  );
}

function RowButton({ ref, Icon, label, className, ...props }: {
  ref?: Ref<HTMLButtonElement>;
  Icon: ComponentType<IconProps>;
  label: string;
  className?: string;
  disabled?: boolean;
  focusableWhenDisabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button ref={ref} variant="ghost" size="icon" className={`fsd-action${className ? ` ${className}` : ''}`} aria-label={label} title={label} {...props}>
      <Icon size={18} aria-hidden="true" />
    </Button>
  );
}
