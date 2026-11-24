// Static route names for the SPA chrome. Two consumers: document.title
// (only for routes that do not title themselves) and the route-change
// announcement for screen readers (all mapped routes).

import { matchRoutes } from 'react-router-dom'
import { findConferenceEdition } from '../data/conferences.ts'
import { isConferencePath } from './conference-calendar.ts'
import { customFeedIdFromPath } from './feed-tabs.ts'

const LABELS: Record<string, string> = {
  '/feed': 'For you',
  '/recent': 'Most recent',
  '/lists': 'My lists',
  '/profile': 'My profile',
  '/following': 'Following',
  '/search': 'Search',
  '/help': 'Help',
  // Each settings page titles itself "<page> · Settings" (settings-page.tsx),
  // so the announcement calls the page what the page calls itself.
  '/settings': 'Settings',
  '/settings/profile': 'Account · Settings',
  '/settings/discovery': 'Discovery · Settings',
  '/settings/reading': 'Reading & AI · Settings',
  '/settings/notifications': 'Notifications · Settings',
  '/settings/privacy': 'Privacy · Settings',
  '/settings/following': 'Follows · Settings',
  '/login': 'Sign in',
  '/onboarding': 'Welcome',
  '/institution/verify': 'Verify your university email',
  '/zotero/callback': 'Connect Zotero',
  '/orcid/callback': 'Connect ORCID',
}

// These set document.title on their own (the SettingsPage pages); the
// announcer still announces them.
const SELF_TITLED = new Set([
  '/settings',
  '/settings/profile',
  '/settings/discovery',
  '/settings/reading',
  '/settings/notifications',
  '/settings/privacy',
])

function normalize(pathname: string) {
  return pathname === '/' ? '/' : pathname.replace(/\/+$/, '')
}

type NamedFeed = { id: string; name: string }

/** A custom feed's page is called by the feed's name; an id the reader has no feed for has none. */
export function routeLabel(pathname: string, feeds: readonly NamedFeed[] = []) {
  const normalized = normalize(pathname)
  if (isConferencePath(normalized)) {
    const id = matchRoutes([{ path: '/conferences/:editionId' }], normalized)?.[0]?.params.editionId
    return id ? findConferenceEdition(id)?.name ?? 'Conference not found' : 'Conference calendar'
  }
  const feedId = customFeedIdFromPath(normalized)
  if (feedId !== null) return feeds.find(feed => feed.id === feedId)?.name ?? null
  return LABELS[normalized] || null
}

export function routeTitle(pathname: string, feeds: readonly NamedFeed[] = []) {
  const normalized = normalize(pathname)
  if (SELF_TITLED.has(normalized)) return null
  // A feed this account's list does not name yet is "Your feed", as on its
  // page: no title would keep the one before, another account's after a switch.
  const label = routeLabel(normalized, feeds) ?? (customFeedIdFromPath(normalized) === null ? null : 'Your feed')
  return label ? `${label} | PaperTok` : null
}
