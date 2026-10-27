/**
 * PaperTok — arXiv Category Taxonomy
 * Complete mapping of scientific areas to arXiv categories.
 *
 * Plain data and plain lookups, and nothing imported: the Worker reads this
 * file too (the email digest names the known fields), and a Worker
 * has no use for React. The interface imports `categories.ts`, which attaches
 * each area's icon to these same records.
 */

export interface CategoryArea {
  label: string; gradient: string; description: string;
  subcategories: Record<string, { label: string }>;
}

export const CATEGORIES: Record<string, CategoryArea> = {
  physics: {
    label: 'Physics',
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
    gradient: 'var(--gradient-cs)',
    description: 'Algorithms, systems, security, and more',
    subcategories: {
      'cs.RO': { label: 'Robotics' },
      'cs.CR': { label: 'Cryptography and Security' },
      'cs.SE': { label: 'Software Engineering' },
      'cs.DS': { label: 'Data Structures and Algorithms' },
      'cs.DB': { label: 'Databases' },
      'cs.DC': { label: 'Distributed Computing' },
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
  // arXiv files these under Computer Science, and their ids stay arXiv's: the
  // area groups them, it does not reclassify a paper. An unlisted `cs.*`
  // category still takes Computer Science from its archive.
  ai: {
    label: 'Artificial Intelligence',
    gradient: 'var(--gradient-ai)',
    description: 'Machine learning, language, and vision',
    subcategories: {
      'cs.AI': { label: 'Artificial Intelligence' },
      'cs.LG': { label: 'Machine Learning' },
      'cs.CV': { label: 'Computer Vision' },
      'cs.CL': { label: 'Computation and Language' },
      'cs.NE': { label: 'Neural and Evolutionary Computing' },
    },
  },
  math: {
    label: 'Mathematics',
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
      'q-fin.GN': { label: 'General Finance' },
    },
  },
  eess: {
    label: 'Electrical & Electronic Engineering',
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
  chem: {
    label: 'Chemistry',
    gradient: 'var(--gradient-chem)',
    description: 'Molecules, reactions, and spectroscopy',
    subcategories: {
      'chem.anal': { label: 'Analytical Chemistry' },
      'chem.electro': { label: 'Electrochemistry' },
      'chem.inorg': { label: 'Inorganic Chemistry' },
      'chem.org': { label: 'Organic Chemistry' },
      'chem.phys': { label: 'Physical & Theoretical Chemistry' },
      'chem.spectro': { label: 'Spectroscopy' },
    },
  },
};

/*
 * arXiv's archives, the part of a category id before the dot, and the area
 * each belongs to. A category the areas above do not list takes the area of
 * its archive, for its chip here and for its ink in `area-accent.ts`. An alias
 * takes the archive it is written under: `q-fin.EC` is Quantitative Finance,
 * although arXiv also files it as `econ.GN`.
 */
const ARXIV_ARCHIVE_AREAS = new Map([
  ['astro-ph', 'physics'], ['cond-mat', 'physics'], ['gr-qc', 'physics'],
  ['hep-ex', 'physics'], ['hep-lat', 'physics'], ['hep-ph', 'physics'], ['hep-th', 'physics'],
  ['math-ph', 'physics'], ['nlin', 'physics'], ['nucl-ex', 'physics'], ['nucl-th', 'physics'],
  ['physics', 'physics'], ['quant-ph', 'physics'],
  ['cs', 'cs'], ['econ', 'econ'], ['eess', 'eess'], ['math', 'math'],
  ['q-bio', 'bio'], ['q-fin', 'q-fin'], ['stat', 'stat'],
]);

/** The area of an arXiv category's archive, or null when it names no arXiv archive. */
export function getArxivArchiveArea(categoryId = '') {
  return ARXIV_ARCHIVE_AREAS.get(categoryId.split('.')[0]) ?? null;
}

// Display names for arXiv categories outside the selectable feed leaves.
// Source: https://arxiv.org/category_taxonomy (2026-10-26).
const ARXIV_DISPLAY_LABELS: Record<string, string> = {
  'cs.AR': 'Hardware Architecture',
  'cs.CC': 'Computational Complexity',
  'cs.CE': 'Computational Engineering, Finance, and Science',
  'cs.CG': 'Computational Geometry',
  'cs.CY': 'Computers and Society',
  'cs.DL': 'Digital Libraries',
  'cs.DM': 'Discrete Mathematics',
  'cs.ET': 'Emerging Technologies',
  'cs.FL': 'Formal Languages and Automata Theory',
  'cs.GL': 'General Literature',
  'cs.IT': 'Information Theory',
  'cs.LO': 'Logic in Computer Science',
  'cs.MA': 'Multiagent Systems',
  'cs.MS': 'Mathematical Software',
  'cs.NA': 'Numerical Analysis',
  'cs.OH': 'Other Computer Science',
  'cs.OS': 'Operating Systems',
  'cs.PF': 'Performance',
  'cs.SC': 'Symbolic Computation',
  'eess.AS': 'Audio and Speech Processing',
  'math.AC': 'Commutative Algebra',
  'math.AT': 'Algebraic Topology',
  'math.CT': 'Category Theory',
  'math.CV': 'Complex Variables',
  'math.GM': 'General Mathematics',
  'math.GN': 'General Topology',
  'math.HO': 'History and Overview',
  'math.IT': 'Information Theory',
  'math.KT': 'K-Theory and Homology',
  'math.MG': 'Metric Geometry',
  'math.OA': 'Operator Algebras',
  'math.QA': 'Quantum Algebra',
  'math.RT': 'Representation Theory',
  'math.SG': 'Symplectic Geometry',
  'math.SP': 'Spectral Theory',
  'astro-ph.IM': 'Instrumentation and Methods for Astrophysics',
  'cond-mat.dis-nn': 'Disordered Systems and Neural Networks',
  'cond-mat.other': 'Other Condensed Matter',
  'hep-lat': 'High Energy Physics - Lattice',
  'nlin.AO': 'Adaptation and Self-Organizing Systems',
  'nlin.CD': 'Chaotic Dynamics',
  'nlin.CG': 'Cellular Automata and Lattice Gases',
  'nlin.PS': 'Pattern Formation and Solitons',
  'nlin.SI': 'Exactly Solvable and Integrable Systems',
  'physics.acc-ph': 'Accelerator Physics',
  'physics.ao-ph': 'Atmospheric and Oceanic Physics',
  'physics.app-ph': 'Applied Physics',
  'physics.atm-clus': 'Atomic and Molecular Clusters',
  'physics.chem-ph': 'Chemical Physics',
  'physics.class-ph': 'Classical Physics',
  'physics.data-an': 'Data Analysis, Statistics and Probability',
  'physics.ed-ph': 'Physics Education',
  'physics.gen-ph': 'General Physics',
  'physics.geo-ph': 'Geophysics',
  'physics.hist-ph': 'History and Philosophy of Physics',
  'physics.ins-det': 'Instrumentation and Detectors',
  'physics.med-ph': 'Medical Physics',
  'physics.pop-ph': 'Popular Physics',
  'physics.soc-ph': 'Physics and Society',
  'physics.space-ph': 'Space Physics',
  'q-bio.BM': 'Biomolecules',
  'q-bio.CB': 'Cell Behavior',
  'q-bio.GN': 'Genomics',
  'q-bio.MN': 'Molecular Networks',
  'q-bio.NC': 'Neurons and Cognition',
  'q-bio.OT': 'Other Quantitative Biology',
  'q-bio.PE': 'Populations and Evolution',
  'q-bio.QM': 'Quantitative Methods',
  'q-bio.SC': 'Subcellular Processes',
  'q-bio.TO': 'Tissues and Organs',
  'q-fin.EC': 'Economics',
  'stat.OT': 'Other Statistics',
};

/**
 * Get the human-readable label for a given arXiv category.
 */
export function getCategoryLabel(arxivCategory: string) {
  if (Object.hasOwn(ARXIV_DISPLAY_LABELS, arxivCategory)) return ARXIV_DISPLAY_LABELS[arxivCategory];
  // Own keys only: a stored category named `constructor` or `toString` is
  // unknown, not a member inherited from Object.prototype.
  if (Object.hasOwn(CATEGORIES, arxivCategory)) {
    const area = CATEGORIES[arxivCategory];
    return area.label || area.label;
  }
  for (const area of Object.values(CATEGORIES)) {
    if (Object.hasOwn(area.subcategories, arxivCategory)) {
      const category = area.subcategories[arxivCategory];
      return category.label || category.label;
    }
  }
  const fallbackArea = CATEGORIES[getArxivArchiveArea(arxivCategory) as string];
  if (fallbackArea) {
    return fallbackArea.label || fallbackArea.label;
  }
  return arxivCategory;
}

/**
 * The leaves an area has now, or null when the id names no area. A followed
 * area reads them here rather than from the ids it stored when it was
 * followed, which are the area as it was then.
 */
export function getAreaLeaves(id: unknown) {
  return typeof id === 'string' && Object.hasOwn(CATEGORIES, id) ? Object.keys(CATEGORIES[id].subcategories) : null;
}

/**
 * Get the area key for a given arXiv category.
 */
export function getCategoryArea(arxivCategory: string) {
  for (const [areaKey, area] of Object.entries(CATEGORIES)) {
    if (Object.hasOwn(area.subcategories, arxivCategory)) {
      return areaKey;
    }
  }
  return null;
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
