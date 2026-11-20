import type { Icon } from '@phosphor-icons/react';
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowSquareOut,
  BookmarkSimple,
  ClockCounterClockwise,
  DotsThree,
  DownloadSimple,
  Eye,
  FileText,
  Funnel,
  GearSix,
  GlobeHemisphereWest,
  GraduationCap,
  Graph,
  Heart,
  Highlighter,
  Info,
  Intersect,
  LinkBreak,
  LinkSimple,
  ListBullets,
  MagnifyingGlass,
  NotePencil,
  PencilSimple,
  Plant,
  Plus,
  Prohibit,
  ShareNetwork,
  ShieldCheck,
  Sparkle,
  Stack,
  TextAlignLeft,
  Trash,
  UserCheck,
  UserCirclePlus,
  X,
} from '@phosphor-icons/react';
import { MAX_ACCOUNT_ENTITIES, MAX_ACCOUNT_KEYWORDS, MAX_CUSTOM_FEEDS, MAX_FEED_INGREDIENTS } from '../../utils/custom-feeds.ts';
import { MAX_FOLLOWED_JOURNALS } from '../../utils/following.ts';
import type { AIUses } from '../../services/paper-rewrite-service.ts';

/**
 * What the Worker allows each account to change in public lists per day, as
 * wrangler.toml sets it (PUBLIC_LIST_USER_DAILY_LIMIT). No route sends it to
 * the client, so help-guide.test.ts compares it with the file. The AI limit
 * is not copied: the Worker sends it with the count (`AIUses.dailyLimit`), and
 * the page shows that.
 */
export const LIST_PUBLISHES_PER_DAY = 60;

/**
 * What a control spends from an allowance:
 * - `free`: nothing.
 * - `ai`: one AI use every time.
 * - `ai-new`: one AI use, unless that version is already written (it then opens free).
 * - `publish`: one of the day's public-list changes (publish, update, stop sharing).
 */
export type HelpAllowance = 'free' | 'ai' | 'ai-new' | 'publish';

/** `zotero` is the Z the viewer draws; Phosphor has no mark for it. */
type HelpIcon = Icon | 'zotero';

export interface HelpEntry {
  id: string;
  /** What the control is called, as its accessible name. */
  name: string;
  /** The glyph on the control. Entries without one are text or gestures. */
  icon?: HelpIcon;
  what: string;
  allowance: HelpAllowance;
  /** Whether a signed-out visitor is asked to sign in when they use it. */
  needsAccount: boolean;
}

export interface HelpSection {
  id: string;
  title: string;
  intro: string;
  /** Every control here is behind sign-in, so the rows do not repeat it. */
  signedInOnly?: boolean;
  entries: readonly HelpEntry[];
}

const entry = (
  id: string,
  name: string,
  icon: HelpIcon | undefined,
  what: string,
  { allowance = 'free', needsAccount = false }: Partial<Pick<HelpEntry, 'allowance' | 'needsAccount'>> = {},
): HelpEntry => ({ id, name, icon, what, allowance, needsAccount });

