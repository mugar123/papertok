import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// «Leer en simple» is what the welcome sheet promises, and for a guest it
// opened the sign-in dialog with no warning (audit 2026-09-23, issue 9). The
// button now says so before the press — a lock for the eye, a description
// for assistive tech — without touching its accessible name, which
// paperCardActionNames.test.js keeps equal to what it shows (WCAG 2.5.3).
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const card = stripComments(readFileSync(new URL('./PaperCard.jsx', import.meta.url), 'utf8'));
// The first visit's copy lives on the welcome page now (GuestWelcome); the
// interests sheet only edits areas and says nothing about reading.
const welcome = stripComments(readFileSync(new URL('../Public/GuestWelcome.jsx', import.meta.url), 'utf8'));

function rewriteButton() {
  const start = card.indexOf('<Button\n                variant="brand"');
  const end = card.indexOf('</Button>', start);
  assert.ok(start >= 0 && end > start, 'the rewrite button is where the card draws it');
  return card.slice(start, end + '</Button>'.length);
}

test('a guest sees that plain-words reading needs an account, and hears it', () => {
  const button = rewriteButton();
  assert.match(button, /aria-describedby=\{publicMode \? rewriteHintId : undefined\}/);
  assert.match(button, /\{publicMode && <Lock size=\{13\} className="pc-action-lock" aria-hidden="true" \/>\}/);
  assert.doesNotMatch(button, /aria-label=/);

  const after = card.slice(card.indexOf(button) + button.length, card.indexOf(button) + button.length + 400);
  assert.match(
    after,
    /^\s*\)\}\s*\{canRequestRewrite && publicMode && \(\s*<span id=\{rewriteHintId\} className="visually-hidden">\s*\{isEnglish \? 'Needs a free account' : 'Necesita una cuenta gratuita'\}\s*<\/span>\s*\)\}/,
  );
  assert.match(card, /const rewriteHintId = useId\(\);/);
});

test('the welcome no longer promises every paper in plain words', () => {
  const copy = welcome.slice(welcome.indexOf('const COPY = {'), welcome.indexOf('// Where a source sits') > 0 ? welcome.indexOf('// Where a source sits') : welcome.indexOf('function PaperStream'));
  assert.ok(copy.length > 0, 'the COPY table is where the welcome keeps it');
  assert.doesNotMatch(copy, /cada uno|each one/);
  // Said where the welcome shows the gesture, in its sentence.
  assert.match(copy, /Con una cuenta gratuita, muchos se pueden leer explicados en claro\./);
  assert.match(copy, /With a free account, many can be read in plain words\./);
});

// English content in the Spanish UI says so (AGENTS.md, accessibility rule 8):
// the provider's topic chips carry the `lang` their builder gives them, and the
// abstract is marked like the title already was.
test('provider chips and the abstract are marked as English', () => {
  assert.match(
    card,
    /className=\{`pc-semantic-tag pc-topic-link [^`]*`\}\s*lang=\{tag\.lang\}\s*onClick=\{\(event\) => openTopic\(event, topic\)\}/,
  );
  assert.match(card, /<motion\.p\s+key=\{abstractKey\}\s+ref=\{attachAbstractBody\}\s+lang=\{abstractText \? 'en' : undefined\}/);
});
