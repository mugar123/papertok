/**
 * PaperTok — arXiv Category Taxonomy
 * Complete mapping of scientific areas to arXiv categories.
 */

import { 
  Atom, 
  Monitor, 
  Calculator, 
  Dna, 
  BarChart2, 
  TrendingUp, 
  Zap, 
  CircleDollarSign,
  Settings,
  Building,
  Beaker,
  HeartPulse
} from 'lucide-react';

export const CATEGORIES = {
  physics: {
    label: 'Física',
    labelEn: 'Physics',
    icon: Atom,
    gradient: 'var(--gradient-physics)',
    description: 'De partículas subatómicas a galaxias lejanas',
    subcategories: {
      'quant-ph': { label: 'Física Cuántica', labelEn: 'Quantum Physics' },
      'cond-mat.supr-con': { label: 'Superconductividad', labelEn: 'Superconductivity' },
      'cond-mat.str-el': { label: 'Electrones Correlacionados', labelEn: 'Strongly Correlated Electrons' },
      'cond-mat.mtrl-sci': { label: 'Ciencia de Materiales', labelEn: 'Materials Science' },
      'cond-mat.mes-hall': { label: 'Sistemas Mesoscópicos', labelEn: 'Mesoscale and Nanoscale Physics' },
      'cond-mat.stat-mech': { label: 'Mecánica Estadística', labelEn: 'Statistical Mechanics' },
      'cond-mat.soft': { label: 'Materia Blanda', labelEn: 'Soft Condensed Matter' },
      'cond-mat.quant-gas': { label: 'Gases Cuánticos', labelEn: 'Quantum Gases' },
      'hep-th': { label: 'Altas Energías (Teoría)', labelEn: 'High Energy Physics - Theory' },
      'hep-ph': { label: 'Altas Energías (Fenomenología)', labelEn: 'High Energy Physics - Phenomenology' },
      'hep-ex': { label: 'Altas Energías (Experimental)', labelEn: 'High Energy Physics - Experiment' },
      'astro-ph.CO': { label: 'Cosmología', labelEn: 'Cosmology' },
      'astro-ph.GA': { label: 'Astrofísica Galáctica', labelEn: 'Astrophysics of Galaxies' },
      'astro-ph.SR': { label: 'Física Solar y Estelar', labelEn: 'Solar and Stellar Astrophysics' },
      'astro-ph.HE': { label: 'Fenómenos de Alta Energía', labelEn: 'High Energy Astrophysical Phenomena' },
      'astro-ph.EP': { label: 'Ciencias Planetarias', labelEn: 'Earth and Planetary Astrophysics' },
      'gr-qc': { label: 'Relatividad General', labelEn: 'General Relativity and Quantum Cosmology' },
      'math-ph': { label: 'Física Matemática', labelEn: 'Mathematical Physics' },
      'nucl-th': { label: 'Física Nuclear (Teoría)', labelEn: 'Nuclear Theory' },
      'nucl-ex': { label: 'Física Nuclear (Experimental)', labelEn: 'Nuclear Experiment' },
      'physics.optics': { label: 'Óptica', labelEn: 'Optics' },
      'physics.atom-ph': { label: 'Física Atómica', labelEn: 'Atomic Physics' },
      'physics.flu-dyn': { label: 'Dinámica de Fluidos', labelEn: 'Fluid Dynamics' },
      'physics.plasm-ph': { label: 'Física de Plasmas', labelEn: 'Plasma Physics' },
      'physics.bio-ph': { label: 'Biofísica', labelEn: 'Biological Physics' },
      'physics.comp-ph': { label: 'Física Computacional', labelEn: 'Computational Physics' },
    },
  },
  cs: {
    label: 'Ciencias de la Computación',
    labelEn: 'Computer Science',
    icon: Monitor,
    gradient: 'var(--gradient-cs)',
    description: 'IA, algoritmos, redes y más',
    subcategories: {
      'cs.AI': { label: 'Inteligencia Artificial', labelEn: 'Artificial Intelligence' },
      'cs.LG': { label: 'Machine Learning', labelEn: 'Machine Learning' },
      'cs.CV': { label: 'Visión por Computador', labelEn: 'Computer Vision' },
      'cs.CL': { label: 'Procesamiento del Lenguaje Natural', labelEn: 'Computation and Language' },
      'cs.RO': { label: 'Robótica', labelEn: 'Robotics' },
      'cs.CR': { label: 'Criptografía y Seguridad', labelEn: 'Cryptography and Security' },
      'cs.SE': { label: 'Ingeniería de Software', labelEn: 'Software Engineering' },
      'cs.DS': { label: 'Estructuras de Datos y Algoritmos', labelEn: 'Data Structures and Algorithms' },
      'cs.DB': { label: 'Bases de Datos', labelEn: 'Databases' },
      'cs.DC': { label: 'Computación Distribuida', labelEn: 'Distributed Computing' },
      'cs.NE': { label: 'Computación Neuronal y Evolutiva', labelEn: 'Neural and Evolutionary Computing' },
      'cs.IR': { label: 'Recuperación de Información', labelEn: 'Information Retrieval' },
      'cs.HC': { label: 'Interacción Humano-Computador', labelEn: 'Human-Computer Interaction' },
      'cs.PL': { label: 'Lenguajes de Programación', labelEn: 'Programming Languages' },
      'cs.GT': { label: 'Teoría de Juegos', labelEn: 'Computer Science and Game Theory' },
      'cs.SI': { label: 'Redes Sociales e Información', labelEn: 'Social and Information Networks' },
      'cs.NI': { label: 'Redes y Arquitectura de Internet', labelEn: 'Networking and Internet Architecture' },
      'cs.GR': { label: 'Gráficos', labelEn: 'Graphics' },
      'cs.SD': { label: 'Sonido', labelEn: 'Sound' },
      'cs.MM': { label: 'Multimedia', labelEn: 'Multimedia' },
      'cs.SY': { label: 'Sistemas y Control', labelEn: 'Systems and Control' },
    },
  },
  math: {
    label: 'Matemáticas',
    labelEn: 'Mathematics',
    icon: Calculator,
    gradient: 'var(--gradient-math)',
    description: 'El lenguaje del universo',
    subcategories: {
      'math.AG': { label: 'Geometría Algebraica', labelEn: 'Algebraic Geometry' },
      'math.AP': { label: 'Ecuaciones en Derivadas Parciales', labelEn: 'Analysis of PDEs' },
      'math.CO': { label: 'Combinatoria', labelEn: 'Combinatorics' },
      'math.NT': { label: 'Teoría de Números', labelEn: 'Number Theory' },
      'math.PR': { label: 'Probabilidad', labelEn: 'Probability' },
      'math.ST': { label: 'Estadística Matemática', labelEn: 'Statistics Theory' },
      'math.DG': { label: 'Geometría Diferencial', labelEn: 'Differential Geometry' },
      'math.DS': { label: 'Sistemas Dinámicos', labelEn: 'Dynamical Systems' },
      'math.FA': { label: 'Análisis Funcional', labelEn: 'Functional Analysis' },
      'math.NA': { label: 'Análisis Numérico', labelEn: 'Numerical Analysis' },
      'math.OC': { label: 'Optimización y Control', labelEn: 'Optimization and Control' },
      'math.LO': { label: 'Lógica', labelEn: 'Logic' },
      'math.GR': { label: 'Teoría de Grupos', labelEn: 'Group Theory' },
      'math.GT': { label: 'Topología Geométrica', labelEn: 'Geometric Topology' },
      'math.RA': { label: 'Álgebra', labelEn: 'Rings and Algebras' },
      'math.CA': { label: 'Análisis Clásico y ODEs', labelEn: 'Classical Analysis and ODEs' },
      'math.MP': { label: 'Física Matemática', labelEn: 'Mathematical Physics' },
    },
  },
  stat: {
    label: 'Estadística',
    labelEn: 'Statistics',
    icon: BarChart2,
    gradient: 'var(--gradient-stat)',
    description: 'Machine learning, metodología y aplicaciones',
    subcategories: {
      'stat.ML': { label: 'Machine Learning', labelEn: 'Machine Learning' },
      'stat.ME': { label: 'Metodología', labelEn: 'Methodology' },
      'stat.AP': { label: 'Aplicaciones', labelEn: 'Applications' },
      'stat.CO': { label: 'Computación', labelEn: 'Computation' },
      'stat.TH': { label: 'Teoría', labelEn: 'Theory' },
    },
  },
  econ: {
    label: 'Economía',
    labelEn: 'Economics',
    icon: TrendingUp,
    gradient: 'var(--gradient-econ)',
    description: 'Econometría y teoría económica',
    subcategories: {
      'econ.EM': { label: 'Econometría', labelEn: 'Econometrics' },
      'econ.GN': { label: 'Economía General', labelEn: 'General Economics' },
      'econ.TH': { label: 'Economía Teórica', labelEn: 'Theoretical Economics' },
    },
  },
  'q-fin': {
    label: 'Finanzas Cuantitativas',
    labelEn: 'Quantitative Finance',
    icon: CircleDollarSign,
    gradient: 'var(--gradient-qfin)',
    description: 'Trading algorítmico, riesgo y portfolios',
    subcategories: {
      'q-fin.ST': { label: 'Finanzas Estadísticas', labelEn: 'Statistical Finance' },
      'q-fin.CP': { label: 'Finanzas Computacionales', labelEn: 'Computational Finance' },
      'q-fin.PM': { label: 'Gestión de Portfolios', labelEn: 'Portfolio Management' },
      'q-fin.RM': { label: 'Gestión de Riesgos', labelEn: 'Risk Management' },
      'q-fin.MF': { label: 'Finanzas Matemáticas', labelEn: 'Mathematical Finance' },
      'q-fin.PR': { label: 'Precios de Derivados', labelEn: 'Pricing of Securities' },
      'q-fin.TR': { label: 'Trading', labelEn: 'Trading and Market Microstructure' },
    },
  },
  eess: {
    label: 'Ingeniería Eléctrica y Electrónica',
    labelEn: 'Electrical & Electronic Engineering',
    icon: Zap,
    gradient: 'var(--gradient-eess)',
    description: 'Señales, potencia, telecomunicaciones y control',
    subcategories: {
      'eess.SP': { label: 'Procesamiento de Señales', labelEn: 'Signal Processing' },
      'eess.IV': { label: 'Procesamiento de Imagen y Vídeo', labelEn: 'Image and Video Processing' },
      'eess.SY': { label: 'Sistemas y Control', labelEn: 'Systems and Control' },
      'eess.telecom': { label: 'Telecomunicaciones y Redes', labelEn: 'Telecommunications' },
      'eess.electro': { label: 'Electrónica y Microelectrónica', labelEn: 'Electronics & Microelectronics' },
      'eess.power': { label: 'Sistemas de Potencia y Energía', labelEn: 'Power Systems' },
      'eess.optics': { label: 'Óptica y Fotónica Aplicada', labelEn: 'Applied Optics & Photonics' },
    },
  },
  mech: {
    label: 'Ingeniería Mecánica y Aeroespacial',
    labelEn: 'Mechanical & Aerospace Engineering',
    icon: Settings,
    gradient: 'linear-gradient(135deg, #a18cd1, #fbc2eb)',
    description: 'Robótica, termodinámica, fluidos y manufactura',
    subcategories: {
      'mech.dyn': { label: 'Dinámica, Robótica y Cinemática', labelEn: 'Dynamics & Robotics' },
      'mech.fluid': { label: 'Mecánica de Fluidos y Aerodinámica', labelEn: 'Fluid Mechanics' },
      'mech.thermo': { label: 'Termodinámica y Transferencia de Calor', labelEn: 'Thermodynamics' },
      'mech.solid': { label: 'Mecánica de Sólidos y Estructuras', labelEn: 'Solid Mechanics' },
      'mech.aero': { label: 'Ingeniería Aeroespacial', labelEn: 'Aerospace Engineering' },
      'mech.mfg': { label: 'Manufactura y Mecanizado', labelEn: 'Manufacturing' },
      'mech.cad': { label: 'Diseño Asistido y Simulación', labelEn: 'CAD & Simulation' },
      'mech.auto': { label: 'Ingeniería Automotriz', labelEn: 'Automotive Engineering' },
      'mech.acoustics': { label: 'Acústica y Vibraciones', labelEn: 'Acoustics & Vibrations' },
    },
  },
  civil: {
    label: 'Ingeniería Civil y Ambiental',
    labelEn: 'Civil & Environmental Engineering',
    icon: Building,
    gradient: 'linear-gradient(135deg, #f6d365, #fda085)',
    description: 'Estructuras, transporte, geotecnia y urbanismo',
    subcategories: {
      'civil.struct': { label: 'Ingeniería Estructural', labelEn: 'Structural Engineering' },
      'civil.geo': { label: 'Geotecnia y Mecánica de Suelos', labelEn: 'Geotechnical Engineering' },
      'civil.hydro': { label: 'Ingeniería Hidráulica y Recursos Hídricos', labelEn: 'Hydraulic Engineering' },
      'civil.trans': { label: 'Ingeniería de Transporte e Infraestructura', labelEn: 'Transportation' },
      'civil.quake': { label: 'Ingeniería Sísmica', labelEn: 'Earthquake Engineering' },
      'civil.env': { label: 'Ingeniería Ambiental y Tratamiento de Aguas', labelEn: 'Environmental Engineering' },
      'civil.mat': { label: 'Materiales de Construcción', labelEn: 'Construction Materials' },
      'civil.urban': { label: 'Planificación Urbana y Regional', labelEn: 'Urban Planning' },
    },
  },
  chemeng: {
    label: 'Ingeniería Química y Materiales',
    labelEn: 'Chemical & Materials Engineering',
    icon: Beaker,
    gradient: 'linear-gradient(135deg, #84fab0, #8fd3f4)',
    description: 'Procesos químicos, nanotecnología y materiales',
    subcategories: {
      'chemeng.process': { label: 'Procesos Químicos y Catálisis', labelEn: 'Chemical Processes & Catalysis' },
      'chemeng.poly': { label: 'Ingeniería de Polímeros', labelEn: 'Polymer Engineering' },
      'chemeng.nano': { label: 'Nanotecnología y Nanomateriales', labelEn: 'Nanotechnology' },
      'chemeng.energy': { label: 'Energía, Baterías y Pilas de Combustible', labelEn: 'Energy & Batteries' },
      'chemeng.bio': { label: 'Bioingeniería e Ingeniería Biomédica', labelEn: 'Bioengineering' },
      'chemeng.metal': { label: 'Metalurgia y Aleaciones', labelEn: 'Metallurgy' },
      'chemeng.ceramics': { label: 'Cerámicas y Materiales Compuestos', labelEn: 'Ceramics & Composites' },
      'chemeng.sep': { label: 'Tecnologías de Separación y Membranas', labelEn: 'Separation Technologies' },
    },
  },
  med: {
    label: 'Medicina',
    labelEn: 'Medicine',
    icon: HeartPulse,
    gradient: 'linear-gradient(135deg, #ff758c, #ff7eb3)',
    description: 'Investigación clínica, salud pública y especialidades',
    subcategories: {
      'med.gen': { label: 'Medicina General e Interna', labelEn: 'General Medicine' },
      'med.onco': { label: 'Oncología', labelEn: 'Oncology' },
      'med.cardio': { label: 'Cardiología y Medicina Cardiovascular', labelEn: 'Cardiology' },
      'med.neuro': { label: 'Neurología Clínica', labelEn: 'Clinical Neurology' },
      'med.psych': { label: 'Psiquiatría y Salud Mental', labelEn: 'Psychiatry & Mental Health' },
      'med.pubh': { label: 'Salud Pública y Epidemiología', labelEn: 'Public Health & Epidemiology' },
      'med.pharma': { label: 'Farmacología y Desarrollo de Fármacos', labelEn: 'Pharmacology' },
      'med.tox': { label: 'Toxicología', labelEn: 'Toxicology' },
      'med.peds': { label: 'Pediatría', labelEn: 'Pediatrics' },
      'med.surg': { label: 'Cirugía', labelEn: 'Surgery' },
      'med.immuno': { label: 'Inmunología Clínica', labelEn: 'Clinical Immunology' },
      'med.endo': { label: 'Endocrinología y Metabolismo', labelEn: 'Endocrinology' },
      'med.path': { label: 'Patología', labelEn: 'Pathology' },
      'med.radio': { label: 'Radiología e Imagenología', labelEn: 'Radiology & Imaging' },
      'med.infect': { label: 'Enfermedades Infecciosas', labelEn: 'Infectious Diseases' },
      'med.derma': { label: 'Dermatología', labelEn: 'Dermatology' },
    },
  },
  bio: {
    label: 'Biología',
    labelEn: 'Biology',
    icon: Dna,
    gradient: 'linear-gradient(135deg, #11998e, #38ef7d)',
    description: 'De la genética a la ecología y microbiología',
    subcategories: {
      'bio.gen': { label: 'Genética y Herencia', labelEn: 'Genetics' },
      'bio.mol': { label: 'Biología Molecular', labelEn: 'Molecular Biology' },
      'bio.cell': { label: 'Biología Celular', labelEn: 'Cell Biology' },
      'bio.neuro': { label: 'Neurociencia y Neurobiología', labelEn: 'Neuroscience' },
      'bio.eco': { label: 'Ecología', labelEn: 'Ecology' },
      'bio.evo': { label: 'Evolución y Dinámica de Poblaciones', labelEn: 'Evolution & Population Dynamics' },
      'bio.zoo': { label: 'Zoología', labelEn: 'Zoology' },
      'bio.bot': { label: 'Botánica y Ciencias de las Plantas', labelEn: 'Botany' },
      'bio.micro': { label: 'Microbiología', labelEn: 'Microbiology' },
      'bio.immuno': { label: 'Inmunología Biológica', labelEn: 'Biological Immunology' },
      'bio.comp': { label: 'Bioinformática y Biología Computacional', labelEn: 'Bioinformatics' },
      'bio.physio': { label: 'Fisiología', labelEn: 'Physiology' },
      'bio.biochem': { label: 'Bioquímica', labelEn: 'Biochemistry' },
      'bio.marine': { label: 'Biología Marina', labelEn: 'Marine Biology' },
      'bio.biotech': { label: 'Biotecnología', labelEn: 'Biotechnology' },
    },
  },
};

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
  const prefix = arxivCategory.split('.')[0].split('-')[0];
  const areaMap = {
    quant: 'physics', cond: 'physics', hep: 'physics', astro: 'physics',
    gr: 'physics', math: 'math', nucl: 'physics', nlin: 'physics',
    physics: 'physics', cs: 'cs', stat: 'stat', econ: 'econ',
    eess: 'eess', q: arxivCategory.startsWith('q-fin') ? 'q-fin' : 'q-bio',
  };
  const area = CATEGORIES[areaMap[prefix]];
  return area ? area.gradient : 'var(--gradient-brand)';
}

/**
 * Get the human-readable label for a given arXiv category.
 */
export function getCategoryLabel(arxivCategory) {
  for (const area of Object.values(CATEGORIES)) {
    if (area.subcategories[arxivCategory]) {
      return area.subcategories[arxivCategory].label;
    }
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
 * @returns {Array<{id: string, label: string, labelEn: string, area: string, areaLabel: string, gradient: string}>}
 */
export function getAllLeafCategories() {
  const leaves = [];
  for (const [areaKey, area] of Object.entries(CATEGORIES)) {
    for (const [catId, cat] of Object.entries(area.subcategories)) {
      leaves.push({
        id: catId,
        label: cat.label,
        labelEn: cat.labelEn,
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
