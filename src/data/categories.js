/**
 * PaperTok — arXiv Category Taxonomy
 * Complete mapping of scientific areas to arXiv categories.
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

export const CATEGORIES = {
  physics: {
    label: 'Physics',
    icon: Atom,
    gradient: 'var(--gradient-physics)',
    description: 'From subatomic particles to distant galaxies',
    subcategories: {
      'quant-ph': { label: 'Quantum Physics' },
      'cond-mat.supr-con': { label: 'Superconductivity' },
      'cond-mat.str-el': { label: 'Strongly Correlated Electrons' },
      'cond-mat.mtrl-sci': { label: 'Materials Science' },
      'cond-mat.mes-hall': { label: 'Mesoscale and Nanoscale Physics' },
      'cond-mat.stat-mech': { label: 'Statistical Mechanics' },
      'cond-mat.soft': { label: 'Soft Condensed Matter' },
      'cond-mat.quant-gas': { label: 'Quantum Gases' },
      'hep-th': { label: 'High Energy Physics - Theory' },
      'hep-ph': { label: 'High Energy Physics - Phenomenology' },
      'hep-ex': { label: 'High Energy Physics - Experiment' },
      'astro-ph.CO': { label: 'Cosmology' },
      'astro-ph.GA': { label: 'Astrophysics of Galaxies' },
      'astro-ph.SR': { label: 'Solar and Stellar Astrophysics' },
      'astro-ph.HE': { label: 'High Energy Astrophysical Phenomena' },
      'astro-ph.EP': { label: 'Earth and Planetary Astrophysics' },
      'gr-qc': { label: 'General Relativity and Quantum Cosmology' },
      'math-ph': { label: 'Mathematical Physics' },
      'nucl-th': { label: 'Nuclear Theory' },
      'nucl-ex': { label: 'Nuclear Experiment' },
      'physics.optics': { label: 'Optics' },
      'physics.atom-ph': { label: 'Atomic Physics' },
      'physics.flu-dyn': { label: 'Fluid Dynamics' },
      'physics.plasm-ph': { label: 'Plasma Physics' },
      'physics.bio-ph': { label: 'Biological Physics' },
      'physics.comp-ph': { label: 'Computational Physics' },
    },
  },
  cs: {
    label: 'Computer Science',
    icon: Monitor,
    gradient: 'var(--gradient-cs)',
    description: 'AI, algorithms, networks, and more',
    subcategories: {
      'cs.AI': { label: 'Artificial Intelligence' },
      'cs.LG': { label: 'Machine Learning' },
      'cs.CV': { label: 'Computer Vision' },
      'cs.CL': { label: 'Computation and Language' },
      'cs.RO': { label: 'Robotics' },
      'cs.CR': { label: 'Cryptography and Security' },
      'cs.SE': { label: 'Software Engineering' },
      'cs.DS': { label: 'Data Structures and Algorithms' },
      'cs.DB': { label: 'Databases' },
      'cs.DC': { label: 'Distributed Computing' },
      'cs.NE': { label: 'Neural and Evolutionary Computing' },
      'cs.IR': { label: 'Information Retrieval' },
      'cs.HC': { label: 'Human-Computer Interaction' },
      'cs.PL': { label: 'Programming Languages' },
      'cs.GT': { label: 'Computer Science and Game Theory' },
      'cs.SI': { label: 'Social and Information Networks' },
      'cs.NI': { label: 'Networking and Internet Architecture' },
      'cs.GR': { label: 'Graphics' },
      'cs.SD': { label: 'Sound' },
      'cs.MM': { label: 'Multimedia' },
      'cs.SY': { label: 'Systems and Control' },
    },
  },
  math: {
    label: 'Mathematics',
    icon: Calculator,
    gradient: 'var(--gradient-math)',
    description: 'The language of the universe',
    subcategories: {
      'math.AG': { label: 'Algebraic Geometry' },
      'math.AP': { label: 'Analysis of PDEs' },
      'math.CO': { label: 'Combinatorics' },
      'math.NT': { label: 'Number Theory' },
      'math.PR': { label: 'Probability' },
      'math.ST': { label: 'Statistics Theory' },
      'math.DG': { label: 'Differential Geometry' },
      'math.DS': { label: 'Dynamical Systems' },
      'math.FA': { label: 'Functional Analysis' },
      'math.NA': { label: 'Numerical Analysis' },
      'math.OC': { label: 'Optimization and Control' },
      'math.LO': { label: 'Logic' },
      'math.GR': { label: 'Group Theory' },
      'math.GT': { label: 'Geometric Topology' },
      'math.RA': { label: 'Rings and Algebras' },
      'math.CA': { label: 'Classical Analysis and ODEs' },
      'math.MP': { label: 'Mathematical Physics' },
    },
  },
  stat: {
    label: 'Statistics',
    icon: ChartBar,
    gradient: 'var(--gradient-stat)',
    description: 'Machine learning, methodology, and applications',
    subcategories: {
      'stat.ML': { label: 'Machine Learning' },
      'stat.ME': { label: 'Methodology' },
      'stat.AP': { label: 'Applications' },
      'stat.CO': { label: 'Computation' },
      'stat.TH': { label: 'Theory' },
    },
  },
  econ: {
    label: 'Economics',
    icon: TrendUp,
    gradient: 'var(--gradient-econ)',
    description: 'Econometrics and economic theory',
    subcategories: {
      'econ.EM': { label: 'Econometrics' },
      'econ.GN': { label: 'General Economics' },
      'econ.TH': { label: 'Theoretical Economics' },
    },
  },
  'q-fin': {
    label: 'Quantitative Finance',
    icon: CurrencyCircleDollar,
    gradient: 'var(--gradient-qfin)',
    description: 'Algorithmic trading, risk, and portfolios',
    subcategories: {
      'q-fin.ST': { label: 'Statistical Finance' },
      'q-fin.CP': { label: 'Computational Finance' },
      'q-fin.PM': { label: 'Portfolio Management' },
      'q-fin.RM': { label: 'Risk Management' },
      'q-fin.MF': { label: 'Mathematical Finance' },
      'q-fin.PR': { label: 'Pricing of Securities' },
      'q-fin.TR': { label: 'Trading and Market Microstructure' },
    },
  },
  eess: {
    label: 'Electrical & Electronic Engineering',
    icon: Lightning,
    gradient: 'var(--gradient-eess)',
    description: 'Signals, power, telecommunications, and control',
    subcategories: {
      'eess.SP': { label: 'Signal Processing' },
      'eess.IV': { label: 'Image and Video Processing' },
      'eess.SY': { label: 'Systems and Control' },
      'eess.telecom': { label: 'Telecommunications' },
      'eess.electro': { label: 'Electronics & Microelectronics' },
      'eess.power': { label: 'Power Systems' },
      'eess.optics': { label: 'Applied Optics & Photonics' },
    },
  },
  mech: {
    label: 'Mechanical & Aerospace Engineering',
    icon: Gear,
    gradient: 'var(--gradient-mech)',
    description: 'Robotics, thermodynamics, fluids, and manufacturing',
    subcategories: {
      'mech.dyn': { label: 'Dynamics & Robotics' },
      'mech.fluid': { label: 'Fluid Mechanics' },
      'mech.thermo': { label: 'Thermodynamics' },
      'mech.solid': { label: 'Solid Mechanics' },
      'mech.aero': { label: 'Aerospace Engineering' },
      'mech.mfg': { label: 'Manufacturing' },
      'mech.cad': { label: 'CAD & Simulation' },
      'mech.auto': { label: 'Automotive Engineering' },
      'mech.acoustics': { label: 'Acoustics & Vibrations' },
    },
  },
  civil: {
    label: 'Civil & Environmental Engineering',
    icon: Building,
    gradient: 'var(--gradient-civil)',
    description: 'Structures, transport, geotechnics, and urban planning',
    subcategories: {
      'civil.struct': { label: 'Structural Engineering' },
      'civil.geo': { label: 'Geotechnical Engineering' },
      'civil.hydro': { label: 'Hydraulic Engineering' },
      'civil.trans': { label: 'Transportation' },
      'civil.quake': { label: 'Earthquake Engineering' },
      'civil.env': { label: 'Environmental Engineering' },
      'civil.mat': { label: 'Construction Materials' },
      'civil.urban': { label: 'Urban Planning' },
    },
  },
  chemeng: {
    label: 'Chemical & Materials Engineering',
    icon: Flask,
    gradient: 'var(--gradient-chemeng)',
    description: 'Chemical processes, nanotechnology, and materials',
    subcategories: {
      'chemeng.process': { label: 'Chemical Processes & Catalysis' },
      'chemeng.poly': { label: 'Polymer Engineering' },
      'chemeng.nano': { label: 'Nanotechnology' },
      'chemeng.energy': { label: 'Energy & Batteries' },
      'chemeng.bio': { label: 'Bioengineering' },
      'chemeng.metal': { label: 'Metallurgy' },
      'chemeng.ceramics': { label: 'Ceramics & Composites' },
      'chemeng.sep': { label: 'Separation Technologies' },
    },
  },
  med: {
    label: 'Medicine',
    icon: Heartbeat,
    gradient: 'var(--gradient-med)',
    description: 'Clinical research, public health, and specialties',
    subcategories: {
      'med.gen': { label: 'General Medicine' },
      'med.onco': { label: 'Oncology' },
      'med.cardio': { label: 'Cardiology' },
      'med.neuro': { label: 'Clinical Neurology' },
      'med.psych': { label: 'Psychiatry & Mental Health' },
      'med.pubh': { label: 'Public Health & Epidemiology' },
      'med.pharma': { label: 'Pharmacology' },
      'med.tox': { label: 'Toxicology' },
      'med.peds': { label: 'Pediatrics' },
      'med.surg': { label: 'Surgery' },
      'med.immuno': { label: 'Clinical Immunology' },
      'med.endo': { label: 'Endocrinology' },
      'med.path': { label: 'Pathology' },
      'med.radio': { label: 'Radiology & Imaging' },
      'med.infect': { label: 'Infectious Diseases' },
      'med.derma': { label: 'Dermatology' },
    },
  },
  bio: {
    label: 'Biology',
    icon: Dna,
    gradient: 'var(--gradient-bio)',
    description: 'From genetics to ecology and microbiology',
    subcategories: {
      'bio.gen': { label: 'Genetics' },
      'bio.mol': { label: 'Molecular Biology' },
      'bio.cell': { label: 'Cell Biology' },
      'bio.neuro': { label: 'Neuroscience' },
      'bio.eco': { label: 'Ecology' },
      'bio.evo': { label: 'Evolution & Population Dynamics' },
      'bio.zoo': { label: 'Zoology' },
      'bio.bot': { label: 'Botany' },
      'bio.micro': { label: 'Microbiology' },
      'bio.immuno': { label: 'Biological Immunology' },
      'bio.comp': { label: 'Bioinformatics' },
      'bio.physio': { label: 'Physiology' },
      'bio.biochem': { label: 'Biochemistry' },
      'bio.marine': { label: 'Marine Biology' },
      'bio.biotech': { label: 'Biotechnology' },
    },
  },
};

function getFallbackAreaKey(categoryId = '') {
  if (categoryId.startsWith('q-fin')) return 'q-fin';
  if (categoryId.startsWith('q-bio')) return 'bio';

  const prefix = categoryId.split('.')[0].split('-')[0];
  return {
    quant: 'physics',
    cond: 'physics',
    hep: 'physics',
    astro: 'physics',
    gr: 'physics',
    math: 'math',
    nucl: 'physics',
    nlin: 'physics',
    physics: 'physics',
    cs: 'cs',
    stat: 'stat',
    econ: 'econ',
    eess: 'eess',
  }[prefix] || null;
}

/**
 * The twelve field inks are keyed to arXiv's category codes, and most of the
 * corpus does not come from arXiv. OpenAlex hands back a topic's display name
 * — "Wastewater Treatment and Reuse", "Neuroscience and Music Perception" —
 * which matches no code, so every one of them fell through to the brand ink and
 * the field accent said the same thing about every paper on the page.
 *
 * This reads the name instead. It is a heuristic and it behaves like one: a
 * topic that matches nothing distinctive keeps the ink rather than being handed
 * a field it may not belong to, because a wrong field colour is worse than no
 * field colour. The keywords are deliberately not prefixes of unrelated common
 * words — "genom" and "genetic" rather than "gene", which would have coloured
 * every paper filed under "General" as biology.
 */
