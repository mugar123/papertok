/**
 * The papers and facts the landing shows.
 *
 * Frozen at build time on purpose. The alternative — asking the Worker for
 * live papers as the page loads — puts a network request in front of the first
 * paint of the page that has to be the fastest on the site, adds provider load
 * for every stranger who ever opens it, and still needs a fallback for when it
 * fails. A build-time snapshot is real data that happens to be a deploy old.
 *
 * TODO(landing): replace these literals with a prebuild step that reads the
 * feed's own sources and the GitHub API, so a deploy refreshes them. Until
 * then they are real, published works and real repository facts, checked by
 * hand on 2026-09-12.
 */

/**
 * The hero, as a deck of three.
 *
 * The first screen is the feed in miniature: the wheel walks these three
 * before it hands the page on, so the visitor has scrolled a paper away
 * before they ever press the button. See heroDeck.js.
 *
 * THREE FIELDS THAT DO NOT TOUCH, and that is the whole argument — a black
 * hole merger, a tardigrade protein, and the minimum wage in New Jersey.
 * Two papers from the same field would make the scroll a carousel.
 *
 * The order is not arbitrary either: the LIGO paper stays first because it is
 * what the screen has always rested on, and it is what a visitor who never
 * scrolls, never gets JavaScript, or asks for less motion sees.
 *
 * Card & Krueger carries no Open access chip because it is not open access —
 * the AER's copy is behind a paywall. Labelling it honestly on the page whose
 * third beat is honest labels costs nothing and is the whole point.
 */
export const HERO_PAPERS = [
  {
    field: 'Physics',
    fieldVar: '--gradient-physics',
    category: 'gr-qc',
    year: '2016',
    title: 'Observation of Gravitational Waves from a Binary Black Hole Merger',
    authors: 'B. P. Abbott et al. (LIGO Scientific Collaboration and Virgo Collaboration)',
    initials: ['BA', 'RA', 'TA'],
    chips: [
      { label: 'Verified', tone: 'blue' },
      { label: 'Open access', tone: 'green' },
      { label: 'DOI', tone: 'plain' },
    ],
    abstract:
      'On September 14, 2015 the two detectors of the Laser Interferometer '
      + 'Gravitational-Wave Observatory simultaneously observed a transient '
      + 'gravitational-wave signal. It matches the waveform predicted by general '
      + 'relativity for the inspiral and merger of a pair of black holes. The '
      + 'signal was observed with a false alarm rate of less than 1 event per '
      + '203 000 years.',
  },
  {
    field: 'Biology',
    fieldVar: '--gradient-bio',
    year: '2016',
    title: 'Extremotolerant tardigrade genome and improved radiotolerance of human cultured cells by tardigrade-unique protein',
    authors: 'Takuma Hashimoto, Daiki D. Horikawa et al.',
    initials: ['TH', 'DH'],
    chips: [
      { label: 'Verified', tone: 'blue' },
      { label: 'Open access', tone: 'green' },
      { label: 'DOI', tone: 'plain' },
    ],
    abstract:
      'Tardigrades survive conditions that kill almost everything else, including '
      + 'high doses of radiation. We sequenced the genome of the most stress-tolerant '
      + 'tardigrade known and found a nuclear protein, unique to the group, that binds '
      + 'DNA. Put into human cultured cells, it suppressed X-ray damage to their DNA '
      + 'by about 40 per cent.',
  },
  {
    field: 'Economics',
    fieldVar: '--gradient-econ',
    year: '1994',
    title: 'Minimum Wages and Employment: A Case Study of the Fast-Food Industry in New Jersey and Pennsylvania',
    authors: 'David Card and Alan B. Krueger',
    initials: ['DC', 'AK'],
    chips: [
      { label: 'Verified', tone: 'blue' },
      { label: 'Subscription', tone: 'neutral' },
      { label: 'DOI', tone: 'plain' },
    ],
    abstract:
      "On April 1, 1992 New Jersey's minimum wage rose from $4.25 to $5.05 an hour. "
      + 'We surveyed 410 fast-food restaurants in New Jersey and eastern Pennsylvania '
      + 'before and after the rise, and compared how employment grew in each. We find '
      + 'no indication that the higher minimum wage reduced employment.',
  },
];

