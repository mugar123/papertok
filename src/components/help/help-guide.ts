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
import type { AIUses } from '../../services/paper-rewrite-service.ts';

/**
 * What the Worker allows each account per day, as wrangler.toml sets it:
 * AI_DAILY_USER_LIMIT and PUBLIC_LIST_USER_DAILY_LIMIT. A visitor has no
 * account to ask the Worker about, so the page states both, and
 * help-guide.test.ts compares them with the file. A signed-in reader also sees
 * their own count, which the Worker sends (`AIUses.dailyLimit`).
 */
export const AI_USES_PER_DAY = 10;
export const LIST_PUBLISHES_PER_DAY = 60;

/**
 * What a control spends from an allowance:
 * - `free`: nothing.
 * - `ai`: one AI use every time.
 * - `ai-new`: one AI use, unless that version is already written (it then opens free).
 * - `publish`: one of the day's public-list changes (publish, update, stop sharing).
 * - `publish-if-public`: nothing on a private list, one public-list change on a public one.
 */
export type HelpAllowance = 'free' | 'ai' | 'ai-new' | 'publish' | 'publish-if-public';

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
  /** Whether a signed-out visitor is asked to sign in when they use it, or cannot reach it at all. */
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
        'Opens the paper by trying these in turn and stopping at the first that opens. First, your university’s library, if you linked one and it has the paper: a new tab. Then full text PaperTok finds for the paper, shown in PaperTok’s viewer; it looks for this, waiting a moment, when the paper has an arXiv, PubMed Central or DOI identifier and the first copy would not open in the viewer. Then, from this list in order: an open copy found for the paper (its PDF, then its page), the paper’s open-access PDF, its arXiv PDF, its own PDF link, a ChemRxiv page, and its landing page. Only a link on arxiv.org opens in PaperTok’s viewer; every other one, a repository PDF included, opens in a new tab. If none opens, PaperTok looks for an open copy by DOI, if the paper has one, and as a last resort opens the DOI page in a new tab. The label says what was found: Read full text, Read open version, Via followed by your university’s name, or Source.'),
      entry('plain-words', 'Read in plain words', Sparkle,
        'Opens the reader, where AI rewrites the paper’s full text in plainer language at your level. It shows only on papers whose full text can be read, and reads “Simple” on a screen 640px wide or less. The first rewrite of a paper at a level spends one AI use. A version already written opens free, and the line under the button says so or shows how many uses you have left.',
        { allowance: 'ai-new', needsAccount: true }),
      entry('publisher', 'Publisher’s page', ArrowSquareOut,
        'Shows on a card with no abstract when the paper has a DOI. Opens the publisher’s page in a new tab. Next to Read in plain words it shows only the arrow.'),
      entry('like', 'Like', Heart,
        'Likes the paper. The heart fills in; press again to undo. Likes teach your For you feed what you want to see, and liked papers are listed under Favorites in My lists.',
        { needsAccount: true }),
      entry('save', 'Save', BookmarkSimple,
        `Saves the paper to Read later at once and offers Add to list in a message. Press again to take it out of Read later and every list; the message offers Undo. On a touch screen, holding the button for half a second opens the list picker instead. Taking the paper out of a public list, or adding it to one from the picker, updates that list’s public copy, and each update counts toward ${LIST_PUBLISHES_PER_DAY} public-list changes a day. Read later is never public.`,
        { allowance: 'publish-if-public', needsAccount: true }),
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
    title: 'Words on a paper card',
    intro: 'These have no icon. Each one is a link or button made of words, except the study-type label, which only informs.',
    entries: [
      entry('field', 'Field name above the title', undefined,
        'Opens that field or topic in the explorer, with its papers and authors.'),
      entry('title', 'The title (touch screens)', undefined,
        'On a phone or other touch screen, opens the abstract sheet, which shows the whole title and abstract.'),
      entry('abstract', 'Read full abstract / Show less', undefined,
        'Expands the abstract on the card, or opens it in a sheet on a touch screen. Tapping the abstract does the same.'),
      entry('authors', 'The author initials', undefined,
        'Press the row of initials to list every author: on a screen 768px wide or more the list unfolds under the initials, on a narrower one it opens as a sheet. Each name opens that author in the explorer.'),
      entry('study-type', 'Study-type label', undefined,
        'Randomized controlled trial, Systematic review, Meta-analysis or Practice guideline, in the line above the title when the paper’s record says so. It is information only: not a button and not a link.'),
      entry('trial-number', 'Trial registration number (NCT…)', undefined,
        'Shows in the same line when the paper has a ClinicalTrials.gov number. It is a link: it opens that study on ClinicalTrials.gov in a new tab.'),
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
    intro: 'Opens over the page you pressed Read in plain words on. The text is an AI adaptation of the full text and does not replace the paper.',
    signedInOnly: true,
    entries: [
      entry('level', 'Level', Plant,
        'Beginner, University or Researcher. The button shows the icon of the current level: a plant, a graduation cap or a flask. The starting level is your default in Settings under Reading & AI. Choosing a level this paper has not been written at spends one AI use; a level already written opens free. The level cannot be changed while a rewrite is being written.',
        { allowance: 'ai-new', needsAccount: true }),
      entry('write-again', 'Write it again', ArrowClockwise,
        'Shows under a reused summary. Writes a new version and replaces the saved one. Spends one AI use. If the new one stops early, the old one stays.',
        { allowance: 'ai', needsAccount: true }),
      entry('retry', 'Try again', ArrowClockwise,
        'Shows when a rewrite failed or stopped early. Asks for the rewrite again and spends one AI use, unless a saved version turns up. The use is given back when the service is busy or unavailable, when the paper’s file cannot be downloaded, or when the provider’s own daily limit is reached. It is not given back after a timeout or an empty or unusable answer, or when you close the reader mid-rewrite.',
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
        'Closes the reader and returns to the page underneath.',
        { needsAccount: true }),
    ],
  },
  {
    id: 'viewer',
    title: 'The paper viewer',
    intro: 'Opens from Read article when PaperTok shows the paper itself: a copy on arxiv.org, or full text it found. Other copies open in a new tab. The viewer uses no AI.',
    entries: [
      entry('viewer-contents', 'Contents', ListBullets,
        'Opens the paper’s outline while the text is shown. Pick a section to jump to it.'),
      entry('viewer-notes', 'Notes', NotePencil,
        'Opens the panel of your highlights and notes, with a count. Shows while the text is shown. Select text in the paper to add one.',
        { needsAccount: true }),
      entry('show-text', 'Show text', TextAlignLeft,
        'In the paper’s options while the PDF is shown, when the paper also has text: switches to the text, set for reading. Settings › Reading & AI › Reader chooses whether the text starts with the abstract.'),
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
    intro: 'The bar at the top of the app. Your picture or initial, at its right end, opens the account menu: My profile, My lists, Settings, the theme and Log out.',
    signedInOnly: true,
    entries: [
      entry('for-you', 'For you', Stack,
        'Papers picked from your interests, follows, likes and saves. Pressing the tab you are on reloads the feed.'),
      entry('most-recent', 'Most recent', ClockCounterClockwise,
        'Papers on your topics that you have not seen yet, newest first.'),
      entry('following', 'Following', UserCheck,
        'Papers from the authors, institutions, topics and projects you follow.'),
      entry('own-feeds', 'Your own feeds', undefined,
        `Feeds you made from topics, authors, journals and keywords show as tabs after Following. You can have up to ${MAX_CUSTOM_FEEDS}, each with up to ${MAX_FEED_INGREDIENTS} ingredients. Edit feed, Move left, Move right and Delete feed are in the tab’s menu, and as buttons in the Feeds window, which Edit feeds in Settings under Discovery opens.`),
      entry('new-feed', 'New feed', Plus,
        'The plus after the tabs. Opens a form to name a feed and choose what goes in it.'),
      entry('search', 'Search', MagnifyingGlass,
        'Searches papers, authors, institutions, topics and projects. The keys / or Ctrl+K (⌘K on a Mac) open it from most screens.'),
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
        'Follows this author, institution, topic or project, so its papers show in Following. The icon fills in once followed; press again to unfollow.',
        { needsAccount: true }),
      entry('explorer-share', 'Share', ShareNetwork,
        'Copies the page’s link or shares it to a network.'),
      entry('make-feed', 'Make it a feed', Plus,
        `Turns this page into a feed tab. Shows on areas, topics, keyword searches, authors with an OpenAlex profile and journals. Across its feeds an account can hold ${MAX_ACCOUNT_ENTITIES} authors, topics and journals and ${MAX_ACCOUNT_KEYWORDS} keywords.`,
        { needsAccount: true }),
      entry('explorer-search', 'Search this page', MagnifyingGlass,
        'Searches the papers or authors on this page. The Papers and Authors buttons beside it choose which list; Authors is there only on pages that have authors to list.',
        { needsAccount: true }),
      entry('filters', 'Filters', Funnel,
        'Opens a panel with three filters and a sort order. The filters are Area, Published (Any time, Last year or Last 5 years) and Peer-reviewed only. Each filter that is on shows as a chip below the search box; press a chip to remove that filter. On a screen wider than 768px the Filters button also counts them, as in Filters · 2; on one 768px wide or narrower the button is a funnel icon that turns active instead. In the panel, Reset clears the three filters and closes the panel, and the Show … papers button closes it with them kept. Sort by, Most cited or Most recent, is set in the same panel but is not a filter: it has no chip, it is not counted, and Reset leaves it as it is.',
        { needsAccount: true }),
    ],
  },
  {
    id: 'lists',
    title: 'Lists',
    intro: 'The save picker and the My lists page. Favorites (your likes), Read later and Reading history fill in as you like, save and read. Lists you make can hold notes and tags. Changing a public list also updates its public copy, which counts toward the daily limit; the stamp “Counts if a list is public” marks those controls.',
    signedInOnly: true,
    entries: [
      entry('new-list', 'New list', Plus,
        `Makes a list with a name, an icon, a colour and Private or Public. Choosing Public publishes the list at once, which counts toward ${LIST_PUBLISHES_PER_DAY} public-list changes a day; a private list counts for nothing.`,
        { allowance: 'publish-if-public' }),
      entry('export', 'Export', DownloadSimple,
        'In an open list. Downloads its citations as BibTeX (.bib) or RIS (.ris).'),
      entry('publish', 'Publish & share', GlobeHemisphereWest,
        `Makes the list public: anyone with the link can read it. Publishing, updating a public list and stopping sharing each count toward ${LIST_PUBLISHES_PER_DAY} a day per account.`,
        { allowance: 'publish' }),
      entry('stop-sharing', 'Stop sharing', LinkBreak,
        'Makes the list private again. Its public link stops working.',
        { allowance: 'publish' }),
      entry('edit-list', 'Edit list', PencilSimple,
        'Changes the list’s name, icon and colour. On a public list it updates the public copy, which counts toward the daily limit.',
        { allowance: 'publish-if-public' }),
      entry('delete-list', 'Delete list', Trash,
        'Deletes the list after you confirm. The papers stay saved. A public list is stopped from sharing first, which counts toward the daily limit; once the limit is used up, a public list cannot be deleted until it resets.',
        { allowance: 'publish-if-public' }),
      entry('edit-note', 'Edit note and tags', PencilSimple,
        'On a paper in a list. Adds a note and tags. They are not part of a public list’s copy, so they count for nothing. The same window also changes which lists hold the paper, and that counts as it does under Save.'),
      entry('remove-paper', 'Remove from list', Trash,
        'Takes the paper out of this list. On a public list it updates the public copy, which counts toward the daily limit.',
        { allowance: 'publish-if-public' }),
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    intro: 'Reached from the account menu: your picture or initial, at the right end of the top bar. Only an account has Settings; a visitor does not. The Settings pages are listed down the left of the Settings page, or in the page switcher at its top on a narrow screen.',
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
        'Discovery page. Opens the Feeds window: your feeds in tab order, each with Move up, Move down, Edit and Delete, and a New feed button.'),
      entry('edit-interests', 'Edit interests', PencilSimple,
        'Discovery page. Chooses the subjects that train your feed.'),
      entry('default-level', 'Default AI level', Sparkle,
        'Reading & AI page. Sets the level Read in plain words starts at. The same page lists the papers you have read in plain words.'),
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
        'On a touch screen, half a second on Save opens the list picker. A mouse click saves at once. Adding the paper to a public list from the picker counts toward the daily limit.',
        { allowance: 'publish-if-public', needsAccount: true }),
      entry('swipe-tabs', 'Swipe sideways on the feed', undefined,
        'On a touch screen, a quick sideways swipe moves to the next or previous feed tab. It must start away from the screen’s edges.',
        { needsAccount: true }),
      entry('pull-refresh', 'Pull down at the top of the feed', undefined,
        'On a touch screen, drag down on the first card, or from just under the bar on another card, to reload the feed.',
        { needsAccount: true }),
      entry('arrow-keys', 'Arrow Up and Arrow Down', undefined,
        'Moves to the previous or next paper when focus is not on a button, link or field.',
        { needsAccount: true }),
      entry('tab-menu', 'Right-click or hold a feed tab', undefined,
        'Opens the tab’s menu: Edit feed, Move left, Move right and Delete feed. The Menu key or Shift+F10 opens it from a keyboard. The Feeds window in Settings, opened from Discovery, has buttons for the same.',
        { needsAccount: true }),
      entry('search-key', '/ or Ctrl+K (⌘K)', undefined,
        'Opens search. The slash does nothing while you are typing in a field.',
        { needsAccount: true }),
      entry('paragraph-enter', 'Enter on a paragraph', undefined,
        'In the plain-words reader, opens the annotation options for the focused paragraph: highlight it, add a note, or ask the AI to explain it. Only Explain this to me spends an AI use.',
        { needsAccount: true }),
    ],
  },
];

