import assert from 'node:assert/strict';
import test from 'node:test';
import { cardPhotoUrl, paperShareCardFor, shareCardFor } from './share-card.ts';

test('an author\'s card prints the name, the initials and the counts', () => {
  const card = shareCardFor('author', 'Author', {
    name: 'Yiqing Hua',
    worksCount: 23,
    citedByCount: 2009,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Face.jpg/100px-Face.jpg',
  })!;
  assert.equal(card.name, 'Yiqing Hua');
  assert.equal(card.initials, 'YH');
  assert.deepEqual(card.facts, ['23 works', '2,009 citations']);
  assert.equal(card.photoUrl, '', 'no author has a photo in PaperTok, whatever a record links');
  assert.equal(card.alt, 'Yiqing Hua, author on PaperTok. 23 works, 2,009 citations.');
});

test('an institution\'s card names where it is and carries its logo', () => {
  const card = shareCardFor('institution', 'Institution', {
    name: 'Harvard University',
    subtitle: 'Cambridge, United States',
    imageUrl: 'https://commons.wikimedia.org/w/index.php?title=Special:Redirect/file/Harvard%20University%20logo.svg&width=300',
  })!;
  assert.equal(card.initials, '');
  assert.match(card.photoUrl, /width=330$/);
  assert.equal(card.alt, 'Harvard University, institution on PaperTok. Cambridge, United States.');
});

test('only an institution\'s card carries a picture', () => {
  const imageUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Diagram.png/100px-Diagram.png';
  assert.equal(shareCardFor('concept', 'Research topic', { name: 'Computer science', imageUrl })!.photoUrl, '');
  assert.equal(shareCardFor('source', 'Scientific journal', { name: 'Nature', imageUrl })!.photoUrl, '');
});

test('a count the provider did not give, or gave as zero, stays off the card', () => {
  const card = shareCardFor('topic', 'Research topic', { name: 'Atmospheric chemistry', worksCount: 1, citedByCount: 0 })!;
  assert.deepEqual(card.facts, ['1 work']);
  assert.deepEqual(shareCardFor('topic', 'Research topic', { name: 'Atmospheric chemistry', worksCount: null })!.facts, []);
  assert.equal(shareCardFor('topic', 'Research topic', { name: 'Atmospheric chemistry' })!.alt, 'Atmospheric chemistry, research topic on PaperTok.');
});

test('a name the card\'s fonts cannot draw has no card, and such a subtitle is left out', () => {
  assert.equal(shareCardFor('institution', 'Institution', { name: '清华大学' }), null);
  assert.equal(shareCardFor('author', 'Author', { name: '' }), null);
  assert.equal(shareCardFor('unknown', 'Entity', { name: 'Anything' }), null);
  const card = shareCardFor('institution', 'Institution', { name: 'Tsinghua University', subtitle: '清华大学' })!;
  assert.equal(card.subtitle, '');
  assert.ok(shareCardFor('author', 'Author', { name: 'Łukasz Ćwikliński-Nguyễn' }), 'Latin with diacritics is drawn');
});

test('a very long name is clipped with an ellipsis', () => {
  const name = 'A'.repeat(200);
  const card = shareCardFor('project', 'Research project', { name })!;
  assert.ok(card.name.length < name.length);
  assert.ok(card.name.endsWith('…'));
});

test('an institution\'s picture is its Wikimedia thumbnail, asked at the disc\'s width', () => {
  assert.equal(
    cardPhotoUrl('https://commons.wikimedia.org/w/index.php?title=Special:Redirect/file/Harvard%20University%20logo.svg&width=300'),
    'https://commons.wikimedia.org/w/index.php?title=Special%3ARedirect%2Ffile%2FHarvard+University+logo.svg&width=330',
  );
  assert.equal(
    cardPhotoUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/MIT_logo.svg/100px-MIT_logo.svg.png'),
    'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/MIT_logo.svg/330px-MIT_logo.svg.png',
  );
});

test('a picture the card cannot draw, a GIF or a WebP, is not fetched', () => {
  assert.equal(cardPhotoUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/6/6a/Sorting_quicksort_anim.gif/100px-Sorting_quicksort_anim.gif'), '');
  assert.equal(cardPhotoUrl('https://commons.wikimedia.org/w/index.php?title=Special:Redirect/file/Campus.webp&width=300'), '');
});

test('a picture from anywhere but Wikimedia, or over plain http, is not fetched', () => {
  assert.equal(cardPhotoUrl('https://example.com/logo.png'), '');
  assert.equal(cardPhotoUrl('http://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Logo.png/100px-Logo.png'), '');
  assert.equal(cardPhotoUrl('https://commons.wikimedia.org/wiki/File:Logo.png'), '');
  assert.equal(cardPhotoUrl('https://upload.wikimedia.org.example.com/thumb/a/100px-x.png'), '');
  assert.equal(cardPhotoUrl('not a url'), '');
});

test('a paper\'s card prints its title, first three authors and venue', () => {
  const card = paperShareCardFor({
    title: 'The state of OA: a large-scale analysis of the prevalence and impact of Open Access articles',
    authors: ['Heather Piwowar', 'Jason Priem', 'Vincent Larivière', 'Juan Pablo Alperin', 'Lisa Matthias'],
    journal: 'PeerJ',
    year: 2018,
  })!;
  assert.equal(card.authors, 'Heather Piwowar, Jason Priem, Vincent Larivière et al.');
  assert.equal(card.venue, 'PeerJ · 2018');
});

test('when three authors do not fit, fewer are named and "et al." stays', () => {
  const card = paperShareCardFor({
    title: 'A title',
    authors: [
      'Maria Fernanda Rodríguez-Villalobos', 'Krishnamurthy Venkataraghavan Subramanian',
      'Anne-Marie Leclerc-Beauchamp', ...Array.from({ length: 14 }, (_, index) => `Author ${index + 4}`),
    ],
  })!;
  assert.equal(card.authors, 'Maria Fernanda Rodríguez-Villalobos et al.');
  const three = paperShareCardFor({
    title: 'A title',
    authors: ['Alexandra Kowalczyk-Brennan', 'Christopher Montgomery', 'Elizabeth Fairweather', 'Sam Lee'],
  })!;
  assert.equal(three.authors, 'Alexandra Kowalczyk-Brennan, Christopher Montgomery et al.', 'three names here clipped "et al." on the rendered card');
});

test('a title the fonts cannot draw has no card; such authors or a venue are left off', () => {
  assert.equal(paperShareCardFor({ title: 'Readout with α-tuned pulses', authors: [] }), null);
  const card = paperShareCardFor({ title: 'Deep learning', authors: ['张伟', 'Li Wei'], journal: 'Zeitschrift für Physik', year: 2020 })!;
  assert.equal(card.authors, '', 'a line with a name the fonts lack is left off whole, not with the name skipped');
  assert.equal(card.venue, '2020', 'the mono font carries no ü, so only the year is printed');
});
