import { nameInitials } from '../src/utils/name-initials.ts';

/**
 * The preview card of a shared profile: its name, its picture and what
 * OpenAlex counts for it, beside one of the welcome's etchings. The picture
 * is an institution's logo, the Wikimedia thumbnail OpenAlex links; everyone
 * else gets what the Explorer's header shows, an author's initials or the
 * type's icon. No author has a photo anywhere in PaperTok.
 *
 * A shared paper gets a card of its own: its title, authors and venue on
 * grained paper inside the same frame and stars.
 *
 * This module is pure: `shareCardFor` and `paperShareCardFor` decide what a
 * card says, and `shareCardTree` and `paperCardTree` lay it out for satori. share-card-render.ts draws it, so
 * the Node tests never load the WebAssembly renderer.
 */

export type CardArt = 'microscope' | 'scrolls' | 'lab';
type CardIcon = keyof typeof ICON_PATHS;

export interface ShareCardEntity {
  name: string;
  worksCount?: number | null;
  citedByCount?: number | null;
  subtitle?: string;
  imageUrl?: string;
}

export interface ShareCard {
  kicker: string;
  name: string;
  subtitle: string;
  facts: string[];
  initials: string;
  icon: CardIcon;
  photoUrl: string;
  art: CardArt;
  alt: string;
}

export interface PaperShareCard {
  title: string;
  authors: string;
  venue: string;
  alt: string;
}

export interface ShareCardPaper {
  title: string;
  authors: string[];
  journal?: string;
  year?: number | null;
}

export interface ShareCardAssets {
  art: Record<CardArt, string>;
  photo?: string | null;
}

export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;

// The characters the card's fonts carry (share-card-assets/README.md). A name
// outside them would print as blank boxes, so it gets the type's static image.
const DRAWABLE_RANGES = [
  [0x0020, 0x007e], [0x00a0, 0x024f], [0x0300, 0x036f], [0x1e00, 0x1eff],
  [0x2010, 0x2027], [0x2030, 0x203a], [0x20ac, 0x20ac],
];
const MAX_NAME_LENGTH = 110;
// IBM Plex Mono is cut to printable ASCII and a few marks (share-card-assets/README.md).
const MONO_RANGES = [[0x0020, 0x007e], [0x00b7, 0x00b7], [0x2013, 0x2014], [0x2019, 0x2019], [0x2026, 0x2026]];
const MAX_TITLE_LENGTH = 200;
// Measured: at 28px Newsreader Text the 960px column clips near 73 characters,
// so 66 leaves room for wide letters.
const MAX_AUTHORS_LENGTH = 66;
const MAX_VENUE_LENGTH = 60;

const MAX_SUBTITLE_LENGTH = 70;
// The files whose thumbnail is a PNG or a JPEG, the two the card can draw: an
// SVG's thumbnail is a PNG. A GIF or a WebP gets the icon instead.
const DRAWABLE_FILE = /\.(svg|png|jpe?g)$/i;
// A thumbnail wide enough for the disc. Wikimedia renders thumbnails in fixed
// steps; 330px is one of them.
const PHOTO_WIDTH = 330;

const INK = '#1d2b53';
const INK_SECONDARY = '#46527a';
const PAPER = '#fbf8f0';
const YELLOW = '#ffd21e';

