// Static route names for the SPA chrome. Two consumers: document.title
// (only for routes that do not title themselves) and the route-change
// announcement for screen readers (all mapped routes).

import { customFeedIdFromPath } from './feed-tabs.ts'

const LABELS: Record<string, string> = {
  '/feed': 'For you',
  '/recent': 'Most recent',
  '/lists': 'My lists',
  '/following': 'Following',
  '/search': 'Search',
  // Each settings page titles itself "<page> · Settings" (settings-page.tsx),
  // so the announcement calls the page what the page calls itself.
  '/settings': 'Settings',
  '/settings/profile': 'Account · Settings',
  '/settings/discovery': 'Discovery · Settings',
  '/settings/reading': 'Reading & AI · Settings',
  '/settings/notifications': 'Notifications · Settings',
  '/settings/privacy': 'Privacy · Settings',
  '/settings/following': 'Following settings',
  '/settings/feeds': 'Feeds settings',
  '/login': 'Sign in',
  '/onboarding': 'Welcome',
  '/institution/verify': 'Verify your university email',
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
  const feedId = customFeedIdFromPath(normalized)
  if (feedId !== null) return feeds.find(feed => feed.id === feedId)?.name ?? null
  return LABELS[normalized] || null
}

export function routeTitle(pathname: string, feeds: readonly NamedFeed[] = []) {
  const normalized = normalize(pathname)
  if (SELF_TITLED.has(normalized)) return null
  const label = routeLabel(normalized, feeds)
  return label ? `${label} | PaperTok` : null
}
