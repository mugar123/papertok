/**
 * PaperTok — the category taxonomy as the interface uses it: every area of
 * `category-taxonomy.ts` with its icon attached.
 *
 * The records and the lookups live in `category-taxonomy.ts`, which imports
 * nothing, so the Worker can resolve a paper's field without pulling React and
 * the icon set into its bundle. Everything the interface imported from here
 * still comes from here.
 */

import {
  Atom,
  Brain,
  Building,
  Calculator,
  ChartBar,
  CurrencyCircleDollar,
  Dna,
  Flask,
  Gear,
  Heartbeat,
  Lightning,
  Monitor,
  TrendUp,
} from '@phosphor-icons/react';
import { CATEGORIES as AREAS } from './category-taxonomy.ts';

const AREA_ICONS: Record<string, typeof Atom> = {
  physics: Atom,
  cs: Monitor,
  ai: Brain,
  math: Calculator,
  stat: ChartBar,
  econ: TrendUp,
  'q-fin': CurrencyCircleDollar,
  eess: Lightning,
  mech: Gear,
  civil: Building,
  chemeng: Flask,
  med: Heartbeat,
  bio: Dna,
};

export const CATEGORIES = Object.fromEntries(
  Object.entries(AREAS).map(([key, area]) => [key, { ...area, icon: AREA_ICONS[key] }]),
);

export {
  getAllLeafCategories,
  getAreaLeaves,
  getCategoryArea,
  getCategoryLabel,
} from './category-taxonomy.ts';

