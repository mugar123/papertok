/**
 * PaperTok — the category taxonomy as the interface uses it: every area of
 * `categoryTaxonomy.ts` with its icon attached.
 *
 * The records and the lookups live in `categoryTaxonomy.ts`, which imports
 * nothing, so the Worker can resolve a paper's field without pulling React and
 * the icon set into its bundle. Everything the interface imported from here
 * still comes from here.
 */

import {
  Atom,
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
import { CATEGORIES as AREAS } from './categoryTaxonomy.ts';

const AREA_ICONS = {
  physics: Atom,
  cs: Monitor,
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
  getAreaKeyFromTopicName,
  getCategoryArea,
  getCategoryLabel,
  getCategorySimilarity,
} from './categoryTaxonomy.ts';

export default CATEGORIES;
