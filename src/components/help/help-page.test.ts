import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderApp } from '../../../tests/dom/render-app.ts';
// After render-app, which makes the jsdom browser these queries read.
import { screen, within } from '@testing-library/react';
import { HELP_SECTIONS } from './help-guide.ts';

// A visitor with no session opens /help: the route is public, so the app does
// not send them to the welcome, and every sign-in requirement is on the page.
test('a visitor without an account sees the Help page at /help, with every account requirement shown', async () => {
  const app = await renderApp('/help');
  try {
    await screen.findByRole('heading', { level: 1, name: 'Help' });
    assert.equal(window.location.pathname, '/help');
    assert.equal(screen.queryByRole('button', { name: /sign in/i }), null);

    for (const section of HELP_SECTIONS) {
      const heading = screen.getByRole('heading', { level: 2, name: section.title });
      const region = heading.closest('section');
      assert.ok(region, `${section.title} is a section`);
      const rows = within(region).getAllByRole('listitem');
      assert.equal(rows.length, section.entries.length, `${section.title} lists every control`);
      const sectionNote = within(region).queryByText(/Every control in this section needs you to be signed in./) !== null;
      assert.equal(sectionNote, Boolean(section.signedInOnly), `${section.title}: the section says it needs an account`);
      section.entries.forEach((entry, index) => {
        const row = rows[index];
        assert.ok(within(row).getByRole('heading', { level: 3, name: entry.name }), entry.name);
        const rowStamp = within(row).queryByText('Account needed') !== null;
        assert.equal(rowStamp, entry.needsAccount && !section.signedInOnly, `${entry.id}: its own account stamp`);
      });
    }
  } finally {
    await app.stop();
  }
});

test('the welcome page has a Help link a visitor can reach, opening in a new tab so the answers so far are kept', async () => {
  const app = await renderApp('/onboarding');
  try {
    const link = await screen.findByRole('link', { name: 'Help (opens in a new tab)' });
    assert.equal(link.getAttribute('href'), '/help');
    assert.equal(link.getAttribute('target'), '_blank');
  } finally {
    await app.stop();
  }
});