// Phosphor's regular weight, as the Explorer draws each type (256 box).
const ICON_PATHS = Object.freeze({
  buildings: 'M240,208H224V96a16,16,0,0,0-16-16H144V32a16,16,0,0,0-24.88-13.32L39.12,72A16,16,0,0,0,32,85.34V208H16a8,8,0,0,0,0,16H240a8,8,0,0,0,0-16ZM208,96V208H144V96ZM48,85.34,128,32V208H48ZM112,112v16a8,8,0,0,1-16,0V112a8,8,0,1,1,16,0Zm-32,0v16a8,8,0,0,1-16,0V112a8,8,0,1,1,16,0Zm0,56v16a8,8,0,0,1-16,0V168a8,8,0,0,1,16,0Zm32,0v16a8,8,0,0,1-16,0V168a8,8,0,0,1,16,0Z',
  lightbulb: 'M176,232a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16h80A8,8,0,0,1,176,232Zm40-128a87.55,87.55,0,0,1-33.64,69.21A16.24,16.24,0,0,0,176,186v6a16,16,0,0,1-16,16H96a16,16,0,0,1-16-16v-6a16,16,0,0,0-6.23-12.66A87.59,87.59,0,0,1,40,104.49C39.74,56.83,78.26,17.14,125.88,16A88,88,0,0,1,216,104Zm-16,0a72,72,0,0,0-73.74-72c-39,.92-70.47,33.39-70.26,72.39a71.65,71.65,0,0,0,27.64,56.3A32,32,0,0,1,96,186v6h64v-6a32.15,32.15,0,0,1,12.47-25.35A71.65,71.65,0,0,0,200,104Zm-16.11-9.34a57.6,57.6,0,0,0-46.56-46.55,8,8,0,0,0-2.66,15.78c16.57,2.79,30.63,16.85,33.44,33.45A8,8,0,0,0,176,104a9,9,0,0,0,1.35-.11A8,8,0,0,0,183.89,94.66Z',
  fileText: 'M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z',
  briefcase: 'M216,56H176V48a24,24,0,0,0-24-24H104A24,24,0,0,0,80,48v8H40A16,16,0,0,0,24,72V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V72A16,16,0,0,0,216,56ZM96,48a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96ZM216,72v41.61A184,184,0,0,1,128,136a184.07,184.07,0,0,1-88-22.38V72Zm0,128H40V131.64A200.19,200.19,0,0,0,128,152a200.25,200.25,0,0,0,88-20.37V200ZM104,112a8,8,0,0,1,8-8h32a8,8,0,0,1,0,16H112A8,8,0,0,1,104,112Z',
});
const PT_PATH = 'M1.35 9.99Q0.70 9.99 0.43 9.79Q0.16 9.60 0.10 9.29Q0.05 8.99 0.05 8.67L0.05 1.31Q0.05 1.00 0.10 0.70Q0.16 0.40 0.43 0.21Q0.70 0.01 1.36 0.01L4.20 0.01Q4.74 0.01 5.37 0.24Q6.00 0.46 6.56 0.91Q7.12 1.37 7.48 2.05Q7.84 2.74 7.84 3.68Q7.84 4.61 7.48 5.29Q7.12 5.98 6.56 6.43Q6.00 6.88 5.37 7.10Q4.74 7.32 4.18 7.32L2.66 7.32L2.66 8.69Q2.66 9.00 2.60 9.30Q2.54 9.60 2.27 9.79Q2.00 9.99 1.35 9.99ZM2.66 2.62L2.66 4.71L4.20 4.71Q4.38 4.71 4.63 4.61Q4.87 4.52 5.05 4.29Q5.24 4.07 5.24 3.67Q5.24 3.37 5.10 3.13Q4.96 2.90 4.72 2.76Q4.48 2.62 4.18 2.62L2.66 2.62ZM9.35 0.00L15.87 0.00Q16.14 0.00 16.38 0.04Q16.62 0.09 16.79 0.31Q16.95 0.54 16.95 1.10Q16.95 1.64 16.79 1.88Q16.62 2.11 16.37 2.15Q16.12 2.20 15.85 2.20L13.89 2.20L13.89 8.73Q13.89 9.04 13.83 9.34Q13.77 9.63 13.51 9.81Q13.24 10 12.59 10Q11.96 10 11.69 9.81Q11.42 9.61 11.37 9.32Q11.32 9.03 11.32 8.72L11.32 2.20L9.33 2.20Q9.08 2.20 8.83 2.15Q8.58 2.10 8.41 1.87Q8.25 1.64 8.25 1.08Q8.25 0.54 8.41 0.31Q8.58 0.09 8.84 0.04Q9.09 0.00 9.35 0.00Z';
const STAR_PATH = 'M12 0C12.8 7 17 11.2 24 12C17 12.8 12.8 17 12 24C11.2 17 7 12.8 0 12C7 11.2 11.2 7 12 0Z';

const TYPE_LOOK: Record<string, { icon: CardIcon; art: CardArt }> = {
  author: { icon: 'buildings', art: 'microscope' },
  institution: { icon: 'buildings', art: 'scrolls' },
  source: { icon: 'fileText', art: 'scrolls' },
  topic: { icon: 'lightbulb', art: 'lab' },
  concept: { icon: 'lightbulb', art: 'lab' },
  project: { icon: 'briefcase', art: 'lab' },
};

const COUNT = new Intl.NumberFormat('en-US');

function count(value: number | null | undefined, one: string, many: string) {
  // Only a count OpenAlex gave: a missing one stays off the card.
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return `${COUNT.format(value)} ${value === 1 ? one : many}`;
}

function drawable(text: string, ranges = DRAWABLE_RANGES) {
  return [...text].every((character) => {
    const code = character.codePointAt(0)!;
    return ranges.some(([first, last]) => code >= first && code <= last);
  });
}

