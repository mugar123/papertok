// Static route names for the SPA chrome. Two consumers: document.title
// (only for routes that do not title themselves) and the route-change
// announcement for screen readers (all mapped routes).

const LABELS = {
  '/feed': 'For you',
  '/lists': 'My lists',
  '/research': 'Research',
  '/following': 'Following',
  '/search': 'Search',
  '/profile': 'My profile',
  // SettingsPage titles and headings itself "Settings" (SettingsPage.jsx), so
  // the announcement must call the page what the page calls itself.
  '/settings': 'Settings',
  '/settings/profile': 'Edit profile',
  '/settings/following': 'Following settings',
  '/settings/comments': 'My comments',
  '/login': 'Sign in',
  '/onboarding': 'Welcome',
}

// These set document.title on their own (SettingsPage, ProfilePage,
// PublicProfilePage in selfMode); the announcer still announces them.
const SELF_TITLED = new Set(['/settings', '/settings/profile', '/profile'])

function normalize(pathname) {
  return pathname === '/' ? '/' : pathname.replace(/\/+$/, '')
}

export function routeLabel(pathname) {
  return LABELS[normalize(pathname)] || null
}

export function routeTitle(pathname) {
  const normalized = normalize(pathname)
  if (SELF_TITLED.has(normalized)) return null
  const label = routeLabel(normalized)
  return label ? `${label} | PaperTok` : null
}
