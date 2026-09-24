/**
 * What the sign-in dialog says, by the reason it was opened for.
 *
 * It used to have one text for every door: a guest who pressed «Leer en
 * simple» — the thing the welcome sheet promises — was told to «Da me gusta,
 * guarda y sigue investigación», with no word about why the button had asked
 * for an account (audit 2026-09-23, issues 2, 9 and 10). A reason is one of
 * the keys below; anything else — a click event handed over by an
 * `onClick={requestAuthentication}`, a paper handed over by `onSaveToList` —
 * opens the general door.
 */
const COPY = Object.freeze({
  default: {
    es: {
      title: 'Haz que PaperTok sea tuyo',
      lede: 'Da me gusta, guarda y sigue investigación, y entrena un feed que aprende lo que lees.',
    },
    en: {
      title: 'Make PaperTok yours',
      lede: 'Like, save and follow research, and train a feed that learns what you read.',
    },
  },
  paper_rewrite: {
    es: {
      title: 'Leer en simple necesita una cuenta',
      lede: 'Con una cuenta gratuita, los papers con texto completo se pueden leer explicados en claro. Además podrás guardar, seguir investigación y entrenar tu feed.',
    },
    en: {
      title: 'Reading in plain words needs an account',
      lede: 'With a free account, papers with full text can be read explained in plain words. You can also save, follow research and train your feed.',
    },
  },
  related: {
    es: {
      title: 'Las conexiones necesitan una cuenta',
      lede: 'Con una cuenta gratuita verás el grafo de citas y los papers similares de cada paper, y podrás guardar y seguir investigación.',
    },
    en: {
      title: 'Connections need an account',
      lede: 'With a free account you can see the citation graph and the similar papers of every paper, and save and follow research.',
    },
  },
  explorer_search: {
    es: {
      title: 'Buscar y filtrar necesita una cuenta',
      lede: 'Con una cuenta gratuita se abre la lista entera de este tema, autor o institución, con su buscador y sus filtros.',
    },
    en: {
      title: 'Search and filters need an account',
      lede: 'With a free account the whole list of this topic, author or institution opens, with its search and its filters.',
    },
  },
});

export function normalizeAuthReason(value) {
  return typeof value === 'string' && Object.hasOwn(COPY, value) ? value : 'default';
}

export function authPromptCopy(reason, language) {
  return COPY[normalizeAuthReason(reason)][language === 'en' ? 'en' : 'es'];
}
