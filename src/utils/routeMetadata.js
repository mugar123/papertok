// Static route names for the SPA chrome. Two consumers: document.title
// (only for routes that do not title themselves) and the route-change
// announcement for screen readers (all mapped routes).

const LABELS = {
  '/': ['For you', 'Para ti'],
  '/lists': ['My lists', 'Mis listas'],
  '/research': ['Research', 'Research'],
  '/following': ['Following', 'Siguiendo'],
  '/search': ['Search', 'Buscar'],
  '/profile': ['My profile', 'Mi perfil'],
  // SettingsPage titles and headings itself "Configuración" (SettingsPage.jsx),
  // so the announcement must call the page what the page calls itself.
  '/settings': ['Settings', 'Configuración'],
  '/settings/profile': ['Edit profile', 'Editar perfil'],
  '/settings/following': ['Following settings', 'Ajustes de seguimiento'],
  '/settings/comments': ['My comments', 'Mis comentarios'],
  '/login': ['Sign in', 'Iniciar sesión'],
  '/onboarding': ['Welcome', 'Bienvenida'],
}

// These set document.title on their own (SettingsPage, ProfilePage,
// PublicProfilePage in selfMode); the announcer still announces them.
const SELF_TITLED = new Set(['/settings', '/settings/profile', '/profile'])

function normalize(pathname) {
  return pathname === '/' ? '/' : pathname.replace(/\/+$/, '')
}

export function routeLabel(pathname, isEnglish) {
  const entry = LABELS[normalize(pathname)]
  return entry ? entry[isEnglish ? 0 : 1] : null
}

export function routeTitle(pathname, isEnglish) {
  const normalized = normalize(pathname)
  if (SELF_TITLED.has(normalized)) return null
  const label = routeLabel(normalized, isEnglish)
  return label ? `${label} | PaperTok` : null
}
