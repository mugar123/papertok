/**
 * Country data for PaperTok Report filters.
 * Maps ISO 3166-1 alpha-2 codes to Spanish names.
 */

export const COUNTRIES = {
  US: 'Estados Unidos',
  CN: 'China',
  GB: 'Reino Unido',
  DE: 'Alemania',
  JP: 'Japón',
  FR: 'Francia',
  CA: 'Canadá',
  IT: 'Italia',
  IN: 'India',
  AU: 'Australia',
  KR: 'Corea del Sur',
  ES: 'España',
  BR: 'Brasil',
  NL: 'Países Bajos',
  CH: 'Suiza',
  SE: 'Suecia',
  RU: 'Rusia',
  IL: 'Israel',
  TW: 'Taiwán',
  AT: 'Austria',
  BE: 'Bélgica',
  DK: 'Dinamarca',
  FI: 'Finlandia',
  NO: 'Noruega',
  PL: 'Polonia',
  SG: 'Singapur',
  PT: 'Portugal',
  IE: 'Irlanda',
  CZ: 'República Checa',
  NZ: 'Nueva Zelanda',
  MX: 'México',
  AR: 'Argentina',
  CL: 'Chile',
  CO: 'Colombia',
  ZA: 'Sudáfrica',
  TR: 'Turquía',
  SA: 'Arabia Saudí',
  EG: 'Egipto',
  NG: 'Nigeria',
  KE: 'Kenia',
  TH: 'Tailandia',
  MY: 'Malasia',
  ID: 'Indonesia',
  PK: 'Pakistán',
  IR: 'Irán',
  GR: 'Grecia',
  HU: 'Hungría',
  RO: 'Rumanía',
  UA: 'Ucrania',
  HK: 'Hong Kong',
};

/**
 * Get the Spanish name for a country code.
 */
export function getCountryName(code) {
  return COUNTRIES[code] || code;
}

/**
 * Search countries by name (Spanish). Returns array of { code, name }.
 */
export function searchCountries(query) {
  if (!query || query.length < 1) return [];
  const q = query.toLowerCase();
  return Object.entries(COUNTRIES)
    .filter(([, name]) => name.toLowerCase().includes(q))
    .map(([code, name]) => ({ code, name }))
    .slice(0, 10);
}
