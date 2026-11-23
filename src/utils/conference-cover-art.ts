import type { ConferenceField } from '../data/conferences.ts';

/** The cover art's drawing space, the same for every field. */
export const COVER_ART_VIEW_BOX = '0 0 140 100';

/** SVG paths: `ground` is the field's lattice, `figure` the drawing over it. */
type CoverArt = { ground: string; figure: string };

type Random = () => number;

/** FNV-1a into mulberry32: the same series always draws the same cover. */
function seededRandom(seed: string): Random {
  let state = 0x811c9dc5;
  for (const character of seed) state = Math.imul(state ^ character.codePointAt(0)!, 0x01000193);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x100000000;
  };
}

function between(random: Random, low: number, high: number) {
  return Math.round(low + random() * (high - low));
}

function range(count: number) {
  return Array.from({ length: count }, (_, index) => index);
}

function polyline(points: readonly (readonly [number, number])[]) {
  return 'M' + points.map(([x, y]) => `${Math.round(x)} ${Math.round(y)}`).join('L');
}

function circle(x: number, y: number, radius: number) {
  return `M${x - radius} ${y}a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0`;
}

function lines(step: number, { horizontal = true, vertical = true } = {}) {
  const rows = horizontal ? range(Math.floor(100 / step)).map(index => `M0 ${(index + 1) * step}H140`) : [];
  const columns = vertical ? range(Math.floor(140 / step)).map(index => `M${(index + 1) * step} 0V100`) : [];
  return [...rows, ...columns].join('');
}

const drawings: Record<ConferenceField, (random: Random) => CoverArt> = {
  // Circuit traces: each turns once and ends on a pad.
  cs: (random) => {
    const traces = range(6).map((index) => {
      const y = 10 + index * 15;
      const turn = between(random, 24, 72);
      const drop = random() < 0.5 ? -15 : 15;
      const end = between(random, 100, 132);
      return polyline([[0, y], [turn, y], [turn + 15, y + drop], [end - 4, y + drop]]) + circle(end, y + drop, 4);
    });
    return { ground: lines(20, { horizontal: false }), figure: traces.join('') };
  },
  // Orbits around one centre.
  physics: (random) => {
    const tilt = between(random, 0, 60);
    const orbits = range(between(random, 3, 5)).map((index, _, all) => {
      const angle = tilt + index * (180 / all.length);
      const radians = angle * Math.PI / 180;
      const dx = Math.round(560 * Math.cos(radians)) / 10;
      const dy = Math.round(560 * Math.sin(radians)) / 10;
      return `M${80 - dx} ${50 - dy}A56 22 ${Math.round(angle)} 1 0 ${80 + dx} ${50 + dy}A56 22 ${Math.round(angle)} 1 0 ${80 - dx} ${50 - dy}`;
    });
    return { ground: circle(80, 50, 40) + circle(80, 50, 64), figure: orbits.join('') + circle(80, 50, 5) };
  },
  // A triangle and its altitude on squared paper.
  math: (random) => {
    const base = between(random, 78, 90);
    const apex = between(random, 48, 104);
    const height = between(random, 8, 24);
    const right = between(random, 122, 136);
    return {
      ground: lines(18),
      figure: `${polyline([[14, base], [apex, height], [right, base]])}ZM${apex} ${height}V${base}${circle(apex, base - 22, between(random, 10, 18))}`,
    };
  },
  // A histogram under its bell curve.
  statistics: (random) => {
    const mean = between(random, 62, 92);
    const spread = between(random, 18, 28);
    const height = (x: number) => 76 * Math.exp(-(((x - mean) / spread) ** 2) / 2);
    const bars = range(12).map((index) => {
      const x = 6 + index * 11;
      const top = Math.round(92 - height(x + 5) * (0.75 + random() * 0.3));
      return `M${x} 92V${top}H${x + 9}V92`;
    });
    return {
      ground: bars.join(''),
      figure: `M0 92H140${polyline(range(36).map(index => [index * 4, 90 - height(index * 4)]))}`,
    };
  },
  // Two price series.
  economics: (random) => {
    const walk = (start: number) => {
      let y = start;
      return range(9).map((index): [number, number] => {
        y = Math.min(90, Math.max(8, y - 7 + between(random, -15, 13)));
        return [6 + index * 16, y];
      });
    };
    return { ground: lines(16, { vertical: false }), figure: `M6 4V94H140${polyline(walk(74))}${polyline(walk(94))}` };
  },
  // A truss bridge.
  engineering: (random) => {
    const panels = between(random, 5, 8);
    const width = 140 / panels;
    const deck = between(random, 70, 82);
    const rise = between(random, 34, 50);
    const top = (index: number) => deck - rise * Math.sin(Math.PI * index / panels);
    const posts = range(panels + 1).map(index => polyline([[index * width, deck], [index * width, top(index)]]));
    const braces = range(panels).map(index => polyline(index < panels / 2
      ? [[index * width, top(index)], [(index + 1) * width, deck]]
      : [[index * width, deck], [(index + 1) * width, top(index + 1)]]));
    return {
      ground: lines(14, { vertical: false }),
      figure: `M0 ${deck}H140${polyline(range(panels + 1).map(index => [index * width, top(index)]))}${posts.join('')}${braces.join('')}`,
    };
  },
  // A pulse across a target.
  medicine: (random) => {
    const x = between(random, 52, 84);
    const peak = between(random, 4, 22);
    const dip = between(random, 76, 96);
    return {
      ground: circle(x + 8, 50, 22) + circle(x + 8, 50, 34) + circle(x + 8, 50, 46),
      figure: polyline([[0, 54], [x - 30, 54], [x - 20, between(random, 34, 46)], [x - 8, dip], [x + 8, peak], [x + 22, between(random, 62, 74)], [x + 30, 54], [140, 54]]),
    };
  },
  // A double helix.
  biology: (random) => {
    const phase = random() * Math.PI * 2;
    const turn = between(random, 24, 32);
    const strand = (x: number, side: number) => 50 + side * 36 * Math.sin(x / turn * Math.PI + phase);
    const points = range(48).map(index => index * 3);
    const rungs = range(14).map(index => 5 + index * 10);
    return {
      ground: rungs.map(x => polyline([[x, strand(x, 1)], [x, strand(x, -1)]])).join(''),
      figure: polyline(points.map(x => [x, strand(x, 1)])) + polyline(points.map(x => [x, strand(x, -1)])),
    };
  },
  // Rings of a hexagonal lattice, some with a double bond.
  chemistry: (random) => {
    const hexagon = (x: number, y: number, radius: number) => polyline(range(6).map((corner): [number, number] => {
      const angle = Math.PI / 6 + corner * Math.PI / 3;
      return [x + radius * Math.cos(angle), y + radius * Math.sin(angle)];
    })) + 'Z';
    const cells = range(4).flatMap(row => range(5).map((column): [number, number] => [column * 33 + (row % 2) * 16.5, 8 + row * 28.5]));
    const first = between(random, 0, cells.length - 1);
    const chosen = cells.filter((_, index) => index === first || random() < 0.4);
    return {
      ground: cells.map(([x, y]) => hexagon(x, y, 19)).join(''),
      figure: chosen.map(([x, y]) => hexagon(x, y, 19) + hexagon(x, y, 13)).join(''),
    };
  },
};

export function coverArt(field: ConferenceField, series: string): CoverArt {
  return drawings[field](seededRandom(series));
}
