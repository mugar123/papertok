// Static route names for the SPA chrome. Two consumers: document.title
// (only for routes that do not title themselves) and the route-change
// announcement for screen readers (all mapped routes).

const LABELS: Record<string, string> = {
  '/feed': 'For you',
  '/lists': 'My lists',
  '/following': 'Following',
  '/search': 'Search',
  // Each settings page titles itself "<page> · Settings" (SettingsPage.jsx),
  // so the announcement calls the page what the page calls itself.
  '/settings': 'Settings',
  '/settings/profile': 'Account · Settings',
  '/settings/discovery': 'Discovery · Settings',
  '/settings/reading': 'Reading & AI · Settings',
  '/settings/notifications': 'Notifications · Settings',
  '/settings/privacy': 'Privacy · Settings',
  '/settings/following': 'Following settings',
  '/login': 'Sign in',
  '/onboarding': 'Welcome',
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

export function routeLabel(pathname: string) {
  return LABELS[normalize(pathname)] || null
}

export function routeTitle(pathname: string) {
  const normalized = normalize(pathname)
  if (SELF_TITLED.has(normalized)) return null
  const label = routeLabel(normalized)
  return label ? `${label} | PaperTok` : null
}
