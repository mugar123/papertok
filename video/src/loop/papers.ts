// Real papers, so every title, year, author line and opening sentence on
// screen can be checked. Field inks mirror `--gradient-*` in
// `src/styles/variables.css`.

export const FIELD = {
  cs: "#c2410c",
  bio: "#15803d",
  math: "#7e22ce",
  stat: "#1d4ed8",
  econ: "#0f766e",
  med: "#be123c",
  physics: "#4f46e5",
} as const;

export type LoopPaper = {
  id: string;
  field: string;
  label: string;
  year: number;
  concepts: string[];
  title: string;
  authors: string;
  initials: string[];
  abstract: string;
};

export const PAPERS: LoopPaper[] = [
  {
    id: "arxiv:1706.03762",
    field: FIELD.cs,
    label: "Computation and Language",
    year: 2017,
    concepts: ["Machine translation", "Transformer"],
    title: "Attention Is All You Need",
    authors: "Ashish Vaswani, Noam Shazeer, Niki Parmar et al.",
    initials: ["AV", "NS", "NP"],
    abstract:
      "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks in an encoder-decoder configuration. The best performing models also connect the encoder and decoder through an attention mechanism.",
  },
  {
    id: "doi:10.1038/s41586-021-03819-2",
    field: FIELD.bio,
    label: "Quantitative Biology",
    year: 2021,
    concepts: ["Protein structure", "Deep learning"],
    title: "Highly accurate protein structure prediction with AlphaFold",
    authors: "John Jumper, Richard Evans, Alexander Pritzel et al.",
    initials: ["JJ", "RE", "AP"],
    abstract:
      "Proteins are essential to life, and understanding their structure can facilitate a mechanistic understanding of their function.",
  },
  {
    id: "doi:10.1002/j.1538-7305.1948.tb01338.x",
    field: FIELD.math,
    label: "Information Theory",
    year: 1948,
    concepts: ["Entropy", "Channel capacity"],
    title: "A Mathematical Theory of Communication",
    authors: "Claude E. Shannon",
    initials: ["CS"],
    abstract:
      "The fundamental problem of communication is that of reproducing at one point either exactly or approximately a message selected at another point.",
  },
  {
    id: "doi:10.1111/j.2517-6161.1996.tb02080.x",
    field: FIELD.stat,
    label: "Statistics",
    year: 1996,
    concepts: ["Regression", "Sparsity"],
    title: "Regression Shrinkage and Selection via the Lasso",
    authors: "Robert Tibshirani",
    initials: ["RT"],
    abstract:
      "We propose a new method for estimation in linear models. The lasso minimizes the residual sum of squares subject to the sum of the absolute value of the coefficients being less than a constant.",
  },
  {
    id: "doi:10.2307/1879431",
    field: FIELD.econ,
    label: "Economics",
    year: 1970,
    concepts: ["Information asymmetry", "Markets"],
    title: "The Market for \u201cLemons\u201d: Quality Uncertainty and the Market Mechanism",
    authors: "George A. Akerlof",
    initials: ["GA"],
    abstract:
      "This paper relates quality and uncertainty. The existence of goods of many grades poses interesting and important problems for the theory of markets.",
  },
  {
    id: "doi:10.1056/NEJMoa2034577",
    field: FIELD.med,
    label: "Medicine",
    year: 2020,
    concepts: ["mRNA vaccine", "Clinical trial"],
    title: "Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine",
    authors: "Fernando P. Polack, Stephen J. Thomas, Nicholas Kitchin et al.",
    initials: ["FP", "ST", "NK"],
    abstract:
      "Severe acute respiratory syndrome coronavirus 2 (SARS-CoV-2) infection and the resulting coronavirus disease 2019 (Covid-19) have afflicted tens of millions of people in a worldwide pandemic.",
  },
  {
    id: "doi:10.1103/PhysRevLett.116.061102",
    field: FIELD.physics,
    label: "General Relativity",
    year: 2016,
    concepts: ["Black holes", "Gravitational waves"],
    title: "Observation of Gravitational Waves from a Binary Black Hole Merger",
    authors: "B. P. Abbott et al. \u00b7 LIGO Scientific and Virgo Collaboration",
    initials: ["BA"],
    abstract:
      "On September 14, 2015 at 09:50:45 UTC the two detectors of the Laser Interferometer Gravitational-Wave Observatory simultaneously observed a transient gravitational-wave signal.",
  },
];

// GW150914: the source sat about 410 Mpc (~1.3 billion light-years) away.
export const PLAIN_WORDS = {
  before: "Two black holes collided 1.3 billion light-years away. For the first time, ",
  highlight: "we heard spacetime ripple.",
};