const AREA_TOPIC_KEYWORDS = {
  bio: [
    'transcriptom', 'genom', 'genetic', 'microbi', 'bacteri', 'protein', 'enzyme',
    'cellular', 'cell', 'mitosis', 'microtubule', 'cytoskelet', 'ecolog', 'biodivers',
    'evolutionary', 'plant', 'photosynth', 'biochem', 'metabolit', 'metabolom',
    'organism', 'chromosom', 'molecular biolog',
  ],
  med: [
    'immun', 'interferon', 'neuroscience', 'neurolog', 'cancer', 'tumour', 'tumor',
    'oncolog', 'clinical', 'patient', 'diagnos', 'therapeut', 'therapy', 'disease',
    'epidemiol', 'pharmac', 'vaccine', 'surger', 'cardiovascular', 'mri',
    'physiolog', 'psychiatr', 'nutrition', 'exercise',
  ],
  physics: [
    'physic', 'quantum', 'plasma', 'fusion', 'astronom', 'astrophys', 'cosmolog',
    'galax', 'photon', 'optic', 'superconduct', 'relativity', 'gravitation',
    'condensed matter', 'spectroscop', 'nuclear', 'thermodynam',
  ],
  cs: [
    'comput', 'algorithm', 'software', 'machine learning', 'artificial intelligence',
    'natural language', 'neural network', 'large language model', 'cryptograph',
    'database', 'data management', 'human-computer', 'programming',
  ],
  math: [
    'mathemat', 'algebra', 'geometr', 'topolog', 'number theory', 'combinator',
    'differential equation', 'graph theory', 'manifold',
  ],
  stat: ['statistic', 'bayesian', 'regression', 'stochastic', 'probabilit'],
  econ: [
    'econom', 'labour market', 'labor market', 'monetary', 'inequalit',
    'trade polic', 'financial',
  ],
  eess: [
    'signal processing', 'image processing', 'telecommunicat', 'wireless', 'antenna',
    'circuit', 'power system', 'electrical engineer', 'acoustic', 'speech', 'audio',
    'systems and control', 'control system',
  ],
  mech: [
    'fluid dynamic', 'aerodynam', 'mechanical engineer', 'manufactur', 'vibration',
    'turbine', 'robot', 'combustion',
  ],
  civil: [
    'wastewater', 'water supply', 'water treatment', 'structural engineer',
    'construction', 'concrete', 'geotechn', 'hydraulic', 'seismic', 'urban planning',
    'transportation',
  ],
  chemeng: [
    'chemical engineer', 'catalys', 'polymer', 'electrochem', 'corrosion',
    'distillation', 'membrane', 'nanoparticle',
  ],
};