/**
 * The column in the feed section: the card at rest, one neighbour either side.
 *
 * Three, not five. The page snaps one screen at a time, so this column has to
 * live inside one — and three is all the argument needs: a paper above, the
 * one you are on, a paper below. Five was the page being generous with space
 * it turned out not to have.
 */
export const FEED_PAPERS = [
  {
    field: 'Biology', fieldVar: '--gradient-bio', year: '2021', dim: 'near',
    title: 'Highly accurate protein structure prediction with AlphaFold',
    chips: [{ label: 'Verified', tone: 'blue' }, { label: 'Open access', tone: 'green' }],
  },
  {
    field: 'Computer science', fieldVar: '--gradient-cs', category: 'cs.CL', year: '2017', dim: null,
    title: 'Attention Is All You Need',
    authors: 'Ashish Vaswani, Noam Shazeer, Niki Parmar and 5 others',
    initials: ['AV', 'NS', 'NP'],
    chips: [{ label: 'Verified', tone: 'blue' }, { label: 'Open access', tone: 'green' }],
    abstract:
      'The dominant sequence transduction models are based on complex recurrent '
      + 'or convolutional neural networks. We propose a new simple network '
      + 'architecture, the Transformer, based solely on attention mechanisms, '
      + 'dispensing with recurrence and convolutions entirely.',
  },
  {
    field: 'Physics', fieldVar: '--gradient-physics', year: '2016', dim: 'near',
    title: 'Observation of Gravitational Waves from a Binary Black Hole Merger',
    chips: [{ label: 'Verified', tone: 'blue' }, { label: 'Open access', tone: 'green' }],
  },
];

/**
 * The pile in the problem section: a picker wheel of papers nobody is going
 * to get through.
 *
 * Long on purpose. The wheel spins a long way before it settles, and a short
 * list would run out of rows before the spin ran out of momentum — you would
 * see the end of the list rather than a barrel still turning. Every title is
 * a real, published work.
 *
 * No per-row opacity any more: the fading is a mask on the window in
 * landing.css, so it follows POSITION rather than identity. A row is dim
 * because it is near the top of the window, not because it was born dim —
 * which is the only way it can still be true while the rows are moving.
 */
