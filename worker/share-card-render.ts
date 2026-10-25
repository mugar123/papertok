import type { ShareCard } from './share-card.ts';

// Each import below is a module wrangler bundles (`[[rules]]` in wrangler.toml):
// a Worker may not compile WebAssembly from bytes at run time, so the two
// engines travel compiled, and the fonts and etchings travel as data.
//
// satori is pinned at 0.32.0. From 0.33 it shapes text with harfbuzzjs, which
// reads `import.meta.url`, and in workerd the first card failed with
// "Cannot read properties of undefined (reading 'href')" (2026-10-25). A card
// that fails falls back to the static image, so an upgrade breaks quietly:
// check one with `wrangler dev` before raising it.
import satori, { init as initLayout } from 'satori/standalone';
import { Resvg, initWasm as initRasterizer } from '@resvg/resvg-wasm';
import layoutWasm from 'satori/yoga.wasm';
import rasterizerWasm from '@resvg/resvg-wasm/index_bg.wasm';
import newsreaderDisplay from './share-card-assets/newsreader-display-400.ttf';
import newsreaderText from './share-card-assets/newsreader-text-400.ttf';
import interWordmark from './share-card-assets/inter-700-wordmark.ttf';
import plexMono from './share-card-assets/ibm-plex-mono-600.ttf';
import microscope from './share-card-assets/microscope.png';
import scrolls from './share-card-assets/scrolls.png';
import lab from './share-card-assets/lab.png';

import { SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT, shareCardTree } from './share-card.ts';

const FONTS = [
  { name: 'Newsreader Display', data: newsreaderDisplay, weight: 400 as const, style: 'normal' as const },
  { name: 'Newsreader Text', data: newsreaderText, weight: 400 as const, style: 'normal' as const },
  { name: 'Inter', data: interWordmark, weight: 700 as const, style: 'normal' as const },
  { name: 'IBM Plex Mono', data: plexMono, weight: 600 as const, style: 'normal' as const },
];

function pngDataUrl(data: ArrayBuffer) {
  const bytes = new Uint8Array(data);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

let ready: Promise<unknown> | null = null;
let art: Record<'microscope' | 'scrolls' | 'lab', string> | null = null;

/** The card as a PNG, `photo` its picture as a data URL or null. */
export async function renderShareCard(card: ShareCard, photo: string | null) {
  // Once per isolate. Neither engine can be started a second time (resvg
  // refuses, satori keeps its first answer), so an isolate whose start failed
  // draws no card until it is replaced; each card it is asked for falls back
  // to the static image, which share-image.ts keeps five minutes.
  ready ??= Promise.all([initLayout(layoutWasm), initRasterizer(rasterizerWasm)]);
  await ready;
  art ??= { microscope: pngDataUrl(microscope), scrolls: pngDataUrl(scrolls), lab: pngDataUrl(lab) };
  // satori's element type is React's; the tree is the plain object React builds.
  const tree = shareCardTree(card, { art, photo }) as Parameters<typeof satori>[0];
  const svg = await satori(tree, { width: SHARE_CARD_WIDTH, height: SHARE_CARD_HEIGHT, fonts: FONTS });
  // Their memory is WebAssembly's, returned only when freed.
  const rasterizer = new Resvg(svg, { fitTo: { mode: 'width', value: SHARE_CARD_WIDTH } });
  try {
    const image = rasterizer.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    rasterizer.free();
  }
}
