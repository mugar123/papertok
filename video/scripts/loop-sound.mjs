// Writes the loop's sound track to public/audio/papertok-loop.wav.
// Run through `npm run loop:sound` (needs --experimental-strip-types).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeWav, renderLoopAudio } from "../src/loop/sound.ts";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "audio", "papertok-loop.wav");
const { left, right } = renderLoopAudio();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodeWav(left, right));
console.log(`${out} (${(left.length / 48000).toFixed(2)} s)`);
