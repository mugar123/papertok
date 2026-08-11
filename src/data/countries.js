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

export const COUNTRIES_EN = {
  US: 'United States',
  CN: 'China',
  GB: 'United Kingdom',
  DE: 'Germany',
  JP: 'Japan',
  FR: 'France',
  CA: 'Canada',
  IT: 'Italy',
  IN: 'India',
  AU: 'Australia',
  KR: 'South Korea',
  ES: 'Spain',
  BR: 'Brazil',
  NL: 'Netherlands',
  CH: 'Switzerland',
  SE: 'Sweden',
  RU: 'Russia',
  IL: 'Israel',
  TW: 'Taiwan',
  AT: 'Austria',
  BE: 'Belgium',
  DK: 'Denmark',
  FI: 'Finland',
  NO: 'Norway',
  PL: 'Poland',
  SG: 'Singapore',
  PT: 'Portugal',
  IE: 'Ireland',
  CZ: 'Czech Republic',
  NZ: 'New Zealand',
  MX: 'Mexico',
  AR: 'Argentina',
  CL: 'Chile',
  CO: 'Colombia',
  ZA: 'South Africa',
  TR: 'Turkey',
  SA: 'Saudi Arabia',
  EG: 'Egypt',
  NG: 'Nigeria',
  KE: 'Kenya',
  TH: 'Thailand',
  MY: 'Malaysia',
  ID: 'Indonesia',
  PK: 'Pakistan',
  IR: 'Iran',
  GR: 'Greece',
  HU: 'Hungary',
  RO: 'Romania',
  UA: 'Ukraine',
  HK: 'Hong Kong',
};

export const SUPPORTED_COUNTRY_CODES = Object.freeze(Object.keys(COUNTRIES));

function normalizeCountrySearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Get the localized name for a country code.
 */
export function getCountryName(code, language = 'es') {
  const names = language === 'en' ? COUNTRIES_EN : COUNTRIES;
  return names[code] || code;
}

/**
 * Search countries by localized name. Returns array of { code, name }.
 */
export function searchCountries(query, language = 'es') {
  const q = normalizeCountrySearch(query);
  if (!q) return [];
  const names = language === 'en' ? COUNTRIES_EN : COUNTRIES;
  return Object.entries(names)
    .map(([code, name]) => ({
      code,
      name,
      normalizedCode: code.toLowerCase(),
      normalizedName: normalizeCountrySearch(name),
    }))
    .filter(({ normalizedCode, normalizedName }) => (
      normalizedName.includes(q) || normalizedCode.startsWith(q)
    ))
    .sort((a, b) => {
      const aStarts = a.normalizedCode.startsWith(q) ? 0 : a.normalizedName.startsWith(q) ? 1 : 2;
      const bStarts = b.normalizedCode.startsWith(q) ? 0 : b.normalizedName.startsWith(q) ? 1 : 2;
      return aStarts - bStarts || a.name.localeCompare(b.name, language);
    })
    .map(({ code, name }) => ({ code, name }))
    .slice(0, 10);
}
