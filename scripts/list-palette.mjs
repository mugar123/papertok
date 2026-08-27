/**
 * Regenerates the `--list-*` tokens in `src/styles/variables.css`.
 *
 * The palette is not a set of colours somebody liked; it is the output of three
 * constraints, and the point of keeping the generator is that the constraints
 * stay checkable when someone wants a ninth colour or a different hue offset.
 *
 *   1. One lightness for the whole family. L = 0.52 in oklch, which is where
 *      the twelve `--gradient-*` field inks already average (0.510). A shared
 *      lightness is the single thing that makes a hue circle read as one
 *      family rather than eight unrelated colours.
 *   2. As much chroma as sRGB will give at that lightness, capped at 0.16.
 *      The cap is a judgement: without it indigo, violet and crimson reach far
 *      enough to out-shout the field inks, which are the colours that carry
 *      actual meaning. Teal and blue never reach the cap — at a useful
 *      lightness sRGB holds less chroma in the cyans than in the purples, and
 *      that is a property of the gamut, not something to tune away.
 *   3. At least 4.5:1 against white. The list colour is only ever a rule, an
 *      icon or a swatch, so 3:1 would be the applicable bar; 4.5:1 is held
 *      anyway so the colour can be used as a label later without a rethink.
 *
 * Run with `node scripts/list-palette.mjs`. It prints the CSS block and the
 * measurements; it does not write the file, because the block in
 * `variables.css` carries a comment worth more than the automation.
 */

const L = 0.52;
const CHROMA_CEILING = 0.16;
const HUE_START = 50;
const HUE_STEP = 45;
const MIN_CONTRAST = 4.5;

const NAMES = ['ochre', 'olive', 'green', 'teal', 'blue', 'indigo', 'violet', 'crimson'];

/** oklch → linear sRGB, via oklab. Coefficients are Björn Ottosson's. */
function oklchToLinearSrgb(lightness, chroma, hueDeg) {
  const hue = (hueDeg * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

const inGamut = (rgb) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

const encode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

const toHex = (rgb) =>
  `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, encode(c))) * 255).toString(16).padStart(2, '0')).join('')}`;

/** WCAG relative luminance takes the *linear* channels, so no decoding here. */
const contrastVsWhite = (rgb) => {
  const [r, g, b] = rgb.map((c) => Math.min(1, Math.max(0, c)));
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
};

/** The gamut boundary has no closed form worth writing; bisection finds it. */
function maxChroma(lightness, hueDeg) {
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToLinearSrgb(lightness, mid, hueDeg))) lo = mid;
    else hi = mid;
  }
  // Back off the boundary so rounding to 8-bit cannot land outside it.
  return lo * 0.92;
}

const swatches = NAMES.map((name, index) => {
  const hue = (HUE_START + HUE_STEP * index) % 360;
  const chroma = Math.min(maxChroma(L, hue), CHROMA_CEILING);
  const rgb = oklchToLinearSrgb(L, chroma, hue);
  return { name, hue, chroma, hex: toHex(rgb), contrast: contrastVsWhite(rgb) };
});

const failures = swatches.filter((s) => s.contrast < MIN_CONTRAST);
if (failures.length) {
  console.error(`below ${MIN_CONTRAST}:1 against white: ${failures.map((s) => s.name).join(', ')}`);
  process.exitCode = 1;
}

console.log(swatches.map((s) => `  --list-${s.name}: ${s.hex};`).join('\n'));
console.log();
for (const s of swatches) {
  console.log(
    `  ${s.name.padEnd(8)} H=${String(s.hue).padStart(3)}  C=${s.chroma.toFixed(3)}  ` +
      `${s.hex}  ${s.contrast.toFixed(2)}:1`,
  );
}
const contrasts = swatches.map((s) => s.contrast);
console.log(`\n  contrast ${Math.min(...contrasts).toFixed(2)}:1 – ${Math.max(...contrasts).toFixed(2)}:1`);