function clip(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

/**
 * The thumbnail OpenAlex links, asked for at the disc's width, or '' for
 * anything that is not one. OpenAlex links either Commons' file redirect or
 * an upload.wikimedia.org thumbnail; the fetch then only follows Wikimedia.
 */
export function cardPhotoUrl(url: string | undefined) {
  let parsed: URL;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:') return '';
  if (parsed.hostname === 'commons.wikimedia.org' && parsed.pathname === '/w/index.php'
    && (parsed.searchParams.get('title') || '').startsWith('Special:Redirect/file/')) {
    const title = parsed.searchParams.get('title')!;
    if (!DRAWABLE_FILE.test(title)) return '';
    const photo = new URL('https://commons.wikimedia.org/w/index.php');
    photo.searchParams.set('title', title);
    photo.searchParams.set('width', String(PHOTO_WIDTH));
    return photo.toString();
  }
  if (parsed.hostname === 'upload.wikimedia.org' && /\/thumb\/.+\/\d+px-[^/]+$/.test(parsed.pathname)
    && DRAWABLE_FILE.test(parsed.pathname.split('/').at(-2) || '')) {
    return `https://upload.wikimedia.org${parsed.pathname.replace(/\/\d+px-([^/]+)$/, `/${PHOTO_WIDTH}px-$1`)}`;
  }
  return '';
}

/**
 * What the card for an entity says, or null when it cannot say it: a name the
 * fonts cannot draw, or no name at all.
 */
export function shareCardFor(type: string, typeLabel: string, entity: ShareCardEntity): ShareCard | null {
  const look = TYPE_LOOK[type];
  const name = clip(String(entity.name || '').trim(), MAX_NAME_LENGTH);
  if (!look || !name || !drawable(name)) return null;
  const rawSubtitle = clip(String(entity.subtitle || '').trim(), MAX_SUBTITLE_LENGTH);
  const subtitle = rawSubtitle && drawable(rawSubtitle) ? rawSubtitle : '';
  const facts = [
    count(entity.worksCount, 'work', 'works'),
    count(entity.citedByCount, 'citation', 'citations'),
  ].filter((fact): fact is string => Boolean(fact));
  const initials = type === 'author' ? nameInitials(name) : '';
  // Only an institution's: OpenAlex links a logo for most of them, while a
  // concept's image is any diagram or photograph its Wikipedia article uses.
  const photoUrl = type === 'institution' ? cardPhotoUrl(entity.imageUrl) : '';
  const described = [subtitle, facts.join(', ')].filter(Boolean).join('. ');
  return {
    kicker: typeLabel,
    name,
    subtitle,
    facts,
    initials,
    icon: look.icon,
    photoUrl,
    art: look.art,
    alt: `${name}, ${typeLabel.toLowerCase()} on PaperTok.${described ? ` ${described}.` : ''}`,
  };
}

/**
 * The first three authors, or fewer when three do not fit on the card's one
 * line, so that "et al." is never what gets clipped.
 */
function cardAuthorLine(names: string[]) {
  for (let shown = Math.min(3, names.length); shown > 0; shown -= 1) {
    const line = `${names.slice(0, shown).join(', ')}${names.length > shown ? ' et al.' : ''}`;
    if (line.length <= MAX_AUTHORS_LENGTH || shown === 1) return clip(line, MAX_AUTHORS_LENGTH);
  }
  return '';
}

/**
 * What a paper's card says, or null when its title cannot be drawn. An author
 * line or a venue the fonts cannot draw is left off rather than printed as boxes.
 */
export function paperShareCardFor(paper: ShareCardPaper): PaperShareCard | null {
  const title = clip(paper.title.trim(), MAX_TITLE_LENGTH);
  if (!title || !drawable(title)) return null;
  const line = cardAuthorLine(paper.authors.map(name => name.trim()).filter(Boolean));
  const authors = drawable(line) ? line : '';
  const journal = clip(paper.journal?.trim() || '', MAX_VENUE_LENGTH);
  const venue = [drawable(journal.toUpperCase(), MONO_RANGES) ? journal : '', paper.year].filter(Boolean).join(' · ');
  return { title, authors, venue, alt: `${title}${authors ? `, by ${authors}` : ''}: a paper on PaperTok.` };
}

// ------------------------------------------------------------------ layout

type Style = Record<string, string | number>;
interface CardNode { type: string; props: Record<string, unknown> & { style?: Style; children?: unknown } }

function h(type: string, props: Record<string, unknown>, ...children: unknown[]): CardNode {
  const kids = children.filter(child => child !== null && child !== undefined && child !== false);
  if (kids.length === 0) return { type, props };
  return { type, props: { ...props, children: kids.length === 1 ? kids[0] : kids } };
}

function svgPath(path: string, viewBox: string, style: Style, fill = INK, extra: Record<string, unknown> = {}) {
  return h('svg', { viewBox, style }, h('path', { d: path, fill, ...extra }));
}

function star(left: number, top: number, size: number, spot: boolean) {
  return svgPath(STAR_PATH, '-1 -1 26 26', { position: 'absolute', left, top, width: size, height: size },
    spot ? YELLOW : INK, spot ? { stroke: INK, strokeWidth: 1, strokeLinejoin: 'round' } : {});
}

// The type's etching sits behind the disc and spills out of it.
const ART_LAYOUT: Record<CardArt, { width: number; height: number; left: number; top: number; rotate: number }> = {
  microscope: { width: 200, height: 330, left: 945, top: 56, rotate: 12 },
  scrolls: { width: 230, height: 240, left: 930, top: 330, rotate: -8 },
  lab: { width: 250, height: 193, left: 880, top: 360, rotate: -12 },
};

function nameSize(name: string) {
  if (name.length <= 18) return 84;
  if (name.length <= 28) return 72;
  if (name.length <= 42) return 60;
  if (name.length <= 64) return 50;
  return 42;
}

function avatar(card: ShareCard, photo: string | null | undefined) {
  if (photo) {
    // Mostly a logo or a seal: the whole of it, inside the disc.
    return h('img', { src: photo, width: 220, height: 220, style: { width: 220, height: 220, objectFit: 'contain' } });
  }
  if (card.initials) {
    return h('div', { style: { display: 'flex', fontFamily: 'Newsreader Display', fontSize: 132, color: INK, letterSpacing: 2, marginTop: 18 } }, card.initials);
  }
  return svgPath(ICON_PATHS[card.icon], '0 0 256 256', { width: 132, height: 132 });
}

/** The card as a satori tree, with its etching and picture already as data URLs. */
export function shareCardTree(card: ShareCard, assets: ShareCardAssets): CardNode {
  const art = ART_LAYOUT[card.art];
  return h('div', {
    style: {
      display: 'flex', position: 'relative', width: SHARE_CARD_WIDTH, height: SHARE_CARD_HEIGHT,
      background: PAPER, color: INK, fontFamily: 'Newsreader Text',
    },
  },
  h('div', { style: { position: 'absolute', left: 22, top: 22, right: 22, bottom: 22, border: `2px solid ${INK}`, borderRadius: 6 } }),
  // Inside the frame, whatever the etching's rotation.
  h('div', { style: { position: 'absolute', left: 24, top: 24, right: 24, bottom: 24, display: 'flex', overflow: 'hidden' } },
    h('img', {
      src: assets.art[card.art], width: art.width, height: art.height,
      style: { position: 'absolute', left: art.left - 24, top: art.top - 24, width: art.width, height: art.height, transform: `rotate(${art.rotate}deg)` },
    })),
  star(724, 92, 30, true),
  star(1096, 96, 14, false),
  star(726, 500, 22, true),
  star(1110, 540, 14, false),
  h('div', {
    style: {
      position: 'absolute', left: 750, top: 150, width: 300, height: 300, display: 'flex',
      alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
      borderRadius: 150, border: `3px solid ${INK}`, background: assets.photo ? '#ffffff' : YELLOW, boxShadow: `8px 8px 0 ${INK}`,
    },
  }, avatar(card, assets.photo)),
  h('div', {
    style: {
      position: 'absolute', left: 84, top: 64, bottom: 56, width: 620,
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    },
  },
  h('div', { style: { display: 'flex', alignItems: 'center' } },
    h('div', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: 48, height: 48,
        borderRadius: 6, background: YELLOW, border: `1.5px solid ${INK}`, boxShadow: `4px 4px 0 ${INK}`,
      },
    }, svgPath(PT_PATH, '0 0 17 10', { width: 26, height: 15 })),
    h('div', { style: { display: 'flex', marginLeft: 14, fontFamily: 'Inter', fontSize: 32, letterSpacing: -1 } },
      'Paper',
      h('span', { style: { borderBottom: `9px solid ${YELLOW}`, paddingBottom: 0, marginBottom: -6 } }, 'Tok'))),
  h('div', { style: { display: 'flex', flexDirection: 'column' } },
    h('div', {
      style: {
        display: 'flex', alignItems: 'center', fontFamily: 'IBM Plex Mono', fontSize: 18,
        letterSpacing: 3, textTransform: 'uppercase', color: INK_SECONDARY, marginBottom: 16,
      },
    }, h('div', { style: { width: 34, height: 2, background: INK, marginRight: 12 } }), card.kicker),
    h('div', {
      style: {
        display: 'flex', fontFamily: 'Newsreader Display', fontSize: nameSize(card.name),
        lineHeight: 1.04, letterSpacing: -1,
      },
    }, card.name),
    card.subtitle
      ? h('div', { style: { display: 'flex', fontSize: 28, marginTop: 18, color: INK } }, card.subtitle)
      : null,
    card.facts.length
      ? h('div', {
        style: {
          display: 'flex', fontFamily: 'IBM Plex Mono', fontSize: 18, letterSpacing: 2,
          textTransform: 'uppercase', color: INK_SECONDARY, marginTop: 22,
        },
      }, card.facts.join('  ·  '))
      : null),
  h('div', {
    style: { display: 'flex', fontFamily: 'IBM Plex Mono', fontSize: 15, letterSpacing: 2.5, textTransform: 'uppercase', color: INK_SECONDARY },
  }, 'papertok.app')));
}