/** The page's opening paragraph: the allowance and the controls that spend it. */
export const HELP_OVERVIEW = `Each account has ${AI_USES_PER_DAY} AI uses a day, renewing at 00:00 UTC. Without an account there is no AI. Five things spend one: reading a paper in plain words for the first time at a level, choosing a level that paper has not been written at, Try again after a failed rewrite, Write it again, and Explain this to me. Everything else on this page spends no AI use.`;

/** What each stamp on a row means, for the legend at the top of the page. */
export const HELP_ALLOWANCE_RULES: Record<HelpAllowance, string> = {
  free: 'Uses no allowance. Press it as often as you like.',
  ai: 'Spends one AI use every time.',
  'ai-new': 'Spends one AI use the first time. A version already written opens free.',
  publish: `Counts toward ${LIST_PUBLISHES_PER_DAY} public-list changes a day.`,
  'publish-if-public': `Free on a private list. On a public list it counts toward ${LIST_PUBLISHES_PER_DAY} public-list changes a day.`,
};

/** The stamp on a row: short, and never the only way the cost is said. */
export function allowanceLabel(allowance: HelpAllowance) {
  if (allowance === 'free') return 'Free';
  if (allowance === 'ai') return 'Uses 1 AI use';
  if (allowance === 'ai-new') return 'Uses 1 AI use unless saved';
  if (allowance === 'publish') return 'Daily sharing limit';
  return 'Counts if a list is public';
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