/**
 * The area a topic's display name belongs to, or '' when nothing distinctive
 * matched.
 *
 * The longest matching keyword wins, so the colour follows the noun rather than
 * the modifier: "Cellular Mechanics" is biology, not mechanical engineering, and
 * "Mathematics, Computing and Information Studies" is mathematics rather than
 * computer science. Matches start on a word boundary, so "General" is not read
 * as a gene.
 */
export function getAreaKeyFromTopicName(value) {
  const text = String(value || '').toLowerCase().trim();
  if (!text) return '';

  let bestKey = '';
  let bestLength = 0;
  for (const [areaKey, keywords] of Object.entries(AREA_TOPIC_KEYWORDS)) {
    for (const keyword of keywords) {
      if (keyword.length <= bestLength) continue;
      if (new RegExp(`\\b${keyword}`).test(text)) {
        bestKey = areaKey;
        bestLength = keyword.length;
      }
    }
  }
  return bestKey;
}

/**
 * Get the gradient CSS variable for a given arXiv category.
 * Maps any category to its parent area gradient.
 */
export function getCategoryGradient(arxivCategory) {
  for (const [areaKey, area] of Object.entries(CATEGORIES)) {
    if (arxivCategory in area.subcategories) {
      return area.gradient;
    }
    // Check if it's a parent-level match (e.g., 'cs' matches 'cs.AI')
    if (arxivCategory.startsWith(areaKey + '.') || arxivCategory.startsWith(areaKey + '-')) {
      return area.gradient;
    }
  }
  // Fallback: try to match by prefix
  const area = CATEGORIES[getFallbackAreaKey(arxivCategory)];
  if (area) return area.gradient;

  // Not an arXiv code at all, which is the common case: read the name.
  const named = CATEGORIES[getAreaKeyFromTopicName(arxivCategory)];
  return named ? named.gradient : 'var(--gradient-brand)';
}

