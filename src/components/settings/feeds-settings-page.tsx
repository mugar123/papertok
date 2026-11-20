import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowsClockwise, CircleNotch, CloudSlash, Plus, Tray } from '@phosphor-icons/react';
import { useCustomFeeds } from '../../hooks/use-custom-feeds.ts';
import { feedPositionSentence } from '../../utils/custom-feeds.ts';
import { actionStart, toastError } from '../ui/toast.ts';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import { feedLimitNote, feedRows, focusAfterMove, liveStatusText, rowAfterDelete } from './feeds-settings-rows.ts';
import './following-settings-page.css';
import './feeds-settings-page.css';

type Direction = 'up' | 'down';

/**
 * Settings › Feeds: the account's feeds in their tab order, each with the
 * buttons that do what the tab's menu does in the bar (a right-click or a
 * long press), so every action has a way that is not a pointer gesture.
 */
export default function FeedsSettingsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // As on Follows: back returns to where the reader came from, and a direct
  // URL load falls back to the Settings page that links here.
  const goBack = () => {
    if (location.key !== 'default') void navigate(-1);
    else void navigate('/settings/discovery');
  };
  const { feeds, status, moveFeed, openFeedEditor, confirmDeleteFeed, retry } = useCustomFeeds();
  const rows = useMemo(() => feedRows(feeds), [feeds]);
  const limitNote = status === 'ready' ? feedLimitNote(feeds.length) : null;

  // Feeds whose move is being saved; their move buttons wait for it.
  const [moving, setMoving] = useState<ReadonlySet<string>>(() => new Set());
  // A confirmed move is worded once, in the first render after it resolves,
  // which already shows the order the write committed. The sentence is then
  // kept as it was, whatever later happens to the list.
  const [confirmedMoveId, setConfirmedMoveId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState({ text: '', n: 0 });
  if (confirmedMoveId !== null) {
    setConfirmedMoveId(null);
    setAnnouncement(current => ({ text: feedPositionSentence(feeds, confirmedMoveId), n: current.n + 1 }));
  }

  // After a move settles, focus goes back to the row's move buttons: the
  // pressed one, or the other when the feed reached an end. The row can be
  // put back in the DOM as the list reorders, which drops its focus, so the
  // hand-off also covers focus that fell to the body; focus the reader moved
  // elsewhere meanwhile stays where it is.
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
  const editButtonRef = (id: string) => (button: HTMLButtonElement | null) => {
    if (!button) return;
    editButtons.current.set(id, button);
    return () => { editButtons.current.delete(id); };
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
      toastError('The order could not be saved', { description: 'Try again.', startedAt });
    } finally {
      setMoving((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const moveButtonRef = (key: string) => (button: HTMLButtonElement | null) => {
    if (!button) return;
    moveButtons.current.set(key, button);
    return () => { moveButtons.current.delete(key); };
  };

  let content;
  if (status === 'loading') {
    content = (
      <div className="following-settings-loading" role="status">
        <CircleNotch size={24} aria-hidden="true" />
        <span>{'Loading your feeds...'}</span>
      </div>
    );
  } else if (status === 'unavailable') {
    content = (
      <EmptyState
        role="alert"
        icon
        art={<CloudSlash />}
        title={'Your feeds could not be loaded'}
        actions={(
          <Button size="sm" onClick={retry}>
            <ArrowsClockwise size={16} aria-hidden="true" />
            {'Try again'}
          </Button>
        )}
      >
        {'Check your connection and try again.'}
      </EmptyState>
    );
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        icon
        art={<Tray />}
        title={'You have no feeds yet.'}
        actions={(
          <Button ref={newFeedButton} size="sm" onClick={() => openFeedEditor()}>
            <Plus size={16} aria-hidden="true" />
            {'New feed'}
          </Button>
        )}
      />
    );
  } else {
    content = (
      <>
        <Button ref={newFeedButton} size="sm" className="feeds-settings-new" onClick={() => openFeedEditor()}>
          <Plus size={16} aria-hidden="true" />
          {'New feed'}
        </Button>
        <ol className="feeds-settings-list" aria-label={'Your feeds'}>
          {rows.map(({ feed, ingredients, names, canMoveUp, canMoveDown }) => {
            const saving = moving.has(feed.id);
            return (
              <li key={feed.id} className="feeds-settings-row">
                <div className="feeds-settings-copy">
                  <h2 className="feeds-settings-name">{feed.name}</h2>
                  <p className="feeds-settings-ingredients">{ingredients}</p>
                </div>
                <div className="feeds-settings-actions">
                  <Button ref={editButtonRef(feed.id)} variant="ghost" size="sm" className="feeds-settings-action" aria-label={names.edit} onClick={() => openFeedEditor({ feedId: feed.id })}>
                    {'Edit'}
                  </Button>
                  {/* While its move is saved, the pressed button keeps focus
                      (disabled but focusable); at an end it is disabled outright. */}
                  <Button
                    ref={moveButtonRef(`${feed.id}:up`)}
                    variant="ghost"
                    size="sm"
                    className="feeds-settings-action"
                    aria-label={names.moveUp}
                    disabled={saving || !canMoveUp}
                    focusableWhenDisabled={saving}
                    onClick={() => { void move(feed.id, 'up'); }}
                  >
                    {'Move up'}
                  </Button>
                  <Button
                    ref={moveButtonRef(`${feed.id}:down`)}
                    variant="ghost"
                    size="sm"
                    className="feeds-settings-action"
                    aria-label={names.moveDown}
                    disabled={saving || !canMoveDown}
                    focusableWhenDisabled={saving}
                    onClick={() => { void move(feed.id, 'down'); }}
                  >
                    {'Move down'}
                  </Button>
                  <Button variant="ghost" size="sm" className="feeds-settings-action" aria-label={names.delete} onClick={() => confirmDelete(feed.id)}>
                    {'Delete'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      </>
    );
  }

  return (
    <main className="following-settings-page">
      <div className="following-settings-shell feeds-settings-shell">
        <Button
          variant="ghost"
          size="icon"
          className="following-settings-back"
          onClick={goBack}
          aria-label={'Back'}
          title={'Back'}
        >
          <ArrowLeft size={18} />
        </Button>
        <header className="following-settings-heading">
          <h1>{'Feeds'}</h1>
          {limitNote && <p>{limitNote}</p>}
        </header>
        {content}
        <p className="visually-hidden" role="status">{liveStatusText(announcement.text, announcement.n)}</p>
      </div>
    </main>
  );
}
