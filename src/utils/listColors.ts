/**
 * What colour a list is painted with.
 *
 * The colour is the owner's choice, not a reading of the contents, and that
 * distinction is the whole reason this file exists rather than reusing
 * `getAreaGradient()`. An earlier draft of the lists page took the field of the
 * most common paper in a list and painted the card with it — which meant a
 * mixed list of forty-six papers announced itself as "Physics" because one
 * subject happened to lead. A list is a folder the owner made up; it has no
 * field, and pretending otherwise states something false.
 *
 * So: `--list-*` for lists, `--gradient-*` for fields, and the two palettes are
 * built to different rules on purpose (see the comment on the tokens in
 * `variables.css`). Inside an open list both appear at once — the header
 * carries the list's colour, each row carries its paper's field — and they have
 * to stay tellable apart.
 */

/**
 * The eight the owner can choose from, in the order the picker shows them.
 *
 * Ids, not colour values: what is stored on the list document is `"teal"`, so
 * retuning the palette in `variables.css` repaints every list that already
 * exists instead of stranding them on a hex nobody can change.
 */
export const LIST_COLORS = Object.freeze([
  'ochre',
  'olive',
  'green',
  'teal',
  'blue',
  'indigo',
  'violet',
  'crimson',
]);

/**
 * The three built-in lists are not owner-coloured, so they are not editable and
 * do not draw from the palette.
 *
 * Favourites takes `--accent-like`, the red the app already spends on hearts,
 * because that is the same gesture wearing a different hat — and it is
 * deliberately *outside* the palette, so no list of the owner's can be mistaken
 * for it. Read later stays uncoloured: it is a queue, not a shelf, and a rule
 * of no colour reads correctly as "nothing assigned here".
 */
const SYSTEM_LIST_COLORS = Object.freeze({
  __favorites__: 'var(--accent-like)',
  __read__: 'var(--list-ochre)',
  __read_later__: null,
});

/** The CSS value for a palette id, or null when the id is not one of ours. */
export function listColorVarById(colorId) {
  return LIST_COLORS.includes(colorId) ? `var(--list-${colorId})` : null;
}

/** A fresh colour for a list about to be created. */
export function randomListColorId() {
  return LIST_COLORS[Math.floor(Math.random() * LIST_COLORS.length)];
}

/**
 * A stable palette index for a list that has no colour of its own.
 *
 * Every list created before this feature existed has no `color` field, and
 * there are two ways to treat them: paint them all grey until the owner opens
 * each one and picks, or give them something now. This gives them something
 * now — derived from the id, so it is the same colour on every device and after
 * every reload, with no migration to run and nothing to write.
 *
 * djb2, which is not a good hash for anything that matters and is exactly right
 * for choosing one of eight buckets from a short string.
 */
function stableIndex(id) {
  let hash = 5381;
  for (let i = 0; i < id.length; i += 1) {
    hash = ((hash << 5) + hash + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % LIST_COLORS.length;
}

/**
 * Which palette entry this list sits on, or null when it has none to edit.
 *
 * The picker needs the id and the card needs the CSS value, and they have to
 * agree: opening the editor on a list that has never been recoloured must land
 * the tick on the swatch the card is already painted with, not on a default the
 * owner never chose.
 */
export function resolveListColorId(list) {
  if (!list?.id || Object.hasOwn(SYSTEM_LIST_COLORS, list.id)) return null;
  return LIST_COLORS.includes(list.color) ? list.color : LIST_COLORS[stableIndex(list.id)];
}

/**
 * The CSS value to paint this list with, or null when it carries no colour.
 *
 * Callers set it as a custom property on the element that owns the list — the
 * card, the open list's header — and everything inside reads `var(--list-accent)`,
 * which is how the field colour already flows through the Explorer.
 */
export function resolveListColor(list) {
  if (!list?.id) return null;
  if (Object.hasOwn(SYSTEM_LIST_COLORS, list.id)) return SYSTEM_LIST_COLORS[list.id];
  return listColorVarById(resolveListColorId(list));
}

/** Whether this list's colour belongs to the owner and can be edited. */
export function listColorIsEditable(listId) {
  return Boolean(listId) && !Object.hasOwn(SYSTEM_LIST_COLORS, listId);
}