// Print grain under a paper's card: faint warm noise, one tile repeated so the
// PNG stays near 200 KB (noise does not compress; a repeat within a row does).
const GRAIN_TILE = 48;
const GRAIN = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_CARD_WIDTH}" height="${SHARE_CARD_HEIGHT}">`
  + '<filter id="g" x="0" y="0" width="100%" height="100%">'
  + '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>'
  + '<feColorMatrix values="0 0 0 0 0.42 0 0 0 0 0.34 0 0 0 0 0.2 0 0 0 0.42 -0.18"/></filter>'
  + `<pattern id="p" width="${GRAIN_TILE}" height="${GRAIN_TILE}" patternUnits="userSpaceOnUse">`
  + `<rect width="${GRAIN_TILE}" height="${GRAIN_TILE}" filter="url(#g)"/></pattern>`
  + '<rect width="100%" height="100%" fill="url(#p)"/></svg>')}`;

function titleSize(title: string) {
  if (title.length <= 60) return 68;
  if (title.length <= 100) return 58;
  if (title.length <= 150) return 50;
  return 44;
}

/** A paper's card as a satori tree. The stars keep to the right margin, clear of the text. */
export function paperCardTree(card: PaperShareCard): CardNode {
  const mono = { fontFamily: 'IBM Plex Mono', letterSpacing: 2.5, textTransform: 'uppercase', color: INK_SECONDARY };
  return h('div', {
    style: {
      display: 'flex', position: 'relative', width: SHARE_CARD_WIDTH, height: SHARE_CARD_HEIGHT,
      background: PAPER, color: INK, fontFamily: 'Newsreader Text',
    },
  },
  h('img', { src: GRAIN, width: SHARE_CARD_WIDTH, height: SHARE_CARD_HEIGHT, style: { position: 'absolute', left: 0, top: 0 } }),
  h('div', { style: { position: 'absolute', left: 22, top: 22, right: 22, bottom: 22, border: `2px solid ${INK}`, borderRadius: 6 } }),
  star(1104, 64, 28, true),
  star(1062, 52, 12, false),
  star(1134, 224, 12, false),
  star(1116, 384, 22, true),
  star(1140, 470, 12, false),
  h('div', {
    style: {
      position: 'absolute', left: 84, top: 72, bottom: 58, width: 960,
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    },
  },
  h('div', { style: { display: 'flex', flexDirection: 'column' } },
    h('div', { style: { ...mono, display: 'flex', alignItems: 'center', fontSize: 18, letterSpacing: 3 } },
      h('div', { style: { width: 34, height: 2, background: INK, marginRight: 12 } }), card.venue || 'Paper'),
    h('div', {
      style: {
        display: 'block', marginTop: 22, fontFamily: 'Newsreader Display', fontSize: titleSize(card.title),
        lineHeight: 1.06, letterSpacing: -1, lineClamp: 4,
      },
    }, card.title)),
  h('div', { style: { display: 'flex', flexDirection: 'column' } },
    card.authors
      ? h('div', { style: { display: 'block', fontSize: 28, color: INK_SECONDARY, lineClamp: 1 } }, card.authors)
      : null,
    h('div', {
      style: { ...mono, display: 'flex', fontSize: 15, marginTop: 24, paddingTop: 20, borderTop: `1.5px solid ${INK_SECONDARY}` },
    }, 'papertok.app')),
  ));
}
