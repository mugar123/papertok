import { useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../ui/dialog.tsx';
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import { Input } from '../ui/input.tsx';
import { Label } from '../ui/label.tsx';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group.tsx';
import IngredientPicker from './ingredient-picker.tsx';
import { useAuth } from '../../context/auth-context.tsx';
import { useCustomFeeds } from '../../hooks/use-custom-feeds.ts';
import useIsPhone from '../../hooks/use-is-phone.ts';
import { usePopupOpenOnMount } from '../../hooks/use-popup-open-on-mount.ts';
import { newFeedId } from '../../services/custom-feeds-store.ts';
import {
  CustomFeedError,
  ingredientKey,
  ingredientProblem,
  MAX_FEED_NAME_LENGTH,
  type CustomFeedInput,
  type CustomFeedOrder,
  type FeedIngredient,
} from '../../utils/custom-feeds.ts';
import { admitIngredients, FEED_FORM_INITIAL, feedFormProblem, feedFormReducer, otherFeedsOf } from '../../utils/feed-form-model.ts';
import { suggestedIngredients } from '../../utils/feed-ingredient-search.ts';
import { customFeedPath } from '../../utils/feed-tabs.ts';
import './feed-dialog.css';

const COPY = {
  newTitle: 'New feed',
  editTitle: 'Edit feed',
  close: 'Close',
  name: 'Name',
  order: 'Order',
  orders: [
    { value: 'newest', title: 'Newest first', description: 'The latest papers, day by day.' },
    { value: 'best', title: 'Best match for you', description: 'Ranked by what you like and save.' },
  ] as const,
  cancel: 'Cancel',
  create: 'Create feed',
  save: 'Save',
  taken: 'You already have a feed with that name.',
  feedLimit: 'You have 8 feeds. Delete one to add another.',
  failed: 'The feed could not be saved. Try again.',
  ingredient: {
    'feed-full': 'A feed holds up to 20. Remove one to add another.',
    'entities-full': 'Your feeds can follow up to 30 authors and research topics.',
    'keywords-full': 'Your feeds can use up to 10 keywords.',
  },
};

/**
 * The one window that creates a custom feed and edits one: a dialog on a
 * desktop, a bottom drawer on a phone. The provider mounts it for each
 * opening and unmounts it once it has closed, so it holds its own `open`
 * and tells the provider from `onOpenChangeComplete(false)`, after the leave
 * has played (design.md, Traps). The feed being edited and the reader's
 * suggestions are read once, when it opens.
 *
 * The form is checked before it is sent (feed-form-model.ts), so a refusal
 * from the store means another device changed the account's feeds meanwhile:
 * a taken name or the eight-feed limit is told as the form tells it, anything
 * else is a failure to try again. A new feed's id is made once per opening,
 * so a retry after a write that outran its deadline but landed finds that
 * feed instead of adding a second one.
 */
export default function FeedDialog({ feedId, preset, onClosed }: { feedId?: string; preset?: Partial<CustomFeedInput>; onClosed: () => void }) {
  const { feeds, createFeed, updateFeed } = useCustomFeeds();
  const { userPreferences } = useAuth();
  const navigate = useNavigate();
  const isPhone = useIsPhone();

  const [opened] = useState(() => {
    const editing = feedId ? feeds.find(feed => feed.id === feedId) ?? null : null;
    const source = editing ?? preset ?? {};
    const admitted = admitIngredients(source.ingredients ?? [], feeds.filter(feed => feed.id !== editing?.id));
    return {
      editing,
      missing: Boolean(feedId && !editing),
      preset: { name: source.name ?? '', order: source.order ?? 'newest', ingredients: admitted.ingredients },
      refused: admitted.refused,
      suggestions: suggestedIngredients(userPreferences ?? [], admitted.ingredients),
    };
  });
  const editingId = opened.editing?.id;
  const [state, dispatch] = useReducer(feedFormReducer, FEED_FORM_INITIAL, initial => feedFormReducer(initial, { type: 'open', preset: opened.preset }));
  // Opens on the frame after mount, so the window arrives rather than appears.
  const { open, requestClose: closeWindow } = usePopupOpenOnMount();
  // Numbered so a refusal repeated word for word is a new alert, and announced again.
  const [notice, setNotice] = useState<{ text: string; n: number } | null>(null);
  const refuse = (text: string) => setNotice(current => ({ text, n: (current?.n ?? 0) + 1 }));
  const [refusal, setRefusal] = useState<'feed-limit' | 'taken' | null>(null);
  const [createId] = useState(newFeedId);
  // A ref as well as `state.busy`: two Enters can land before React re-renders.
  const inFlight = useRef(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const nameId = useId();
  const nameErrorId = useId();
  const orderLabelId = useId();

  // A feed that was gone by the time the window opened has nothing to edit.
  useEffect(() => {
    if (opened.missing) onClosed();
  }, [opened.missing, onClosed]);

  // The form's own feed: the one edited, or the new one once a create that
  // outran its deadline has landed under this opening's id. Pressing Create
  // again then finds it (withFeedAdded) instead of being told its name is taken.
  const ownId = editingId ?? createId;
  const otherFeeds = useMemo(() => otherFeedsOf(feeds, ownId), [feeds, ownId]);
  const problem = feedFormProblem(state, feeds, ownId);
  const nameTaken = problem === 'taken' || (state.failed && refusal === 'taken');
  let formNotice: string | null = null;
  if (state.failed) {
    if (refusal === 'feed-limit') formNotice = COPY.feedLimit;
    else if (refusal !== 'taken') formNotice = COPY.failed;
  } else if (problem === 'feed-limit') formNotice = COPY.feedLimit;

  const requestClose = () => {
    if (!inFlight.current) closeWindow();
  };
  const onOpenChange = (next: boolean, details: { reason: string; event: Event }) => {
    if (next) return;
    // Escape in a search that holds text clears the text (IngredientPicker)
    // and leaves the window open; whichever listener runs first, the key
    // either is marked handled or still finds the text in the field.
    const { event } = details;
    if (details.reason === 'escape-key' && (event.defaultPrevented
      || (event.target instanceof HTMLInputElement && event.target.type === 'search' && event.target.value !== ''))) return;
    requestClose();
  };
  const onOpenChangeComplete = (next: boolean) => {
    if (!next) onClosed();
    // A limit a preset met is told once the window has arrived: an alert
    // inserted together with the window may not be announced.
    else if (opened.refused) refuse(COPY.ingredient[opened.refused]);
  };

  const toggle = (ingredient: FeedIngredient) => {
    const key = ingredientKey(ingredient);
    if (state.ingredients.some(held => ingredientKey(held) === key)) {
      dispatch({ type: 'remove', key });
      setNotice(null);
      return;
    }
    const refused = ingredientProblem(ingredient, state.ingredients, otherFeeds);
    if (refused === 'duplicate') return;
    if (refused) {
      refuse(COPY.ingredient[refused]);
      return;
    }
    dispatch({ type: 'add', ingredient });
    setNotice(null);
  };
  const remove = (key: string) => {
    dispatch({ type: 'remove', key });
    setNotice(null);
  };

  const submit = async () => {
    if (inFlight.current || state.busy || problem) return;
    inFlight.current = true;
    setRefusal(null);
    dispatch({ type: 'submit' });
    const input: CustomFeedInput = { name: state.name.trim(), order: state.order, ingredients: state.ingredients };
    try {
      if (editingId) await updateFeed(editingId, input);
      else {
        const feed = await createFeed(input, createId);
        void navigate(customFeedPath(feed.id));
      }
      inFlight.current = false;
      dispatch({ type: 'saved' });
      closeWindow();
    } catch (error) {
      // The window says "try again"; the console says why.
      console.error('The feed could not be saved', error);
      inFlight.current = false;
      setRefusal(error instanceof CustomFeedError && (error.code === 'feed-limit' || error.code === 'taken') ? error.code : null);
      dispatch({ type: 'failed' });
    }
  };

  if (opened.missing) return null;

  const title = opened.editing ? COPY.editTitle : COPY.newTitle;
  const body: ReactNode = (
    <>
      <div className="feed-field">
        <Label className="feed-field-label" htmlFor={nameId}>{COPY.name}</Label>
        <Input
          id={nameId}
          ref={nameRef}
          className="feed-input"
          value={state.name}
          maxLength={MAX_FEED_NAME_LENGTH}
          autoComplete="off"
          aria-invalid={nameTaken ? 'true' : undefined}
          aria-describedby={nameTaken ? nameErrorId : undefined}
          onChange={event => dispatch({ type: 'name', value: event.target.value })}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit(); }}
        />
        {nameTaken && <p id={nameErrorId} className="feed-notice" role="alert">{COPY.taken}</p>}
      </div>

      <IngredientPicker
        ingredients={state.ingredients}
        suggestions={opened.suggestions}
        notice={notice}
        onToggle={toggle}
        onRemove={remove}
      />

      <div className="feed-field">
        <span id={orderLabelId} className="feed-field-label">{COPY.order}</span>
        <RadioGroup
          className="feed-orders"
          aria-labelledby={orderLabelId}
          value={state.order}
          onValueChange={(value: CustomFeedOrder) => dispatch({ type: 'order', value })}
        >
          {COPY.orders.map(order => (
            <RadioGroupItem key={order.value} value={order.value} nativeButton render={<button type="button" className="feed-order" />}>
              <span className="feed-order-title">{order.title}</span>
              <span className="feed-order-description">{order.description}</span>
            </RadioGroupItem>
          ))}
        </RadioGroup>
      </div>
    </>
  );
  const footer = (
    <div className="feed-dialog-foot">
      {formNotice && <p className="feed-notice" role="alert">{formNotice}</p>}
      <div className="feed-dialog-actions">
        <Button variant="outline" disabled={state.busy} focusableWhenDisabled onClick={requestClose}>{COPY.cancel}</Button>
        <Button
          disabled={state.busy || Boolean(problem)}
          focusableWhenDisabled
          aria-busy={state.busy || undefined}
          onClick={() => { void submit(); }}
        >
          {opened.editing ? COPY.save : COPY.create}
        </Button>
      </div>
    </div>
  );

  if (isPhone) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete}>
        <DrawerContent className="feed-sheet" overlayClassName="feed-sheet-backdrop" initialFocus={nameRef}>
          <DrawerHandle />
          <div className="feed-sheet-head">
            <DrawerTitle render={<h2 />}>{title}</DrawerTitle>
          </div>
          <div className="feed-dialog-body" data-base-ui-swipe-ignore="">{body}</div>
          {footer}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete}>
      <DialogContent className="feed-dialog" showClose={false} closeLabel={COPY.close} initialFocus={nameRef}>
        <div className="feed-dialog-head">
          <DialogTitle render={<h2 />}>{title}</DialogTitle>
          <DialogClose
            disabled={state.busy}
            render={<Button variant="ghost" size="icon-sm" aria-label={COPY.close} />}
          >
            <X size={16} aria-hidden="true" />
          </DialogClose>
        </div>
        <div className="feed-dialog-body">{body}</div>
        {footer}
      </DialogContent>
    </Dialog>
  );
}
