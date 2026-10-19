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
import { CATEGORIES as AREAS } from './categoryTaxonomy.ts';

const AREA_ICONS: Record<string, typeof Atom> = {
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

const AI_TOPICS = new Set(['cs.AI', 'cs.LG', 'cs.CL', 'cs.CV', 'cs.NE']);

function csTopics(inAi: boolean) {
  return Object.fromEntries(
    Object.entries(AREAS.cs.subcategories).filter(([id]) => AI_TOPICS.has(id) === inAi),
  );
}

/**
 * The areas a reader picks interests from: the taxonomy's areas, with the AI
 * topics of Computer Science offered as an area of their own. The topics keep
 * their arXiv ids and stay Computer Science in the taxonomy, so a saved
 * `cs.AI` is the same preference wherever it was picked.
 */
export const INTEREST_AREAS = Object.fromEntries(
  Object.entries(CATEGORIES).flatMap(([key, area]) => (key === 'cs'
    ? [
      [key, { ...area, description: 'Algorithms, systems, security, and more', subcategories: csTopics(false) }],
      ['ai', {
        ...area,
        label: 'Artificial Intelligence',
        description: 'Machine learning, language, and vision',
        icon: Brain,
        subcategories: csTopics(true),
      }],
    ]
    : [[key, area]])),
);

export {
  getAllLeafCategories,
  getAreaKeyFromTopicName,
  getCategoryArea,
  getCategoryLabel,
  getCategorySimilarity,
} from './categoryTaxonomy.ts';

export default CATEGORIES;