export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: 'card',
    title: 'Buttons on a paper card',
    intro: 'A card is one paper in your feed. On a phone the buttons sit at the foot of the card and in the column on its right edge.',
    entries: [
      entry('read', 'Read article', FileText,
        'Opens the paper. The label changes with the copy PaperTok found: Read full text, Read open version, Via followed by your university’s name, or Source. A PDF opens in PaperTok’s viewer; other copies open in a new tab.'),
      entry('plain-words', 'Read in plain words', Sparkle,
        'Opens the reader, where AI rewrites the paper’s full text in plainer language at your level. It shows only on papers whose full text can be read, and reads “Simple” on a narrow phone. The first rewrite of a paper at a level spends one AI use. A version already written opens free, and the line under the button says so or shows how many uses you have left.',
        { allowance: 'ai-new', needsAccount: true }),
      entry('publisher', 'Publisher’s page', ArrowSquareOut,
        'Shows on a card with no abstract when the paper has a DOI. Opens the publisher’s page in a new tab. Next to Read in plain words it shows only the arrow.'),
      entry('like', 'Like', Heart,
        'Likes the paper. The heart fills in; press again to undo. Likes teach your For you feed what you want to see, and liked papers are listed under Favorites in My lists.',
        { needsAccount: true }),
      entry('save', 'Save', BookmarkSimple,
        'Saves the paper to Read later at once and offers Add to list in a message. Press again to take it out of Read later and every list; the message offers Undo. On a touch screen, holding the button for half a second opens the list picker instead.',
        { needsAccount: true }),
      entry('connections', 'Connections', Graph,
        'Shows the paper’s citation map when one is available. On a wide screen the map takes the abstract’s place until you press the button again. On a phone it opens as a sheet.',
        { needsAccount: true }),
      entry('similar', 'Similar papers', Intersect,
        'Opens a feed of recommended papers like this one, in a full-screen layer. Go back to return to the card. Not shown on public paper pages.',
        { needsAccount: true }),
      entry('more', 'More actions', DotsThree,
        'Opens the paper’s menu: About this paper, reading history, hiding the paper, citation exports and sharing. The “More actions menu” section lists each one.'),
    ],
  },
  {
    id: 'card-text',
    title: 'Text on a card you can press',
    intro: 'These have no icon. Each one is a link or button made of words.',
    entries: [
      entry('field', 'Field name above the title', undefined,
        'Opens that field or topic in the explorer, with its papers and authors.'),
      entry('title', 'The title (touch screens)', undefined,
        'On a phone or other touch screen, opens the abstract sheet, which shows the whole title and abstract.'),
      entry('abstract', 'Read full abstract / Show less', undefined,
        'Expands the abstract on the card, or opens it in a sheet on a touch screen. Tapping the abstract does the same.'),
      entry('authors', 'The author initials', undefined,
        'Press the row of initials to list every author: on a computer the list unfolds under the initials, on a phone it opens as a sheet. Each name opens that author in the explorer.'),
      entry('citations', 'Citation count labelled “on Scopus”', undefined,
        'Links to the paper’s record on Scopus in a new tab. A plain count without “on Scopus” is not a link.'),
    ],
  },
  {
    id: 'menu',
    title: 'The More actions menu',
    intro: 'Opens as a dialog on a computer and as a drawer on a phone. The paper viewer’s dock has the same menu.',
    entries: [
      entry('about', 'About this paper', Info,
        'Shows the paper’s review status, topics, funding and links such as its DOI, code and data.'),
      entry('mark-read', 'Mark as read / Mark as unread', Eye,
        'Adds the paper to your reading history, or takes it out. The paper stays on screen until the feed next loads.',
        { needsAccount: true }),
      entry('not-interested', 'Not interested', Prohibit,
        'Hides the paper and tells For you to show fewer like it. In a custom feed it hides the paper from that feed only. A message offers Undo.',
        { needsAccount: true }),
      entry('bibtex', 'Export BibTeX', DownloadSimple,
        'Downloads the paper’s citation as a .bib file for LaTeX and BibTeX managers.'),
      entry('ris', 'Export RIS', DownloadSimple,
        'Downloads the paper’s citation as a .ris file for Zotero, EndNote and Mendeley.'),
      entry('copy-link', 'Copy link', LinkSimple,
        'Copies the paper’s link: its PaperTok page when it has one, otherwise the source’s page. Below it, X, Reddit, LinkedIn, WhatsApp and Instagram share it; Instagram copies the link for you to paste.'),
    ],
  },
  {
    id: 'reader',
    title: 'The plain-words reader',
    intro: 'Opens over the feed from Read in plain words. The text is an AI adaptation of the full text and does not replace the paper.',
    signedInOnly: true,
    entries: [
      entry('level', 'Level', Plant,
        'Beginner, University or Researcher. The button shows the icon of the current level: a plant, a graduation cap or a flask. The starting level is the one set for the paper’s area in Edit interests, else your default in Settings under Reading & AI. Choosing a level this paper has not been written at spends one AI use; a level already written opens free. The level cannot be changed while a rewrite is being written.',
        { allowance: 'ai-new', needsAccount: true }),
      entry('write-again', 'Write it again', ArrowClockwise,
        'Shows under a reused summary. Writes a new version and replaces the saved one. Spends one AI use. If the new one stops early, the old one stays.',
        { allowance: 'ai', needsAccount: true }),
      entry('retry', 'Try again', ArrowClockwise,
        'Shows when a rewrite failed or stopped early. Asks for the rewrite again and spends one AI use, unless a saved version turns up. A rewrite that fails because of the service gives its AI use back.',
        { allowance: 'ai-new', needsAccount: true }),
      entry('annotations', 'Annotations', NotePencil,
        'Opens or closes the notes panel: your highlights and notes, and the AI’s explanations on a tab of their own.',
        { needsAccount: true }),
      entry('ai-highlights', 'AI highlights', Highlighter,
        'Shows or hides the passages the AI marked in the summary. Switching it spends nothing.',
        { needsAccount: true }),
      entry('highlight', 'Highlight a passage', Highlighter,
        'Select text to open a small editor: pick a colour, add a note if you want, and save. On a touch screen, press Highlight after selecting. From a keyboard, focus a paragraph and press Enter.',
        { needsAccount: true }),
      entry('explain', 'Explain this to me', Sparkle,
        'In the same editor. Has the AI explain the selected passage and keeps the answer as a note. Spends one AI use each time, and is disabled once your uses run out.',
        { allowance: 'ai', needsAccount: true }),
      entry('contents', 'Contents', ListBullets,
        'Opens a list of the summary’s sections. Pick one to jump to it.',
        { needsAccount: true }),
      entry('original', 'View the original paper', ArrowSquareOut,
        'Opens the original article in a new tab.',
        { needsAccount: true }),
      entry('close-reader', 'Close reader', X,
        'Closes the reader and returns to the card.',
        { needsAccount: true }),
    ],
  },
  {
    id: 'viewer',
    title: 'The paper viewer',
    intro: 'Opens from Read article when the paper has a PDF PaperTok can show. It uses no AI.',
    entries: [
      entry('viewer-contents', 'Contents', ListBullets,
        'Opens the paper’s outline while the text is shown. Pick a section to jump to it.'),
      entry('viewer-abstract', 'Abstract', Eye,
        'Shows or hides the abstract above the text. The icon is an eye while the abstract is shown and a struck-through eye while it is hidden.'),
      entry('viewer-notes', 'Notes', NotePencil,
        'Opens the panel of your highlights and notes, with a count. Shows while the text is shown. Select text in the paper to add one.',
        { needsAccount: true }),
      entry('show-text', 'Show text / Show PDF', TextAlignLeft,
        'Switches between the paper’s text, set for reading, and the PDF pages. The icon shows the view you will get: lines of text, or a PDF page.'),
      entry('zotero-send', 'Send to Zotero', 'zotero',
        'Sends the paper and your highlights to your Zotero library. If Zotero is not connected, the button offers to connect it.',
        { needsAccount: true }),
      entry('viewer-new-tab', 'Open in a new tab', ArrowSquareOut,
        'Opens the PDF or the source page in a new browser tab.'),
      entry('viewer-more', 'More actions', DotsThree,
        'The same menu as on the card.'),
      entry('viewer-close', 'Close paper', X,
        'Closes the viewer and returns to the card.'),
    ],
  },
  {
    id: 'tabs',
    title: 'Feed tabs and search',
    intro: 'The bar at the top of the app. Your picture, at its right end, opens the account menu: My profile, My lists, Settings, the theme and Log out.',
    signedInOnly: true,
    entries: [
      entry('for-you', 'For you', Stack,
        'Papers picked from your interests, follows, likes and saves. Pressing the tab you are on reloads the feed.'),
      entry('most-recent', 'Most recent', ClockCounterClockwise,
        'Papers on your topics that you have not seen yet, newest first.'),
      entry('following', 'Following', UserCheck,
        'Papers from the authors, institutions, topics, projects and journals you follow.'),
      entry('own-feeds', 'Your own feeds', undefined,
        `Feeds you made from topics, authors, journals and keywords show as tabs after Following. You can have up to ${MAX_CUSTOM_FEEDS}, each with up to ${MAX_FEED_INGREDIENTS} ingredients. Edit feed, Move left, Move right and Delete feed are in the tab’s menu, and as buttons in Settings under Discovery.`),
      entry('new-feed', 'New feed', Plus,
        'The plus after the tabs. Opens a form to name a feed and choose what goes in it.'),
      entry('search', 'Search', MagnifyingGlass,
        'Searches papers, authors, institutions, topics and projects. The keys / or Ctrl+K (⌘K on a Mac) open it from anywhere.'),
    ],
  },
  {
    id: 'explorer',
    title: 'Author, institution, topic and project pages',
    intro: 'Open one from a card’s field name or author list, or from search. A signed-out visitor sees a preview and is asked to sign in for the actions marked below.',
    entries: [
      entry('explorer-back', 'Back', ArrowLeft,
        'Returns to the page you came from.'),
      entry('follow', 'Follow', UserCirclePlus,
        `Follows this author, institution, topic, project or journal, so its papers show in Following. The icon fills in once followed; press again to unfollow. You can follow up to ${MAX_FOLLOWED_JOURNALS} journals.`,
        { needsAccount: true }),
      entry('explorer-share', 'Share', ShareNetwork,
        'Copies the page’s link or shares it to a network.'),
      entry('make-feed', 'Make it a feed', Plus,
        `Turns this page into a feed tab. Shows on areas, topics, keyword searches, authors and journals that can be followed. Across its feeds an account can hold ${MAX_ACCOUNT_ENTITIES} authors, topics and journals and ${MAX_ACCOUNT_KEYWORDS} keywords.`,
        { needsAccount: true }),
      entry('explorer-search', 'Search this page', MagnifyingGlass,
        'Searches the papers or authors on this page. The Papers and Authors buttons above it choose which list.',
        { needsAccount: true }),
      entry('filters', 'Filters', Funnel,
        'Narrows the papers by area, sort order, date and peer review. Each active filter shows as a chip; press a chip to remove it, or Reset to clear all.',
        { needsAccount: true }),
    ],
  },
  {
    id: 'lists',
    title: 'Lists',
    intro: 'The save picker and the My lists page. Favorites (your likes), Read later and Reading history fill in as you like, save and read. Lists you make can hold notes and tags. Changing a public list also updates its public copy, which counts toward the daily limit.',
    signedInOnly: true,
    entries: [
      entry('new-list', 'New list', Plus,
        'Makes a list with a name, an icon and a colour.'),
      entry('export', 'Export', DownloadSimple,
        'Downloads the open list’s citations as BibTeX (.bib) or RIS (.ris).'),
      entry('publish', 'Publish & share', GlobeHemisphereWest,
        `Makes the list public: anyone with the link can read it. Publishing, updating a public list and stopping sharing each count toward ${LIST_PUBLISHES_PER_DAY} a day per account.`,
        { allowance: 'publish' }),
      entry('stop-sharing', 'Stop sharing', LinkBreak,
        'Makes the list private again. Its public link stops working.',
        { allowance: 'publish' }),
      entry('edit-list', 'Edit list', PencilSimple,
        'Changes the list’s name, icon and colour. Counts toward the daily limit only on a public list.',
        { allowance: 'publish' }),
      entry('delete-list', 'Delete list', Trash,
        'Deletes the list after you confirm. The papers stay saved. A public list is stopped from sharing first, which counts toward the daily limit.',
        { allowance: 'publish' }),
      entry('edit-note', 'Edit note and tags', PencilSimple,
        'On a paper in a list. Adds a note and tags. Counts toward the daily limit only on a public list.',
        { allowance: 'publish' }),
      entry('remove-paper', 'Remove from list', Trash,
        'Takes the paper out of this list. Counts toward the daily limit only on a public list.',
        { allowance: 'publish' }),
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    intro: 'Reached from the account menu. The pages are listed in the Settings menu beside this one.',
    signedInOnly: true,
    entries: [
      entry('connect-sign-in', 'Connect Google or GitHub', LinkSimple,
        'Account page. Adds a second way to sign in to the same account. A way you already use shows as connected.'),
      entry('university', 'Link your university', GraduationCap,
        'Account page. Verifies your university email, so papers can open through its library when it has them.'),
      entry('zotero-connect', 'Connect Zotero', 'zotero',
        'Account page. Connects your Zotero library so the viewer can send papers and highlights to it. The same row disconnects it.'),
      entry('delete-account', 'Delete account', Trash,
        'Account page. Permanently deletes your account and everything in it, after you confirm.'),
      entry('edit-follows', 'Edit follows', PencilSimple,
        'Discovery page. Lists what you follow and lets you unfollow.'),
      entry('edit-feeds', 'Edit feeds', PencilSimple,
        'Discovery page. Lists your feeds in tab order with Edit, Move up, Move down and Delete for each.'),
      entry('edit-interests', 'Edit interests', PencilSimple,
        'Discovery page. Chooses the subjects that train your feed, and can set a plain-words level for an area, which replaces your default for papers in it.'),
      entry('default-level', 'Default AI level', Sparkle,
        'Reading & AI page. Sets the level Read in plain words starts at, unless the paper’s area has its own level. The same page lists the summaries you have read.'),
      entry('email-updates', 'Configure email updates', GearSix,
        'Notifications page. Turns the Monday email on or off, and sets how many papers it holds.'),
      entry('analytics', 'Allow usage analytics', ShieldCheck,
        'Privacy page. A switch for usage measurement. It is on until you turn it off.'),
      entry('author-statistics', 'Count my saves in weekly paper totals', ShieldCheck,
        'Privacy page. A switch for whether your saves are counted in weekly paper totals. On by default once your email is verified.'),
    ],
  },
  {
    id: 'gestures',
    title: 'Gestures and keys',
    intro: 'Every gesture has a button or key that does the same, so none is required.',
    entries: [
      entry('double-tap', 'Double-tap the card', undefined,
        'Likes the paper, the same as the heart, but never takes a like back: use the heart for that. Two quick taps on the card itself; the connections map ignores them.',
        { needsAccount: true }),
      entry('hold-save', 'Hold Save', undefined,
        'On a touch screen, half a second on Save opens the list picker. A mouse click saves at once.',
        { needsAccount: true }),
      entry('swipe-tabs', 'Swipe sideways on the feed', undefined,
        'On a touch screen, a quick sideways swipe moves to the next or previous feed tab. It must start away from the screen’s edges.'),
      entry('pull-refresh', 'Pull down at the top of the feed', undefined,
        'On a touch screen, drag down on the first card, or from just under the bar on another card, to reload the feed.'),
      entry('arrow-keys', 'Arrow Up and Arrow Down', undefined,
        'Moves to the previous or next paper when focus is not on a button, link or field.'),
      entry('tab-menu', 'Right-click or hold a feed tab', undefined,
        'Opens the tab’s menu: Edit feed, Move left, Move right and Delete feed. The Menu key or Shift+F10 opens it from a keyboard. Settings under Discovery has buttons for the same.'),
      entry('search-key', '/ or Ctrl+K (⌘K)', undefined,
        'Opens search. The slash does nothing while you are typing in a field.'),
      entry('paragraph-enter', 'Enter on a paragraph', undefined,
        'In the plain-words reader, opens the annotation options for the focused paragraph: highlight it, add a note, or ask the AI to explain it. Only Explain this to me spends an AI use.',
        { needsAccount: true }),
    ],
  },
];

