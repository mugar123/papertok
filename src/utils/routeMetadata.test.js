import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeTitle, routeLabel } from './routeMetadata.js'

test('titles the main authenticated routes', () => {
  assert.equal(routeTitle('/feed'), 'For you | PaperTok')
  assert.equal(routeTitle('/lists'), 'My lists | PaperTok')
  assert.equal(routeTitle('/research'), 'Research | PaperTok')
  assert.equal(routeTitle('/following'), 'Following | PaperTok')
  assert.equal(routeTitle('/search'), 'Search | PaperTok')
})

test('normalizes trailing slashes', () => {
  assert.equal(routeTitle('/lists/'), 'My lists | PaperTok')
})

test('returns null for self-titled and unknown routes', () => {
  // Settings, /settings/profile, /profile and the public pages already
  // manage document.title themselves (SettingsPage.jsx:384,
  // ProfilePage.jsx:341, PublicProfilePage's selfMode via
  // usePublicPageMetadata); the announcer must not fight them.
  assert.equal(routeTitle('/settings'), null)
  assert.equal(routeTitle('/settings/profile'), null)
  assert.equal(routeTitle('/profile'), null)
  assert.equal(routeTitle('/public/paper/x'), null)
  assert.equal(routeTitle('/nonsense'), null)
})

test('labels announce even self-titled routes', () => {
  // SettingsPage titles and headings itself "Settings", so the
  // announcement must match that rather than a different word.
  assert.equal(routeLabel('/settings'), 'Settings')
  assert.equal(routeLabel('/profile'), 'My profile')
  assert.equal(routeLabel('/settings/profile'), 'Edit profile')
  assert.equal(routeLabel('/nonsense'), null)
})
