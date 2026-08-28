import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeTitle, routeLabel } from './routeMetadata.js'

test('titles the main authenticated routes in both languages', () => {
  assert.equal(routeTitle('/', false), 'Para ti | PaperTok')
  assert.equal(routeTitle('/', true), 'For you | PaperTok')
  assert.equal(routeTitle('/lists', false), 'Mis listas | PaperTok')
  assert.equal(routeTitle('/research', true), 'Research | PaperTok')
  assert.equal(routeTitle('/following', false), 'Siguiendo | PaperTok')
  assert.equal(routeTitle('/search', true), 'Search | PaperTok')
})

test('normalizes trailing slashes', () => {
  assert.equal(routeTitle('/lists/', true), 'My lists | PaperTok')
})

test('returns null for self-titled and unknown routes', () => {
  // Settings, /settings/profile, /profile and the public pages already
  // manage document.title themselves (SettingsPage.jsx:384,
  // ProfilePage.jsx:341, PublicProfilePage's selfMode via
  // usePublicPageMetadata); the announcer must not fight them.
  assert.equal(routeTitle('/settings', false), null)
  assert.equal(routeTitle('/settings/profile', false), null)
  assert.equal(routeTitle('/profile', false), null)
  assert.equal(routeTitle('/profile', true), null)
  assert.equal(routeTitle('/public/paper/x', false), null)
  assert.equal(routeTitle('/nonsense', false), null)
})

test('labels announce even self-titled routes', () => {
  // SettingsPage titles and headings itself "Configuración", so the
  // announcement must match that rather than a different Spanish word.
  assert.equal(routeLabel('/settings', false), 'Configuración')
  assert.equal(routeLabel('/settings', true), 'Settings')
  assert.equal(routeLabel('/profile', false), 'Mi perfil')
  assert.equal(routeLabel('/profile', true), 'My profile')
  assert.equal(routeLabel('/settings/profile', false), 'Editar perfil')
  assert.equal(routeLabel('/settings/profile', true), 'Edit profile')
  assert.equal(routeLabel('/nonsense', false), null)
})
