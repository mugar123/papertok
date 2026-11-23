// Regions and their countries (ISO 3166-1 alpha-2) follow the UN M49 groups:
// https://unstats.un.org/unsd/methodology/m49/. Taiwan and Kosovo, which M49
// does not list, are placed with their neighbours.
const regionCountries = {
  africa: 'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW',
  asia: 'AE AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE',
  europe: 'AD AL AT AX BA BE BG BY CH CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK',
  'latin-america': 'AG AI AR AW BB BL BO BQ BR BS BV BZ CL CO CR CU CW DM DO EC FK GD GF GP GS GT GY HN HT JM KN KY LC MF MQ MS MX NI PA PE PR PY SR SV SX TC TT UY VC VE VG VI',
  'north-america': 'BM CA GL PM US',
  oceania: 'AS AU CC CK CX FJ FM GU HM KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS',
} as const;

const regions = {
  africa: 'Africa',
  asia: 'Asia',
  europe: 'Europe',
  'latin-america': 'Latin America & the Caribbean',
  'north-america': 'North America',
  oceania: 'Oceania',
} as const satisfies Record<keyof typeof regionCountries, string>;

/** The choices of the region filter: where an edition meets, or that its place is not known. */
export const conferenceRegions = {
  ...regions,
  online: 'Online',
  unknown: 'Location to be announced',
} as const;

export type ConferenceRegion = keyof typeof conferenceRegions;

const regionByCountry = new Map(
  (Object.keys(regions) as (keyof typeof regions)[])
    .flatMap(region => regionCountries[region].split(' ').map(country => [country, region] as const)),
);

export function regionOfCountry(country: string) {
  return regionByCountry.get(country);
}
