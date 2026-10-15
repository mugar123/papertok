import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeTitle, routeLabel } from './routeMetadata.js'

test('titles the main authenticated routes', () => {
  assert.equal(routeTitle('/feed'), 'For you | PaperTok')
  assert.equal(routeTitle('/lists'), 'My lists | PaperTok')
  assert.equal(routeTitle('/following'), 'Following | PaperTok')
  assert.equal(routeTitle('/search'), 'Search | PaperTok')
})

test('normalizes trailing slashes', () => {
  assert.equal(routeTitle('/lists/'), 'My lists | PaperTok')
})

test('returns null for self-titled and unknown routes', () => {
  // The settings pages and the public pages already manage document.title
  // themselves (SettingsPage.jsx, usePublicPageMetadata); the announcer must
  // not fight them.
  assert.equal(routeTitle('/settings'), null)
  for (const page of ['profile', 'discovery', 'reading', 'notifications', 'privacy']) {
    assert.equal(routeTitle(`/settings/${page}`), null, `/settings/${page}`)
  }
  assert.equal(routeTitle('/public/paper/x'), null)
  assert.equal(routeTitle('/nonsense'), null)
})

test('labels announce even self-titled routes', () => {
  // Each settings page titles itself "<page> · Settings", so the
  // announcement must match that rather than a different word.
  assert.equal(routeLabel('/settings'), 'Settings')
  assert.equal(routeLabel('/settings/profile'), 'Profile & account · Settings')
  assert.equal(routeLabel('/settings/privacy'), 'Privacy · Settings')
  assert.equal(routeLabel('/nonsense'), null)
})