/**
 * Get the human-readable label for a given arXiv category.
 */
export function getCategoryLabel(arxivCategory) {
  if (CATEGORIES[arxivCategory]) {
    const area = CATEGORIES[arxivCategory];
    return area.label || area.label;
  }
  for (const area of Object.values(CATEGORIES)) {
    if (area.subcategories[arxivCategory]) {
      const category = area.subcategories[arxivCategory];
      return category.label || category.label;
    }
  }
  const fallbackArea = CATEGORIES[getFallbackAreaKey(arxivCategory)];
  if (fallbackArea) {
    return fallbackArea.label || fallbackArea.label;
  }
  return arxivCategory;
}

/**
 * Get the area key for a given arXiv category.
 */
export function getCategoryArea(arxivCategory) {
  for (const [areaKey, area] of Object.entries(CATEGORIES)) {
    if (arxivCategory in area.subcategories) {
      return areaKey;
    }
  }
  return null;
}

/**
 * Get all selected arXiv category IDs from a selection object.
 * @param {Object} selection - { areaKey: Set of subcategory IDs }
 * @returns {string[]} Array of arXiv category IDs
 */
export function getSelectedCategoryIds(selection) {
  const ids = [];
  for (const [, subcats] of Object.entries(selection)) {
    if (subcats instanceof Set) {
      for (const id of subcats) {
        ids.push(id);
      }
    } else if (Array.isArray(subcats)) {
      ids.push(...subcats);
    }
  }
  return ids;
}

/**
 * Get a flat list of all leaf category objects with their area context.
 * @returns {Array<{id: string, label: string, area: string, areaLabel: string, gradient: string}>}
 */
export function getAllLeafCategories() {
  const leaves = [];
  for (const [areaKey, area] of Object.entries(CATEGORIES)) {
    for (const [catId, cat] of Object.entries(area.subcategories)) {
      leaves.push({
        id: catId,
        label: cat.label,
        area: areaKey,
        areaLabel: area.label,
        gradient: area.gradient,
      });
    }
  }
  return leaves;
}

/**
 * Calculates conceptual similarity between two categories [0, 1].
 */
export function getCategorySimilarity(catA, catB) {
  if (!catA || !catB) return 0.0;
  if (catA === catB) return 1.0;
  
  const areaA = getCategoryArea(catA);
  const areaB = getCategoryArea(catB);
  
  if (!areaA || !areaB || areaA !== areaB) return 0.0;
  
  const prefixA = catA.split('.')[0];
  const prefixB = catB.split('.')[0];
  
  if (prefixA === prefixB) {
    return 0.8; // High similarity
  }
  
  return 0.4; // Medium similarity
}

export default CATEGORIES;