/** The page's opening paragraph: the allowance and the controls that spend it. */
export const HELP_OVERVIEW = 'AI uses are limited for each account, and the count resets once a day. Five things spend one: reading a paper in plain words for the first time at a level, choosing a level that paper has not been written at, Try again after a failed rewrite, Write it again, and Explain this to me. Everything else on this page spends no AI use.';

/** What each stamp on a row means, for the legend at the top of the page. */
export const HELP_ALLOWANCE_RULES: Record<HelpAllowance, string> = {
  free: 'Uses no allowance. Press it as often as you like.',
  ai: 'Spends one AI use every time.',
  'ai-new': 'Spends one AI use the first time. A version already written opens free.',
  publish: `Counts toward ${LIST_PUBLISHES_PER_DAY} public-list changes a day.`,
};

/** The stamp on a row: short, and never the only way the cost is said. */
export function allowanceLabel(allowance: HelpAllowance) {
  if (allowance === 'free') return 'Free';
  if (allowance === 'ai') return 'Uses 1 AI use';
  if (allowance === 'ai-new') return 'Uses 1 AI use unless saved';
  return 'Daily sharing limit';
}

/**
 * Where the reader stands today, in the words the card uses under Read in plain
 * words. Empty until the count is known, and for an account with no limit.
 */
export function aiUsesLine(uses: AIUses | null, locale: string, now = Date.now()) {
  if (!uses || uses.unlimited || !uses.dailyLimit || !uses.resetAt) return '';
  const resetsAt = Date.parse(uses.resetAt);
  if (Number.isNaN(resetsAt) || resetsAt <= now) return '';
  const reset = new Date(resetsAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return `You have ${uses.remainingUses} of ${uses.dailyLimit} AI uses left today. They reset at ${reset}.`;
}