export const PILE = [
  { venue: 'Nature 19', title: 'Quantum supremacy using a programmable superconducting processor' },
  { venue: 'A&A 20', title: 'Planck 2018 results. VI. Cosmological parameters' },
  { venue: 'arXiv 20', title: 'Language Models are Few-Shot Learners' },
  { venue: 'Nature 53', title: 'Molecular Structure of Nucleic Acids' },
  { venue: 'Science 04', title: 'Electric Field Effect in Atomically Thin Carbon Films' },
  { venue: 'Nature 01', title: 'Initial sequencing and analysis of the human genome' },
  { venue: 'Science 12', title: 'A Programmable Dual-RNA-Guided DNA Endonuclease in Adaptive Bacterial Immunity' },
  { venue: 'PLB 12', title: 'Observation of a New Particle in the Search for the Standard Model Higgs Boson' },
  { venue: 'Nature 15', title: 'Human-level control through deep reinforcement learning' },
  { venue: 'Nature 16', title: 'Mastering the game of Go with deep neural networks and tree search' },
  { venue: 'Nature 15', title: 'Deep Learning' },
  { venue: 'NC 97', title: 'Long Short-Term Memory' },
  { venue: 'arXiv 13', title: 'Auto-Encoding Variational Bayes' },
  { venue: 'arXiv 14', title: 'Neural Machine Translation by Jointly Learning to Align and Translate' },
  { venue: 'arXiv 14', title: 'Very Deep Convolutional Networks for Large-Scale Image Recognition' },
  { venue: 'JMLR 14', title: 'Dropout: A Simple Way to Prevent Neural Networks from Overfitting' },
  { venue: 'arXiv 18', title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding' },
  { venue: 'arXiv 20', title: 'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale' },
  { venue: 'arXiv 20', title: 'Denoising Diffusion Probabilistic Models' },
  { venue: 'arXiv 14', title: 'Generative Adversarial Networks' },
  { venue: 'ApJL 19', title: 'First M87 Event Horizon Telescope Results. I. The Shadow of the Supermassive Black Hole' },
  { venue: 'arXiv 15', title: 'Deep Residual Learning for Image Recognition' },
  { venue: 'arXiv 14', title: 'Adam: A Method for Stochastic Optimization' },
  { venue: 'Nature 21', title: 'Highly accurate protein structure prediction with AlphaFold' },
  { venue: 'arXiv 17', title: 'Attention Is All You Need' },
];

/**
 * The picker wheel's geometry, in one place.
 *
 * Three files need these numbers and they have to agree exactly: page.js
 * writes a slot's angle into the markup, landing.css builds the cylinder from
 * them, and motion.js turns the barrel by them. A radius in the stylesheet
 * that disagreed with a step in the script would not throw — it would just
 * bend wrong, which is the kind of bug that costs an afternoon.
 *
 * RADIUS is derived, not chosen: `ROW_H / (2·tan(STEP/2))` is the distance
 * that spaces the slots exactly one row-height apart along the surface. The
 * step is the only real lever — a gentler one buys a longer radius and a
 * softer bend, and nine degrees is about as flat as it can get while still
 * reading as a wheel rather than a list.
 *
 * SLOTS is the whole trick: the barrel holds SLOTS and the papers move through
 * them, so the arc never has to grow past ±54° no matter how long the list is.
 * An arc long enough to hold every paper crosses ±90°, where rows go edge-on
 * and fold back over the ones in front, mirrored.
 */
export const WHEEL = {
  /* THIRTEEN, and the outermost two are the point of the number.
     Nine slots spanned 402px of a 440px window, which left the mask's
     transparent zone empty: measured, a row was handed to the outer slot at
     alpha 0.20 and its inner edge sat at 0.56, so a new paper did not fade in,
     it appeared. Thirteen puts a whole slot inside the transparent band — a
     row is now BORN invisible and climbs a two-row ramp. ±54° is still far
     from the ±90° where rows go edge-on and fold back mirrored. */
  SLOTS: [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6],
  STEP: 9,        /* degrees between slots */
  RADIUS: 330,    /* px — 52 / (2·tan 4.5°) */
  ROW_H: 52,      /* px */
  /* How far ONE flick projects. Not a distance the driver walks: motion.js
     states the flick as an impulse and a coast, and this is where that
     impulse lands — Apple's own projection, velocity x time constant. The
     driver then rounds to the detent nearest it, because the wheel has to
     come to rest with a row on the selection line and a picker that stops
     between detents is not a picker.

     It has to be COPRIME WITH PILE.length, which is 25: reach and list length
     sharing a factor makes the wheel cycle back to the papers it started on
     after length/gcd flicks, and a pile you can return to is the one thing
     this section cannot say. Twenty would have come home after five, and so
     would fifteen; fourteen, sixteen and eighteen each take twenty-five.

     THREE of them, and the driver never uses the same one twice running: a
     hand does not deal the same flick twice, and a wheel that travels exactly
     the same distance every time reads as a mechanism rather than as an
     object. You notice the repeat before you notice the motion. */
  REACHES: [14, 16, 18],
  /* The coast. A scroll view's decelerationRate d, per millisecond, is
     tau = d / (1000(1 - d)); 380ms is d = 0.99738, just inside the 0.998 iOS
     ships for scrolling.

     The pair gives 0.61 to 0.79 rows per frame at the peak, and the top of
     that is the ceiling rather than a choice. Past about 0.81 rows per frame two
     consecutive frames show sharp, completely different text with nothing in
     between, and the eye reads it as flicker rather than as movement — no
     frame-rate measurement sees it, the spin renders at a clean 60fps either
     way. Three ways past that ceiling were built and thrown away: sharp and
     fast strobes; a Gaussian smear keeps a bright core and reads as out of
     focus; fading the rows reads as grey text with sharp edges. All three
     were found by LOOKING at the frames, never by measuring them.

     So the speed is spoken for and the CHARACTER comes from the coast being
     long instead: a hard leave, then a second and a half dying away one row
     at a time onto a paper, with nothing in any frame fighting the eye. */
  TAU: 380,
};


export const LEVELS = [
  {
    name: 'Beginner',
    paras: [
      'Two black holes crashed into each other and the shock made space itself '
      + 'wobble. Two machines on opposite sides of the United States felt the wobble.',
      'It lasted about a fifth of a second, and it was so faint that the machines '
      + 'had to be built to notice a change far smaller than an atom.',
    ],
  },
  {
    name: 'University',
    paras: [
      'Two detectors 3,000 km apart recorded the same brief signal within '
      + 'milliseconds of each other. Its shape matches what general relativity '
      + 'predicts when two black holes spiral together and merge: frequency and '
      + 'amplitude rising, then cutting off.',
      'The odds of noise producing it are small enough that the detection is '
      + 'treated as real.',
    ],
  },
  {
    name: 'Researcher',
    paras: [
      'A coincident transient at both interferometers, matched-filtered against '
      + 'binary coalescence templates, with a significance beyond 5.1 sigma over '
      + '16 days of coincident data.',
      'Source-frame masses of 36 and 29 solar masses merging into a 62 solar mass '
      + 'remnant, with 3.0 radiated away as gravitational waves.',
    ],
  },
];

/** Which level the page opens on. University is the middle of the three. */
export const DEFAULT_LEVEL = 1;

/**
 * The rewrite, before it is a rewrite.
 *
 * The section used to open on the finished passage, which says a model wrote
 * something but not that the paper was fetched, read whole and rewritten —
 * the part that takes a minute and the part nobody believes until they watch
 * it happen. So it opens on the wall instead: the real abstract, and one
 * button.
 *
 * The abstract is the second half of the LIGO paper's own (PRL 116, 061102,
 * CC BY 3.0) — the sentences the hero does not use, so the page never prints
 * the same paragraph twice. It is the densest part of it, which is the point:
 * this is what the left column means by "a wall".
 *
 * `stages` and `hint` are the app's own strings, verbatim: `copy.stages` and
 * `copy.writingHint` in src/components/Reader/PaperReader.jsx. The third
 * stage the reader shows — Rewriting the paper — is deliberately absent: two
 * labels already tell the story, and the writing is shown rather than
 * announced.
 *
 * `uses.total` is AI_DAILY_USER_LIMIT in wrangler.toml. If that number moves
 * there, this one becomes a claim the product no longer keeps.
 */
export const REWRITE = {
  paper: {
    field: 'Physics',
    category: 'gr-qc',
    year: '2016',
    title: 'Observation of Gravitational Waves from a Binary Black Hole Merger',
    authors: 'B. P. Abbott et al. (LIGO Scientific Collaboration and Virgo Collaboration)',
    initials: ['BA', 'RA', 'TA'],
    chips: [
      { label: 'Verified', tone: 'blue' },
      { label: 'Open access', tone: 'green' },
      { label: 'DOI', tone: 'plain' },
    ],
    abstract:
      'The signal sweeps upwards in frequency from 35 to 250 Hz with a peak '
      + 'gravitational-wave strain of 1.0×10⁻²¹. The source lies at a luminosity '
      + 'distance of 410 Mpc, corresponding to a redshift z = 0.09. In the source '
      + 'frame, the initial black hole masses are 36 M☉ and 29 M☉, and the final '
      + 'black hole mass is 62 M☉, with 3.0 M☉c² radiated in gravitational waves. '
      + 'These observations demonstrate the existence of binary stellar-mass '
      + 'black hole systems.',
  },
  stages: [
    { id: 'source', label: 'Downloading the paper' },
    { id: 'reading', label: 'The model is reading the paper' },
  ],
  hint: 'Sections appear as they are written.',
  heading: 'What the paper is about',
  cost: '1 use · 10 a day',
  uses: { left: 9, total: 10 },
  /** The five uneven bars of the reader's ghost, PaperReader.jsx:476. */
  ghostLines: ['100%', '97%', '99%', '93%', '61%'],
};

/** The Research edition, as the app lays it out. */
export const RESEARCH = {
  periods: ['Today and yesterday', '7 days', '30 days', '1 year', '10 years', 'Custom'],
  active: '7 days',
  lead: {
    field: 'Medicine',
    venue: 'Nature Aging',
    year: '2026',
    title: 'cGAS-deficient mice display premature aging associated with derepression of LINE1 elements',
    authors: 'John C. Martinez, Francesco Morandini, Cheyenne Rechsteiner, Lucinda Fitzgibbons et al.',
    chips: [
      { label: 'Verified', tone: 'blue' },
      { label: 'Open access', tone: 'green' },
      { label: '12 citations', tone: 'neutral' },
    ],
    abstract:
      "Aging-associated inflammation, or 'inflammaging', is a driver of multiple "
      + 'age-associated diseases. Cyclic GMP-AMP Synthase is a cytosolic DNA sensor '
      + 'that functions to activate interferon response upon detecting viral DNA in '
      + 'the cytoplasm.',
  },
  stats: [
    { value: '11', label: 'Selected' },
    /* The real sum of the eleven papers on the card. With the whole selection
       on screen a count that does not add up is the first thing a reader
       checks, so it is computed from `lead` + `highlights`, not asserted. */
    { value: '51', label: 'Selection citations' },
    { value: '11/11', label: 'Selection OA', underline: true },
  ],
  /* The rest of the selection, as the forme sets it: rows that each close on
     the six-column measure, which is what keeps a newspaper front irregular
     without leaving the ragged hole a masonry layout would. Real papers, real
     venues, real counts — OpenAlex, published 5–11 September 2026, all open
     access. Fields are the app's own areas (src/utils/areaAccent.js), which is
     why a retina paper reads Medicine: OpenAlex files neuroscience under it. */
  highlights: [
    [
      { span: 4, size: 'xl', lines: 4, tone: 'bio', field: 'Biology', year: '2026',
        title: 'Ternary Neurexin-T178-PTPR complexes represent a pre-synaptic core-module of neuronal synapse organisation',
        dek: 'Synapses, prototypic sites for neuronal communication, are key to brain function. Their organization and properties are instructed by synaptic cell adhesion molecules that may operate independently or in coordination, and the modules they form have remained largely unresolved in the native brain.',
        cites: '3 citations', venue: 'Nature Communications' },
      { span: 2, size: 'md', lines: 4, tone: 'med', field: 'Medicine', year: '2026',
        title: 'Oveporexton for Narcolepsy Type 1 — Results from Two Phase 3 Trials',
        dek: 'Narcolepsy type 1 is characterized by excessive daytime sleepiness, cataplexy, disrupted sleep and sleep paralysis. Oveporexton, an oral orexin receptor 2-selective agonist, reduced symptoms in a previous phase 2 trial.',
        cites: '2 citations', venue: 'New England Journal of Medicine' },
    ],
    [
      { span: 2, size: 'md', tone: 'bio', field: 'Biology', year: '2026',
        title: 'Cohesin prevents local mixing of condensed euchromatic domains in living human cells',
        dek: 'The human genome is folded into chromatin loops by the cohesin complex, forming functional chromatin domains that underlie transcription and DNA replication and repair.',
        cites: '7 citations', venue: 'Nature Genetics' },
      { span: 2, size: 'md', tone: 'med', field: 'Medicine', year: '2026',
        title: 'Temporal prediction captures retinal spiking responses across animal species',
        dek: "The retina's role in visual processing has been viewed as two extremes: an efficient compressor of incoming stimuli, akin to a camera, or a predictor of future ones.",
        cites: '4 citations', venue: 'Nature Communications' },
      { span: 2, size: 'md', tone: 'physics', field: 'Physics', year: '2026',
        title: 'The LBT Yp Project. IV. A New Value of the Primordial Helium Abundance',
        dek: 'A new determination of the primordial helium abundance from high-quality Large Binocular Telescope observations of 54 metal-poor H II regions, analyzed uniformly.',
        cites: '4 citations', venue: 'The Astrophysical Journal' },
    ],
    [
      { span: 6, size: 'xl', tone: 'cs', field: 'Computer science', year: '2026', heavy: true, split: true,
        title: 'AI-coupled HPC Workflow Applications, Middleware and Performance',
        dek: 'AI integration is revolutionizing the landscape of HPC simulations, enhancing the importance, use, and performance of AI-coupled HPC workflows. This paper surveys the diverse and rapidly evolving field of AI-driven HPC and provides a common conceptual basis for understanding such workflows, drawing on insights from different application scenarios.',
        cites: '11 citations', venue: 'ACM Computing Surveys' },
    ],
    [
      { span: 3, size: 'lg', tone: 'med', field: 'Medicine', year: '2026',
        title: 'Dual plasmepsin IX and X inhibitors are refractory to development of resistance',
        dek: 'Artemisinin-based combination therapies remain the cornerstone of malaria treatment, but emerging resistance threatens their efficacy.',
        cites: '2 citations', venue: 'PLoS Pathogens' },
      { span: 3, size: 'lg', tone: 'math', field: 'Mathematics', year: '2026',
        title: 'Well-posedness and singularity formation beyond the Yudovich class',
        dek: 'A local-in-time existence and uniqueness class for the 2d Euler equation with unbounded vorticity — and solutions in it can develop stronger singularities in finite time.',
        cites: '1 citation', venue: 'Journal of the European Mathematical Society' },
    ],
    [
      { span: 2, size: 'sm', lines: 2, tone: 'cs', field: 'Computer science', year: '2026',
        title: 'Optimal Federated Learning for Nonparametric Regression with Heterogeneous Distributed Differential Privacy',
        dek: 'Data distributed across servers of varying sample size and privacy budget, and what the optimal rate is under those constraints.',
        cites: '2 citations', venue: 'Journal of the American Statistical Association' },
      { span: 4, size: 'lg', tone: 'bio', field: 'Biology', year: '2026',
        title: 'End processing in NHEJ by Polymerase λ and PNKP is coordinated during short-range synapsis',
        dek: 'Non-homologous end joining is a major pathway of DNA double strand break repair, capable of joining both damaged strands directly through the coordinated activities of the factors that detect the termini.',
        cites: '3 citations', venue: 'Nature Communications' },
    ],
  ],
  /* The edition's own full stop. A reader who reaches it has read everything
     this period ranked highest; the only question left is whether there is
     more of it. */
  turn: {
    kicker: 'End of selection 1',
    line: 'That is the eleven this period ranked highest. Selection 2 carries the next eleven.',
    cta: 'Selection 2',
    note: '26 selections in this period',
  },
  /* Two, not three: the plate has to fit one screen. The rail's job is to
     show that the edition carries numbers, and two rows say that. */
  /* The percentages are computed from the counts, not typed beside them: 882
     against 523 is +69%, and the pair that shipped before said +115%. */
  topics: [
    { name: 'Diverse Scientific and Economic Research', works: 882, previous: 523 },
    { name: 'Human auditory perception', works: 641, previous: 436 },
  ],
  window: 'Provisional data · Sep 5 – Sep 11<br>compared with Aug 29 – Sep 4',
};

/* Transform topics to compute pct from works/previous and add worksLabel. */
RESEARCH.topics = RESEARCH.topics.map((t) => ({
  ...t,
  pct: Math.round((t.works / t.previous - 1) * 100),
  worksLabel: `${t.works} works; previously ${t.previous}`,
}));

/**
 * The repository, as the GitHub API reported it on 2026-09-12.
 *
 * Only what the strip (§10 of the design) actually renders: the path for
 * the GitHub link and the license. Stars, forks and an open-issue count
 * were deliberately left off the page — two and one are numbers that cost
 * more than they pay on a landing page — and a `reading` list of source
 * files with hand-typed line counts went stale (it claimed
 * `worker/report-api.js` was 2,589 lines; it is 2,630 as of this cleanup)
 * without anything ever publishing it. Removed rather than fixed, since
 * nothing rendered it.
 */
/* Only what the page renders: `description` was the last survivor of the
   dead fields removed in 25cfbc3 and nothing ever read it either. */
export const REPO = {
  path: 'mugar123/papertok',
  license: 'MIT',
};

/* Two lists, because the sentence that renders them makes two different
   claims. SOURCES is where a paper in the feed actually came FROM; ENRICHERS
   never put a paper in front of anyone, they answer questions about one that
   is already there. NIH iCite sat in the first list and was read as a place
   papers come from, which its own description two lines away contradicted
   (`worker/report-api.js` calls it for citation metrics on PubMed records).
   Everything named here is called by name in `worker/report-api.js` or
   `src/services/`; nothing aspirational goes in either list. */
export const SOURCES = [
  ['arXiv', 'Preprints across physics, mathematics and computer science'],
  ['OpenAlex', 'Metadata, citations, concepts, institutions, open access'],
  ['PubMed', 'Biomedical and life-science literature'],
  ['OpenReview', 'Machine learning and CS submissions under review'],
  ['Hugging Face', 'AI papers with their models, datasets and code'],
];

export const ENRICHERS = [
  ['Unpaywall', 'Where a legal free copy of a paywalled paper lives'],
  ['NIH iCite', 'Citation and translation metrics for PubMed papers'],
];

export const PEOPLE = [
  {
    name: 'Nicolás Muñoz García',
    github: 'mugar123',
    x: 'therealmugar',
    role:
      'Physics at the University of Salamanca. Started PaperTok in June 2026 as '
      + 'the tool he wanted for himself, and works on the ranking, the feed and '
      + 'the worker behind them.',
  },
  {
    name: 'Samuel Corsan',
    github: 'samuelcorsan',
    x: 'disamdev',
    role:
      'Product engineer. Joined in August 2026 and works on the interface — the '
      + 'Explorer, the design system, and the look of the whole thing.',
  },
];

export const SIGNALS = [
  ['What you picked', 'The fields and categories you chose when you started.'],
  ['What you did', 'The papers you liked, saved, opened and skipped.'],
  ['Who you follow', 'Authors, topics, institutions and projects.'],
  ['How recent it is', 'Newer work gets a push; nothing is buried for being old.'],
  ['Its record', 'Citation counts and the concepts the paper carries.'],
  ['A detour', 'Once in a while, something outside your usual interests, on purpose.'],
];

export const FOLLOW_ROWS = [
  { kind: 'person', name: 'David Card', sub: 'Author · University of California, Berkeley' },
  { kind: 'tag', name: 'Gravitational waves', sub: 'Topic · 41,180 works' },
  { kind: 'building', name: 'Universidad de Salamanca', sub: 'Institution · Salamanca, Spain', lang: 'es' },
];

/* The lists as the app paints them: the rule colour is the list's own, not a field ink. */
export const LISTS = [
  { color: 'var(--accent-like)', icon: 'heart', name: 'Favorites', count: '50 papers', isPublic: false, titles: ['On String Theory Duals of Lifshitz-like…', 'Integrating Post-Newtonian Equations…'] },
  { color: 'var(--border-strong)', icon: 'book', name: 'Read later', count: '0 papers', isPublic: false, titles: [] },
  { color: 'var(--list-ochre)', icon: 'eye', name: 'Reading history', count: '1 paper', isPublic: false, titles: ['Structural complexity of an SU(3) Ferm…'] },
  { color: 'var(--list-indigo)', icon: 'folder', name: 'Papers de sugar', count: '14 papers', isPublic: true, titles: ['State–Generator Geometry of Open…', 'Observation of perfect absorption in…'] },
];

/* The real neighbourhood of the LIGO paper (OpenAlex W2252795400), read on
   2026-09-18 and frozen. Each side is selected the way the app itself selects
   it, which is not the same rule twice: above are the five most CITED of the
   99 works it references (`cited_by:W2252795400` sorted by `cited_by_count`),
   below are the two most RECENT of the works that cite it
   (`cites:W2252795400` sorted by `publication_date`) — `worker/report-api.js`
   asks OpenCitations with `sort=desc(creation)` and OpenAlex with
   `publication_date:desc`, and `RelatedPapersSheet.jsx` captions the two bands
   "N most cited of M" and "N most recent of M" for exactly that reason. The
   totals come from the same two fields the app's own counts derive from
   (`report-api.js`: `referenced_works` and `cited_by_count`), so the page
   shows the number the app would show. The newest citing works having no
   citations of their own is not a gap in the data — it is what the axis is
   for, and what a reader sees in the app the day they open it.
   `order` is the draw-on order, chronological; the paper itself is 0. */
export const MAP = {
  centre: { label: 'THIS PAPER · 2016' },
  totals: { cited: 99, citing: 14526 },
  above: [
    { name: "Acernese '14 · Advanced Virgo", citations: 4220, y: 62, order: 4 },
    { name: "Kerr '63", citations: 3593, y: 112, order: 1 },
    { name: "Aasi '15 · Advanced LIGO", citations: 3506, y: 196, order: 5 },
    { name: "Blanchet '14", citations: 2282, y: 150, order: 3 },
    { name: "Abramovici '92", citations: 2278, y: 240, order: 2 },
  ],
  below: [
    { name: "Eiroa '26", citations: 0, y: 360, order: 6 },
    { name: "Makihara '26", citations: 0, y: 440, order: 7 },
  ],
};