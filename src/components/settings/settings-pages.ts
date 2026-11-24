import type { Icon } from '@phosphor-icons/react';
import { Bell, Compass, Question, ShieldCheck, Sparkle, UserCircle } from '@phosphor-icons/react';

export interface SettingsPageEntry { slug: string; label: string; summary: string; Icon: Icon; to?: string }

/** Help's entry, which the Help page names as the one it is on. */
export const HELP_PAGE: SettingsPageEntry = { slug: 'help', label: 'Help', summary: 'What each button and gesture does', Icon: Question, to: '/help' };

/**
 * The settings pages, one route each: a page carries one subject, so there is
 * no scroll position to track and nothing to spy on. Order is the rail's.
 * Help is the last entry but not a settings page: `to` sends it to /help,
 * which a visitor without an account can open too, and which draws this same
 * rail for a signed-in reader.
 */
/**
 * Whether `pathname` is the Follows dialog's route. Wider than a phone it
 * opens over Discovery (app.tsx), which stays the page the rail marks.
 */
export const isFollowsPath = (pathname: string) => pathname.replace(/\/+$/, '') === '/settings/following';

export const SETTINGS_PAGES: readonly SettingsPageEntry[] = [
  { slug: 'profile', label: 'Account', summary: 'Sign-in, university, delete account', Icon: UserCircle },
  { slug: 'discovery', label: 'Discovery', summary: 'Follows, feeds and interests', Icon: Compass },
  { slug: 'reading', label: 'Reading & AI', summary: 'AI level, the reader and your plain-words summaries', Icon: Sparkle },
  { slug: 'notifications', label: 'Notifications', summary: 'Email updates while PaperTok is closed', Icon: Bell },
  { slug: 'privacy', label: 'Privacy', summary: 'Usage analytics and author statistics', Icon: ShieldCheck },
  HELP_PAGE,
];
