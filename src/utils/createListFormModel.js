/**
 * The state machine behind the "new list" window.
 *
 * The window itself is four fields and two buttons, and that part is not worth
 * hiding here. What is worth hiding here is the part that can be wrong in
 * silence: a blank name that submits anyway, a second submit landing while the
 * first is still in flight, and a name, icon or error message from the last
 * attempt reappearing the next time the window opens. Those three have no
 * visible symptom until they have already created the wrong thing, so they live
 * in a pure reducer with tests instead of inline in the component — the same
 * reason saveOrganizeModel.js exists next door.
 *
 * The list id is minted from `Date.now()`, which is what makes the double
 * submit expensive rather than merely untidy: two submits in the same
 * millisecond overwrite each other, and two a millisecond apart leave the owner
 * with two identical lists to clean up.
 */

import { LIST_COLORS } from './listColors.js';

/**
 * `color` starts on the first of the palette rather than on a random one,
 * because a reducer that reaches for `Math.random()` is no longer a function of
 * its arguments and cannot be tested by comparing states. The window dispatches
 * `open` with the colour it wants — a random one when creating, the list's own
 * when editing — and the default here is only what `open` falls back to.
 */
export const CREATE_LIST_FORM_INITIAL = Object.freeze({
  name: '',
  icon: 'Folder',
  color: LIST_COLORS[0],
  busy: false,
  error: false,
});

/** Enabled when there is a name to send and nothing already on its way. */
export function canSubmitCreateList(state) {
  return Boolean(state.name.trim()) && !state.busy;
}

export function createListFormReducer(state, action) {
  switch (action.type) {
    case 'open': {
      // The same window creates and edits, so `open` seeds it: nothing when
      // creating (bar the random colour the caller rolled), and the list's own
      // name, icon and colour when editing. Anything the preset omits falls
      // back to the initial state, so a partial preset cannot carry a field
      // over from the last time the window was open.
      const { name, icon, color } = { ...CREATE_LIST_FORM_INITIAL, ...action.preset };
      return { ...CREATE_LIST_FORM_INITIAL, name, icon, color };
    }
    case 'name':
      // Typing clears the error: keeping it would say "it failed" about a
      // request the owner has not made yet.
      return { ...state, name: action.value, error: false };
    case 'icon':
      return { ...state, icon: action.value };
    case 'color':
      return { ...state, color: action.value };
    case 'submit':
      // The guard is here as well as on the button's `disabled`, because Enter
      // reaches the handler by its own path and a disabled attribute is not a
      // state machine.
      return canSubmitCreateList(state)
        ? { ...state, busy: true, error: false }
        : state;
    case 'failed':
      return { ...state, busy: false, error: true };
    default:
      return state;
  }
}
