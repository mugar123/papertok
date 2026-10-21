import type { WorkerEnv } from './env.ts';
import type { InstitutionQuery, InstitutionResolver, LookupOptions } from './institution-access.ts';

interface ServiceEntry {
  kind: 'platform' | 'publication' | 'journal';
  eissn?: string; platformId?: string; sources?: readonly string[];
  id: string; packageHint: string; name: string; publisher: string; url: string;
  monogram: string; color: string; issn: string; year: number; doi?: string;
}
type ServiceSubscription = { collection: string | null | undefined; ownPlatform: boolean; accessUrl?: string };
type ServiceOutcome = ServiceSubscription | null | undefined | typeof FAILED | typeof UNCHECKED;
/** What a probe decided about one catalogue entry, and when. */
type StoredVerdict = { at: number; verdict: ServiceSubscription | null | 'unchecked' };
type StoredVerdicts = Record<string, StoredVerdict>;
type ServicesStore = Pick<KVNamespace, 'get' | 'put'>;


/**
 * Publications and publisher platforms found through the library.
 *
 * Each platform in the catalogue is probed with the same providers, in the
 * same order, as `/access`: GetFTR when a paywalled probe DOI is available,
 * then the library's link resolver with the ISSN and year of one of its
 * journals. The catalogue already knows the journal, so Crossref is not asked.
 * A platform is listed when its probe is entitled; the list describes the
 * library and is informative only, the per-paper answer stays with `/access`.
 *
 * Verdicts are the library's, and they are kept in KV one per catalogue
 * entry, under the parameters the probes were sent with. A request answers
 * from the stored verdicts and probes only the entries that have none, so a
 * catalogue that grows costs the entries added, not the list again, and a
 * reader at a library already read gets the list at once wherever they are.
 * The edge cache used to keep whole pages, per data centre, under the
 * catalogue's fingerprint: every catalogue change and every new location
 * probed the whole list again (USAL, 2026-10-14 and 2026-10-21).
 */

import {
  GETFTR_BATCH_SIZE,
  InstitutionAccessError,
  RESOLVER_READING,
  findResolver,
  readInstitutionQuery,
  askGetFtrBatch,
  askResolver,
  libraryLink,
  upstreamParams,
} from './institution-access.ts';

import { corsHeaders, json } from './http.ts';

export const INSTITUTION_SERVICES_PATH = '/institution/services';

// Each request must finish before the browser's 15 s request deadline.
// Timeouts remain partial results rather than evidence of absent access.
const SERVICES_DEADLINE_MS = 12000;
// Workers allow six simultaneous outbound connections per invocation.
const PROBE_CONCURRENCY = 6;
// No probe starts later than this after the first resolver probe, so the
// slowest one in flight still has half the deadline when GetFTR was quick.
// The entries no probe started for stay unanswered in the store, and the
// next request goes on from there: TUM's SFX took about 1.3 s a probe
// (2026-10-20), so a library read for the first time takes a few requests.
const SERVICES_START_WINDOW_MS = 6000;
// Subscriptions change and the probe year ages: a verdict this old is asked
// again. A library nobody asks about for three months is forgotten.
export const VERDICT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STORE_RECORD_TTL_SECONDS = 90 * 24 * 60 * 60;
const FAILED = Symbol('failed');
const UNCHECKED = Symbol('unchecked');

// `color` and `monogram` are brand data for the tile the client draws; the
// publishers' logos and favicons are trademarks and are not fetched at runtime.
// `issn` and `year` name a flagship journal for the resolver, `doi` a
// paywalled article of it for GetFTR; none of the three leaves the Worker.
// The DOI must stay closed: GetFTR says yes to open content for anyone, which
// would list the platform for every library. Each probe DOI was closed in Unpaywall
// (`is_oa: false`) and matched its ISSN and year in Crossref on 2026-10-13;
// the platforms from JSTOR on were checked the same way through OpenAlex's
// `open_access.is_oa` (Unpaywall's data) on 2026-10-14, after 19 university
// resolvers confirmed each is commonly subscribed. ScienceDirect uses the
// Journal of Alloys and Compounds rather than Cell, whose open archive frees
// every article after a year. For the same reason PNAS, ASM, Cold Spring
// Harbor and Rockefeller University Press are left out: their articles all
// open after an embargo, so none stays closed.
// `packageHint` is the word a library's own package for the platform carries
// ("Wiley Online Library All Journals"): a package without it is an
// aggregator's (ProQuest, EBSCO), and the row says so.
const NATURE_DISCOVERY = 'https://library.harvard.edu/services-tools/nature';
const IOP_DISCOVERY = Object.freeze([
  'https://vilniustech.lt/files/4859/242/12/15_0/IOPscience%20EXTRA_list%20of%20journals_2023.pdf',
  'https://stang.sc.mahidol.ac.th/pdf/subscription/IOP_titlelist2021.pdf',
]);

const HUMAN_KINETICS_DISCOVERY = Object.freeze([
  'https://ub.uni-graz.at/en/news/neu-human-kinetics-journals/',
  'https://www.humankinetics.com/AcuCustom/Sitename/DAM/169/HK_APR_catalog_US.pdf',
  'https://www.humankinetics.com/AcuCustom/Sitename/DAM/158/Human_Kinetics_2017_Product_Guide.pdf',
]);
const POLICY_PRESS_DISCOVERY = Object.freeze([
  'https://library.northsouth.edu/library-collections/online-database-journals/policy-press/',
  'https://bristoluniversitypress.co.uk/asset/12107/journals-catalogue-autumn-23.pdf',
]);
const SAGE_DISCOVERY = 'https://niepa.ac.in/download/Sage-Education%20Subject%20Collection-%20List%20of%20Journals_120_2023.pdf';
const OXFORD_LAW_DISCOVERY = 'https://scalsar.edu.in/assets/pdf/learning_resource_centre_SCALSAR.pdf';
const OXFORD_HUMANITIES_DISCOVERY = 'https://sba.unipi.it/en/open-access-e-open-science-0/elenco-delle-pubblicazioni-oa/416';

const CAMBRIDGE_ROPAR_DISCOVERY = 'https://www.iitrpr.ac.in/library/cupj.php';
const CAMBRIDGE_DISCOVERY = 'https://www.uspceu.com/Portals/0/docs/Biblioteca/recursos/Cambridge-listado-por-materias.pdf';
const CAMBRIDGE_HYDERABAD_DISCOVERY = 'https://igmlnet.uohyd.ac.in/Cambridge%20Journals/Cambridge%20Journals/Cambridge%20Journals%202022.htm';
const EMERALD_DISCOVERY = Object.freeze([
  'https://www.niser.ac.in/library/content/emerald-publishing-journals-through-onos',
  'https://www.plus.ac.at/wp-content/uploads/2023/01/Liste-Emerald.pdf',
]);
const CANADIAN_SCIENCE_DISCOVERY = Object.freeze([
  'https://library.wlu.ca/resources/databases/csp',
  'https://www.openscience.no/en/csp',
  'https://blog.cdnsciencepub.com/wp-content/uploads/2018/08/PricingCatalogue-2019.pdf',
]);

const DELHI_HUMANITIES_DISCOVERY = 'https://shivaji.du.ac.in/files/studentcorner/A-Z%20LIST.pdf';
const CHICAGO_HUMANITIES_DISCOVERY = Object.freeze([
  DELHI_HUMANITIES_DISCOVERY,
  'https://www.journals.uchicago.edu/pb-assets/docs/division/Univ-of-Chicago-Press-Jrnls-2026content-coverage-1754941306380.pdf',
]);
const DUKE_HUMANITIES_DISCOVERY = Object.freeze([
  'https://www.culibrary.ac.in/e-journals-list-2024.html',
  'https://dukeupress.edu/information-for/librarians/account-administration/title-list',
]);

const NURSING_DISCOVERY = 'https://lib.ypu.edu.tw/p/404-1021-67932.php';
const VETERINARY_DISCOVERY = 'https://bib.us.es/sites/bib3.us.es/files/jcr_2016_science.pdf';
const GEOGRAPHY_DISCOVERY = 'https://chs.nihon-u.ac.jp/library/ej-link/';
const CALCUTTA_DISCOVERY = 'https://www.culibrary.ac.in/e-journals-list-2024.html';
const INFORMS_DISCOVERY = 'https://library.iisc.ac.in/journals-informs';

export const SERVICE_CATALOGUE: readonly Readonly<ServiceEntry>[] = Object.freeze([
  { id: 'sciencedirect', packageHint: 'ScienceDirect', name: 'ScienceDirect', publisher: 'Elsevier', url: 'https://www.sciencedirect.com', monogram: 'SD', color: '#FF6C00', issn: '0925-8388', year: 2021, doi: '10.1016/j.jallcom.2021.161513' },
  { id: 'nature', packageHint: 'Nature', name: 'Nature', publisher: 'Springer Nature', url: 'https://www.nature.com', monogram: 'N', color: '#1C1C1C', issn: '0028-0836', year: 2020, doi: '10.1038/s41586-020-2782-y' },
  { id: 'springerlink', packageHint: 'SpringerLink', name: 'SpringerLink', publisher: 'Springer Nature', url: 'https://link.springer.com', monogram: 'SL', color: '#2B5E9B', issn: '0022-2461', year: 2021, doi: '10.1007/s10853-021-06462-4' },
  { id: 'wiley', packageHint: 'Wiley', name: 'Wiley Online Library', publisher: 'Wiley', url: 'https://onlinelibrary.wiley.com', monogram: 'W', color: '#1F3F77', issn: '1521-4095', year: 2021, doi: '10.1002/adma.202100824' },
  { id: 'acs', packageHint: 'American Chemical Society', name: 'ACS Publications', publisher: 'American Chemical Society', url: 'https://pubs.acs.org', monogram: 'ACS', color: '#1F4E79', issn: '0002-7863', year: 2021, doi: '10.1021/jacs.1c00601' },
  { id: 'ieee', packageHint: 'IEEE', name: 'IEEE Xplore', publisher: 'IEEE', url: 'https://ieeexplore.ieee.org', monogram: 'IEEE', color: '#00629B', issn: '0018-9219', year: 2021, doi: '10.1109/jproc.2021.3107494' },
  { id: 'tandf', packageHint: 'Taylor', name: 'Taylor & Francis Online', publisher: 'Taylor & Francis', url: 'https://www.tandfonline.com', monogram: 'T&F', color: '#0A5485', issn: '0020-7179', year: 2021, doi: '10.1080/00207179.2021.1910863' },
  { id: 'sage', packageHint: 'SAGE', name: 'SAGE Journals', publisher: 'SAGE', url: 'https://journals.sagepub.com', monogram: 'SAGE', color: '#1D6E5B', issn: '0049-1241', year: 2013, doi: '10.1177/0049124113500475' },
  { id: 'oup', packageHint: 'Oxford', name: 'Oxford Academic', publisher: 'Oxford University Press', url: 'https://academic.oup.com', monogram: 'OUP', color: '#002147', issn: '0033-5533', year: 2021, doi: '10.1093/qje/qjab022' },
  { id: 'science', packageHint: 'AAAS', name: 'Science', publisher: 'AAAS', url: 'https://www.science.org', monogram: 'Sci', color: '#B3252E', issn: '0036-8075', year: 2020, doi: '10.1126/science.abd8911' },
  { id: 'aps', packageHint: 'American Physical Society', name: 'APS Journals', publisher: 'American Physical Society', url: 'https://journals.aps.org', monogram: 'APS', color: '#1C3F74', issn: '0031-9007', year: 2021, doi: '10.1103/physrevlett.127.134301' },
  { id: 'cambridge', packageHint: 'Cambridge', name: 'Cambridge Core', publisher: 'Cambridge University Press', url: 'https://www.cambridge.org/core', monogram: 'CUP', color: '#D62E2E', issn: '0022-1120', year: 2021, doi: '10.1017/jfm.2021.143' },
  { id: 'rsc', packageHint: 'Royal Society of Chemistry', name: 'RSC Publishing', publisher: 'Royal Society of Chemistry', url: 'https://pubs.rsc.org', monogram: 'RSC', color: '#0B6E8F', issn: '1463-9076', year: 2021, doi: '10.1039/d1cp02473f' },
  { id: 'iop', packageHint: 'Institute of Physics', name: 'IOPscience', publisher: 'IOP Publishing', url: 'https://iopscience.iop.org', monogram: 'IOP', color: '#1D3C78', issn: '0953-8984', year: 2021, doi: '10.1088/1361-648x/ac1d6e' },
  { id: 'jstor', packageHint: 'JSTOR', name: 'JSTOR', publisher: 'ITHAKA', url: 'https://www.jstor.org', monogram: 'JST', color: '#990000', issn: '0003-0279', year: 2015, doi: '10.7817/jameroriesoci.135.3.453' },
  { id: 'degruyter', packageHint: 'Gruyter', name: 'De Gruyter', publisher: 'De Gruyter Brill', url: 'https://www.degruyterbrill.com', monogram: 'DG', color: '#00387A', issn: '0075-4102', year: 2021, doi: '10.1515/crelle-2020-0050' },
  { id: 'brill', packageHint: 'Brill', name: 'Brill', publisher: 'De Gruyter Brill', url: 'https://brill.com', monogram: 'B', color: '#0C3B5D', issn: '0042-4935', year: 2021, doi: '10.1163/15685330-00001116' },
  { id: 'annualreviews', packageHint: 'Annual Reviews', name: 'Annual Reviews', publisher: 'Annual Reviews', url: 'https://www.annualreviews.org', monogram: 'AR', color: '#7A1F2B', issn: '0066-4308', year: 2021, doi: '10.1146/annurev-psych-072420-122921' },
  { id: 'chicago', packageHint: 'University of Chicago', name: 'University of Chicago Press Journals', publisher: 'University of Chicago Press', url: 'https://www.journals.uchicago.edu', monogram: 'UCP', color: '#800000', issn: '0022-3808', year: 2021, doi: '10.1086/715075' },
  { id: 'mitpress', packageHint: 'MIT Press', name: 'MIT Press Direct', publisher: 'MIT Press', url: 'https://direct.mit.edu', monogram: 'MIT', color: '#1D1D1B', issn: '0899-7667', year: 2021, doi: '10.1162/neco_a_01382' },
  { id: 'aip', packageHint: 'AIP', name: 'AIP Publishing', publisher: 'AIP Publishing', url: 'https://pubs.aip.org', monogram: 'AIP', color: '#00539B', issn: '0021-9606', year: 2021, doi: '10.1063/5.0038058' },
  { id: 'optica', packageHint: 'Optica', name: 'Optica Publishing Group', publisher: 'Optica', url: 'https://opg.optica.org', monogram: 'OPG', color: '#002F5F', issn: '0146-9592', year: 2021, doi: '10.1364/ol.427142' },
  { id: 'acm', packageHint: 'ACM', name: 'ACM Digital Library', publisher: 'ACM', url: 'https://dl.acm.org', monogram: 'ACM', color: '#0085CA', issn: '0001-0782', year: 2021, doi: '10.1145/3447731' },
  { id: 'siam', packageHint: 'SIAM', name: 'SIAM Journals', publisher: 'SIAM', url: 'https://epubs.siam.org', monogram: 'SIAM', color: '#003E7E', issn: '0036-1429', year: 2021, doi: '10.1137/20m1386554' },
  { id: 'ams', packageHint: 'American Mathematical Society', name: 'AMS Journals', publisher: 'American Mathematical Society', url: 'https://www.ams.org/journals', monogram: 'AMS', color: '#1A4E8A', issn: '0894-0347', year: 2021, doi: '10.1090/jams/964' },
  { id: 'asce', packageHint: 'Civil Engineers', name: 'ASCE Library', publisher: 'ASCE', url: 'https://ascelibrary.org', monogram: 'ASCE', color: '#00467F', issn: '0733-9445', year: 2021, doi: '10.1061/(asce)st.1943-541x.0002959' },
  { id: 'asme', packageHint: 'ASME', name: 'ASME Digital Collection', publisher: 'ASME', url: 'https://asmedigitalcollection.asme.org', monogram: 'ASME', color: '#0060A9', issn: '0021-8936', year: 2021, doi: '10.1115/1.4051998' },
  { id: 'thieme', packageHint: 'Thieme', name: 'Thieme Connect', publisher: 'Thieme', url: 'https://www.thieme-connect.com', monogram: 'T', color: '#004F9F', issn: '0039-7881', year: 2021, doi: '10.1055/a-1401-4486' },
  { id: 'jama', packageHint: 'American Medical Association', name: 'JAMA Network', publisher: 'American Medical Association', url: 'https://jamanetwork.com', monogram: 'JAMA', color: '#B5121B', issn: '0098-7484', year: 2021, doi: '10.1001/jama.2021.5603' },
  { id: 'nejm', packageHint: 'New England Journal', name: 'NEJM', publisher: 'Massachusetts Medical Society', url: 'https://www.nejm.org', monogram: 'NEJM', color: '#C8102E', issn: '0028-4793', year: 2021, doi: '10.1056/nejmp2110516' },
  { id: 'karger', packageHint: 'Karger', name: 'Karger', publisher: 'Karger', url: 'https://karger.com', monogram: 'K', color: '#003C71', issn: '1018-8665', year: 2021, doi: '10.1159/000514687' },
  { id: 'aea', packageHint: 'American Economic', name: 'AEA Journals', publisher: 'American Economic Association', url: 'https://www.aeaweb.org/journals', monogram: 'AEA', color: '#1F3A60', issn: '0002-8282', year: 2021, doi: '10.1257/aer.20191204' },
  { id: 'emerald', packageHint: 'Emerald', name: 'Emerald Insight', publisher: 'Emerald Publishing', url: 'https://www.emerald.com', monogram: 'E', color: '#006A4E', issn: '0022-0418', year: 2021, doi: '10.1108/jd-11-2020-0189' },
  { id: 'apa', packageHint: 'PsycArticles', name: 'APA PsycNet', publisher: 'American Psychological Association', url: 'https://psycnet.apa.org', monogram: 'APA', color: '#2C5697', issn: '0033-295X', year: 2021, doi: '10.1037/rev0000265' },
  { id: 'aha', packageHint: 'American Heart', name: 'AHA Journals', publisher: 'American Heart Association', url: 'https://www.ahajournals.org', monogram: 'AHA', color: '#C10E21', issn: '0009-7322', year: 2021, doi: '10.1161/cir.0000000000001029' },
  { id: 'spie', packageHint: 'SPIE', name: 'SPIE Digital Library', publisher: 'SPIE', url: 'https://www.spiedigitallibrary.org', monogram: 'SPIE', color: '#0F4C81', issn: '0091-3286', year: 2021, doi: '10.1117/1.oe.60.9.094105' },
  { id: 'aacr', packageHint: 'Cancer Research', name: 'AACR Journals', publisher: 'American Association for Cancer Research', url: 'https://aacrjournals.org', monogram: 'AACR', color: '#00539F', issn: '0008-5472', year: 2021, doi: '10.1158/0008-5472.can-20-4090' },
  { id: 'biologists', packageHint: 'Company of Biologists', name: 'The Company of Biologists', publisher: 'The Company of Biologists', url: 'https://journals.biologists.com', monogram: 'CoB', color: '#00757F', issn: '0950-1991', year: 2021, doi: '10.1242/dev.199669' },
  { id: 'portland', packageHint: 'Portland', name: 'Portland Press', publisher: 'Portland Press', url: 'https://portlandpress.com', monogram: 'PP', color: '#003B5C', issn: '0264-6021', year: 2021, doi: '10.1042/bcj20210652' },
  { id: 'acp', packageHint: 'American College of Physicians', name: 'ACP Journals', publisher: 'American College of Physicians', url: 'https://www.acpjournals.org', monogram: 'ACP', color: '#002855', issn: '0003-4819', year: 2021, doi: '10.7326/aitc202105180' },
  { id: 'muse', packageHint: 'Muse', name: 'Project MUSE', publisher: 'Johns Hopkins University Press', url: 'https://muse.jhu.edu', monogram: 'MUSE', color: '#1F3A5F', issn: '1086-3222', year: 2021, doi: '10.1353/jhi.2021.0015' },
  { id: 'euclid', packageHint: 'Euclid', name: 'Project Euclid', publisher: 'Project Euclid', url: 'https://projecteuclid.org', monogram: 'PE', color: '#2B4C7E', issn: '0012-7094', year: 2021, doi: '10.1215/00127094-2020-0075' },
  { id: 'bmj', packageHint: 'BMJ', name: 'BMJ Journals', publisher: 'BMJ', url: 'https://journals.bmj.com', monogram: 'BMJ', color: '#2A6EBB', issn: '0959-8138', year: 2021, doi: '10.1136/bmj.n1811' },
  { id: 'royalsociety', packageHint: 'Royal Society', name: 'Royal Society Publishing', publisher: 'The Royal Society', url: 'https://royalsocietypublishing.org', monogram: 'RS', color: '#1D1D1B', issn: '1364-5021', year: 2021, doi: '10.1098/rspa.2021.0530' },
  { id: 'informs', packageHint: 'INFORMS', name: 'INFORMS PubsOnLine', publisher: 'INFORMS', url: 'https://pubsonline.informs.org', monogram: 'INF', color: '#00447C', issn: '0025-1909', year: 2021, doi: '10.1287/mnsc.2019.3573' },
  { id: 'worldscientific', packageHint: 'World Scientific', name: 'World Scientific', publisher: 'World Scientific', url: 'https://www.worldscientific.com', monogram: 'WS', color: '#1D4F91', issn: '0217-751X', year: 2021, doi: '10.1142/s0217751x2150127x' },
  { id: 'ametsoc', packageHint: 'Meteorological', name: 'American Meteorological Society', publisher: 'American Meteorological Society', url: 'https://journals.ametsoc.org', monogram: 'AMS', color: '#00557F', issn: '0894-8755', year: 2021, doi: '10.1175/jcli-d-19-0959.1' },
  { id: 'aiaa', packageHint: 'AIAA', name: 'Aerospace Research Central', publisher: 'AIAA', url: 'https://arc.aiaa.org', monogram: 'AIAA', color: '#003B71', issn: '0001-1452', year: 2021, doi: '10.2514/1.j059641' },
  { id: 'lyell', packageHint: 'Lyell', name: 'Lyell Collection', publisher: 'Geological Society of London', url: 'https://www.lyellcollection.org', monogram: 'GSL', color: '#005E3C', issn: '0016-7649', year: 2021, doi: '10.1144/jgs2020-174' },
  { id: 'physiology', packageHint: 'Physiological Society', name: 'American Physiological Society', publisher: 'American Physiological Society', url: 'https://journals.physiology.org', monogram: 'APS', color: '#2D5F8B', issn: '0363-6135', year: 2021, doi: '10.1152/ajpheart.00710.2020' },
  { id: 'aaa', packageHint: 'Accounting Association', name: 'AAA Publications', publisher: 'American Accounting Association', url: 'https://publications.aaahq.org', monogram: 'AAA', color: '#003865', issn: '0001-4826', year: 2021, doi: '10.2308/tar-2020-0114' },
  { id: 'aom', packageHint: 'Academy of Management', name: 'Academy of Management Journals', publisher: 'Academy of Management', url: 'https://journals.aom.org', monogram: 'AOM', color: '#00467F', issn: '0001-4273', year: 2021, doi: '10.5465/amj.2019.0627' },
  { id: 'wolterskluwer', packageHint: 'Ovid', name: 'Lippincott Journals', publisher: 'Wolters Kluwer', url: 'https://journals.lww.com', monogram: 'WK', color: '#007AC3', issn: '0003-3022', year: 2021, doi: '10.1097/aln.0000000000003900' },
  { id: 'asco', packageHint: 'Clinical Oncology', name: 'ASCO Publications', publisher: 'American Society of Clinical Oncology', url: 'https://ascopubs.org', monogram: 'ASCO', color: '#0067B1', issn: '0732-183X', year: 2021, doi: '10.1200/jco.21.00449' },
  { id: 'rsna', packageHint: 'Radiological Society', name: 'RSNA Journals', publisher: 'Radiological Society of North America', url: 'https://pubs.rsna.org', monogram: 'RSNA', color: '#1B365D', issn: '0033-8419', year: 2021, doi: '10.1148/radiol.2021204289' },
  { id: 'aap', packageHint: 'Academy of Pediatrics', name: 'AAP Publications', publisher: 'American Academy of Pediatrics', url: 'https://publications.aap.org', monogram: 'AAP', color: '#00539B', issn: '0031-4005', year: 2021, doi: '10.1542/peds.2021-052228' },
  { id: 'ada', packageHint: 'Diabetes Association', name: 'ADA Journals', publisher: 'American Diabetes Association', url: 'https://diabetesjournals.org', monogram: 'ADA', color: '#B41E2D', issn: '0149-5992', year: 2021, doi: '10.2337/dc21-1524' },
  { id: 'microbiologysociety', packageHint: 'Microbiology Society', name: 'Microbiology Society', publisher: 'Microbiology Society', url: 'https://www.microbiologyresearch.org', monogram: 'MS', color: '#00558B', issn: '1350-0872', year: 2021, doi: '10.1099/mic.0.001102' },
  { id: 'guilford', packageHint: 'Guilford', name: 'Guilford Journals', publisher: 'Guilford Press', url: 'https://guilfordjournals.com', monogram: 'G', color: '#1C3F6E', issn: '0736-7236', year: 2021, doi: '10.1521/jscp.2021.40.5.480' },
  { id: 'ucpress', packageHint: 'University of California', name: 'UC Press Journals', publisher: 'University of California Press', url: 'https://online.ucpress.edu', monogram: 'UCP', color: '#1B3D6D', issn: '0015-1386', year: 2021, doi: '10.1525/fq.2021.75.2.12' },
  { id: 'canscipub', packageHint: 'Canadian Science', name: 'Canadian Science Publishing', publisher: 'Canadian Science Publishing', url: 'https://cdnsciencepub.com', monogram: 'CSP', color: '#00447C', issn: '0008-4204', year: 2021, doi: '10.1139/cjp-2020-0598' },
  { id: 'dukeupress', packageHint: 'Duke University Press', name: 'Duke University Press Journals', publisher: 'Duke University Press', url: 'https://read.dukeupress.edu', monogram: 'DUP', color: '#00539B', issn: '0002-9831', year: 2021, doi: '10.1215/00029831-9361237' },
  { id: 'liverpoolup', packageHint: 'Liverpool', name: 'Liverpool University Press', publisher: 'Liverpool University Press', url: 'https://www.liverpooluniversitypress.co.uk', monogram: 'LUP', color: '#6E1E3B', issn: '1475-3839', year: 2021, doi: '10.3828/bhs.2021.28' },
  { id: 'edinburghup', packageHint: 'Edinburgh', name: 'Edinburgh University Press Journals', publisher: 'Edinburgh University Press', url: 'https://www.euppublishing.com', monogram: 'EUP', color: '#1D1D1B', issn: '0036-9241', year: 2021, doi: '10.3366/shr.2021.0533' },
  { id: 'brepols', packageHint: 'Brepols', name: 'Brepols Online', publisher: 'Brepols', url: 'https://www.brepolsonline.net', monogram: 'B', color: '#8B1E2B', issn: '0083-5897', year: 2021, doi: '10.1484/j.viator.5.130876' },
  { id: 'msp', packageHint: 'Mathematical Sciences Publishers', name: 'Mathematical Sciences Publishers', publisher: 'MSP', url: 'https://msp.org', monogram: 'MSP', color: '#2B4C7E', issn: '1465-3060', year: 2021, doi: '10.2140/gt.2021.25.2195' },
  // Candidates from MIT's news guide and publisher title lists (see worker/README.md).
  // No invented article DOI: these are resolved by ISSN for the last complete year.
  { kind: 'publication' as const, id: 'economist', packageHint: 'Economist', name: 'The Economist', publisher: 'The Economist Group', url: 'https://www.economist.com', monogram: 'E', color: '#E3120B', issn: '0013-0613', year: 2025 },
  { kind: 'publication' as const, id: 'financialtimes', packageHint: 'Financial Times', name: 'Financial Times', publisher: 'Financial Times', url: 'https://www.ft.com', monogram: 'FT', color: '#FFF1E5', issn: '0307-1766', year: 2025 },
  { kind: 'publication' as const, id: 'wsj', packageHint: 'Wall Street Journal', name: 'The Wall Street Journal', publisher: 'Dow Jones', url: 'https://www.wsj.com', monogram: 'WSJ', color: '#1C1C1C', issn: '0099-9660', year: 2025 },
  { kind: 'publication' as const, id: 'nytimes', packageHint: 'New York Times', name: 'The New York Times', publisher: 'The New York Times Company', url: 'https://www.nytimes.com', monogram: 'NYT', color: '#1C1C1C', issn: '0362-4331', year: 2025 },
  { kind: 'publication' as const, id: 'newyorker', packageHint: 'New Yorker', name: 'The New Yorker', publisher: 'Condé Nast', url: 'https://www.newyorker.com', monogram: 'NY', color: '#1C1C1C', issn: '0028-792X', year: 2025 },
  { kind: 'publication' as const, id: 'guardian', packageHint: 'Guardian', name: 'The Guardian', publisher: 'Guardian News & Media', url: 'https://www.theguardian.com', monogram: 'G', color: '#052962', issn: '0261-3077', year: 2025 },
  { kind: 'publication' as const, id: 'hbr', packageHint: 'Harvard Business', name: 'Harvard Business Review', publisher: 'Harvard Business Publishing', url: 'https://hbr.org', monogram: 'HBR', color: '#C8102E', issn: '0017-8012', year: 2025 },
  { kind: 'publication' as const, id: 'businessweek', packageHint: 'Bloomberg', name: 'Bloomberg Businessweek', publisher: 'Bloomberg', url: 'https://www.bloomberg.com/businessweek', monogram: 'BW', color: '#1C1C1C', issn: '0007-7135', year: 2025 },
  // PAP-71, 2026-10-20: journal candidates, not holdings. Print/electronic
  // editions share one row; the existing Nature and IOP flagship ISSNs stay
  // in their platform rows. No unverified article DOI is sent to GetFTR.
  ...[
    { name: 'Nature Chemistry', issn: '1755-4330', eissn: '1755-4349', url: 'https://www.nature.com/nchem/' },
    { name: 'Nature Materials', issn: '1476-1122', eissn: '1476-4660', url: 'https://www.nature.com/nmat/' },
    { name: 'Nature Nanotechnology', issn: '1748-3387', eissn: '1748-3395', url: 'https://www.nature.com/nnano/' },
    { name: 'Nature Biotechnology', issn: '1087-0156', eissn: '1546-1696', url: 'https://www.nature.com/nbt/' },
    { name: 'Nature Genetics', issn: '1061-4036', eissn: '1546-1718', url: 'https://www.nature.com/ng/' },
    { name: 'Nature Methods', issn: '1548-7091', eissn: '1548-7105', url: 'https://www.nature.com/nmeth/' },
    { name: 'Nature Chemical Biology', issn: '1552-4450', eissn: '1552-4469', url: 'https://www.nature.com/nchembio/' },
  ].map(journal => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'nature', packageHint: 'Nature', publisher: 'Springer Nature',
    monogram: 'N', color: '#1C1C1C', year: 2021,
    sources: Object.freeze([NATURE_DISCOVERY, journal.url]),
  })),
  ...[
    { name: 'Journal of Breath Research', issn: '1752-7155', eissn: '1752-7163' },
    { name: 'Bioinspiration & Biomimetics', issn: '1748-3182', eissn: '1748-3190' },
    { name: 'Biomedical Materials', issn: '1748-6041', eissn: '1748-605X' },
    { name: 'Biofabrication', issn: '1758-5082', eissn: '1758-5090' },
    { name: 'Journal of Physics A: Mathematical and Theoretical', issn: '1751-8113', eissn: '1751-8121' },
    { name: 'Journal of Optics', issn: '2040-8978', eissn: '2040-8986' },
    { name: 'Physiological Measurement', issn: '0967-3334', eissn: '1361-6579' },
    { name: 'Modelling and Simulation in Materials Science and Engineering', issn: '0965-0393', eissn: '1361-651X' },
    { name: 'Smart Materials and Structures', issn: '0964-1726', eissn: '1361-665X' },
    { name: 'Plasma Sources Science and Technology', issn: '0963-0252', eissn: '1361-6595' },
    { name: 'Journal of Micromechanics and Microengineering', issn: '0960-1317', eissn: '1361-6439' },
    { name: 'Nanotechnology', issn: '0957-4484', eissn: '1361-6528' },
    { name: 'Measurement Science and Technology', issn: '0957-0233', eissn: '1361-6501' },
    { name: 'Superconductor Science and Technology', issn: '0953-2048', eissn: '1361-6668' },
    { name: 'Journal of Physics B: Atomic, Molecular and Optical Physics', issn: '0953-4075', eissn: '1361-6455' },
    { name: 'Journal of Radiological Protection', issn: '0952-4746', eissn: '1361-6498' },
    { name: 'Nonlinearity', issn: '0951-7715', eissn: '1361-6544' },
    { name: 'Plasma Physics and Controlled Fusion', issn: '0741-3335', eissn: '1361-6587' },
    { name: 'Semiconductor Science and Technology', issn: '0268-1242', eissn: '1361-6641' },
    { name: 'Inverse Problems', issn: '0266-5611', eissn: '1361-6420' },
    { name: 'Classical and Quantum Gravity', issn: '0264-9381', eissn: '1361-6382' },
    { name: 'European Journal of Physics', issn: '0143-0807', eissn: '1361-6404' },
  ].map(journal => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'iop', packageHint: 'Institute of Physics', publisher: 'IOP Publishing',
    url: `https://iopscience.iop.org/journal/${journal.eissn}`,
    monogram: 'IOP', color: '#1D3C78', year: 2021, sources: IOP_DISCOVERY,
  })),
  // Broaden the journal samples beyond Nature/IOP; university lists identify
  // candidates, while the resolver still decides access to the archived year.
  ...[
    { name: 'Adapted Physical Activity Quarterly', issn: '0736-5829', eissn: '1543-2777', url: 'https://journals.humankinetics.com/view/journals/apaq/apaq-overview.xml' },
    { name: 'Journal of Teaching in Physical Education', issn: '0273-5024', eissn: '1543-2769', url: 'https://journals.humankinetics.com/view/journals/jtpe/jtpe-overview.xml' },
    { name: 'International Sport Coaching Journal', issn: '2328-918X', eissn: '2328-9198', url: 'https://journals.humankinetics.com/view/journals/iscj/iscj-overview.xml' },
    { name: 'Kinesiology Review', issn: '2163-0453', eissn: '2161-6035', url: 'https://journals.humankinetics.com/view/journals/krj/krj-overview.xml' },
    { name: 'Sport History Review', issn: '1087-1659', eissn: '1543-2947', url: 'https://journals.humankinetics.com/view/journals/shr/shr-overview.xml' },
    { name: 'Journal of Sport and Exercise Psychology', issn: '0895-2779', eissn: '1543-2904', url: 'https://journals.humankinetics.com/view/journals/jsep/jsep-overview.xml' },
  ].map(journal => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'humankinetics', packageHint: 'Human Kinetics', publisher: 'Human Kinetics',
    monogram: 'HK', color: '#1D1D1B', year: 2021, sources: HUMAN_KINETICS_DISCOVERY,
  })),
  ...[
    { name: 'Policy & Politics', issn: '0305-5736', eissn: '1470-8442', url: 'https://bristoluniversitypress.co.uk/journals/policy-and-politics' },
    { name: 'Evidence & Policy', issn: '1744-2648', eissn: '1744-2656', url: 'https://bristoluniversitypress.co.uk/journals/evidence-and-policy' },
    { name: 'Journal of Poverty and Social Justice', issn: '1759-8273', eissn: '1759-8281', url: 'https://bristoluniversitypress.co.uk/journals/journal-of-poverty-and-social-justice' },
    { name: 'Voluntary Sector Review', issn: '2040-8056', eissn: '2040-8064', url: 'https://bristoluniversitypress.co.uk/journals/voluntary-sector-review' },
    { name: 'Families, Relationships and Societies', issn: '2046-7435', eissn: '2046-7443', url: 'https://bristoluniversitypress.co.uk/journals/families-relationships-and-societies' },
    { name: 'Critical and Radical Social Work', issn: '2049-8608', eissn: '2049-8675', url: 'https://bristoluniversitypress.co.uk/journals/critical-and-radical-social-work' },
  ].map(journal => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'bristol', packageHint: 'Policy Press', publisher: 'Policy Press',
    monogram: 'PP', color: '#1D1D1B', year: 2021, sources: POLICY_PRESS_DISCOVERY,
  })),
  ...[
    { name: 'American Educational Research Journal', issn: '0002-8312', eissn: '1935-1011', url: 'https://journals.sagepub.com/loi/AER' },
    { name: 'Review of Educational Research', issn: '0034-6543', eissn: '1935-1046', url: 'https://journals.sagepub.com/loi/RER' },
    { name: 'Journal of Learning Disabilities', issn: '0022-2194', eissn: '1538-4780', url: 'https://journals.sagepub.com/loi/LDX' },
    { name: 'Educational Policy', issn: '0895-9048', eissn: '1552-3896', url: 'https://journals.sagepub.com/loi/EPX' },
    { name: 'Urban Education', issn: '0042-0859', eissn: '1552-8340', url: 'https://journals.sagepub.com/loi/UEX' },
    { name: 'Journal of Teacher Education', issn: '0022-4871', eissn: '1552-7816', url: 'https://journals.sagepub.com/loi/JTE' },
  ].map(journal => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'sage', packageHint: 'SAGE', publisher: 'SAGE',
    monogram: 'SAGE', color: '#1D6E5B', year: 2021, sources: Object.freeze([SAGE_DISCOVERY, journal.url]),
  })),
  ...[
    { name: 'Oxford Journal of Legal Studies', issn: '0143-6503', eissn: '1464-3820', url: 'https://academic.oup.com/ojls', sources: Object.freeze([OXFORD_LAW_DISCOVERY, 'https://academic.oup.com/ojls']) },
    { name: 'Human Rights Law Review', issn: '1461-7781', eissn: '1744-1021', url: 'https://academic.oup.com/hrlr', sources: Object.freeze([OXFORD_LAW_DISCOVERY, 'https://academic.oup.com/hrlr']) },
    { name: 'International Journal of Constitutional Law', issn: '1474-2640', eissn: '1474-2659', url: 'https://academic.oup.com/icon', sources: Object.freeze([OXFORD_LAW_DISCOVERY, 'https://academic.oup.com/icon']) },
    { name: 'History Workshop Journal', issn: '1363-3554', eissn: '1477-4569', url: 'https://academic.oup.com/hwj', sources: Object.freeze([OXFORD_HUMANITIES_DISCOVERY, 'https://academic.oup.com/hwj']) },
    { name: 'Oxford Art Journal', issn: '0142-6540', eissn: '1741-7287', url: 'https://academic.oup.com/oaj', sources: Object.freeze([OXFORD_HUMANITIES_DISCOVERY, 'https://academic.oup.com/oaj']) },
    { name: 'Applied Linguistics', issn: '0142-6001', eissn: '1477-450X', url: 'https://academic.oup.com/applij', sources: Object.freeze([OXFORD_HUMANITIES_DISCOVERY, 'https://academic.oup.com/applij']) },
  ].map(journal => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'oup', packageHint: 'Oxford', publisher: 'Oxford University Press',
    monogram: 'OUP', color: '#002147', year: 2021,
  })),
  // Agriculture, archaeology, applied management and environmental sciences
  // remain thinly sampled. These archived-year probes share existing groups.
  ...[
    { name: 'The Journal of Agricultural Science', issn: '0021-8596', eissn: '1469-5146', url: 'https://www.cambridge.org/core/journals/journal-of-agricultural-science', discovery: CAMBRIDGE_DISCOVERY },
    { name: 'Journal of Dairy Research', issn: '0022-0299', eissn: '1469-7629', url: 'https://www.cambridge.org/core/journals/journal-of-dairy-research', discovery: CAMBRIDGE_DISCOVERY },
    { name: 'Antiquity', issn: '0003-598X', eissn: '1745-1744', url: 'https://www.cambridge.org/core/journals/antiquity', discovery: CAMBRIDGE_HYDERABAD_DISCOVERY },
    { name: 'Latin American Antiquity', issn: '1045-6635', eissn: '2325-5080', url: 'https://www.cambridge.org/core/journals/latin-american-antiquity', discovery: CAMBRIDGE_HYDERABAD_DISCOVERY },
    { name: 'Religious Studies', issn: '0034-4125', eissn: '1469-901X', url: 'https://www.cambridge.org/core/journals/religious-studies', discovery: CAMBRIDGE_HYDERABAD_DISCOVERY },
    { name: 'Journal of Linguistics', issn: '0022-2267', eissn: '1469-7742', url: 'https://www.cambridge.org/core/journals/journal-of-linguistics', discovery: CAMBRIDGE_HYDERABAD_DISCOVERY },
  ].map(({ discovery, ...journal }) => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'cambridge', packageHint: 'Cambridge', publisher: 'Cambridge University Press',
    monogram: 'CUP', color: '#D62E2E', year: 2021,
    sources: Object.freeze([discovery, journal.url]),
  })),
  ...[
    { name: 'Agricultural Finance Review', issn: '0002-1466', eissn: '2041-6326', url: 'https://www.emeraldgrouppublishing.com/journal/afr' },
    { name: 'British Food Journal', issn: '0007-070X', eissn: '1758-4108', url: 'https://www.emeraldgrouppublishing.com/journal/bfj' },
    { name: 'Supply Chain Management: An International Journal', issn: '1359-8546', eissn: '1758-6852', url: 'https://www.emeraldgrouppublishing.com/journal/scm' },
    { name: 'International Journal of Contemporary Hospitality Management', issn: '0959-6119', eissn: '1757-1049', url: 'https://www.emeraldgrouppublishing.com/journal/ijchm' },
    { name: 'Disaster Prevention and Management: An International Journal', issn: '0965-3562', eissn: '1758-6100', url: 'https://www.emeraldgrouppublishing.com/journal/dpm' },
    { name: 'Records Management Journal', issn: '0956-5698', eissn: '1758-7689', url: 'https://www.emeraldgrouppublishing.com/journal/rmj' },
  ].map(journal => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'emerald', packageHint: 'Emerald', publisher: 'Emerald Publishing',
    monogram: 'E', color: '#006A4E', year: 2021,
    sources: Object.freeze([...EMERALD_DISCOVERY, journal.url]),
  })),
  ...[
    { name: 'Canadian Journal of Forest Research', issn: '0045-5067', eissn: '1208-6037', url: 'https://cdnsciencepub.com/journal/cjfr' },
    { name: 'Canadian Journal of Fisheries and Aquatic Sciences', issn: '0706-652X', eissn: '1205-7533', url: 'https://cdnsciencepub.com/journal/cjfas' },
    { name: 'Canadian Journal of Earth Sciences', issn: '0008-4077', eissn: '1480-3313', url: 'https://cdnsciencepub.com/journal/cjes' },
    { name: 'Canadian Geotechnical Journal', issn: '0008-3674', eissn: '1208-6010', url: 'https://cdnsciencepub.com/journal/cgj' },
    { name: 'Botany', issn: '1916-2790', eissn: '1916-2804', url: 'https://cdnsciencepub.com/journal/cjb' },
    { name: 'Canadian Journal of Zoology', issn: '0008-4301', eissn: '1480-3283', url: 'https://cdnsciencepub.com/journal/cjz' },
  ].map(journal => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'canscipub', packageHint: 'Canadian Science', publisher: 'Canadian Science Publishing',
    monogram: 'CSP', color: '#00447C', year: 2021,
    sources: Object.freeze([...CANADIAN_SCIENCE_DISCOVERY, journal.url]),
  })),
  ...[
    { name: 'Current Anthropology', issn: '0011-3204', eissn: '1537-5382', url: 'https://www.journals.uchicago.edu/toc/ca/current' },
    { name: 'Ethics', issn: '0014-1704', eissn: '1539-297X', url: 'https://www.journals.uchicago.edu/toc/et/current' },
    { name: 'Signs: Journal of Women in Culture and Society', issn: '0097-9740', eissn: '1545-6943', url: 'https://www.journals.uchicago.edu/toc/signs/current' },
    { name: 'Critical Inquiry', issn: '0093-1896', eissn: '1539-7858', url: 'https://www.journals.uchicago.edu/toc/ci/current' },
    { name: 'American Journal of Sociology', issn: '0002-9602', eissn: '1537-5390', url: 'https://www.journals.uchicago.edu/toc/ajs/current' },
  ].map(journal => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'chicago', packageHint: 'University of Chicago', publisher: 'University of Chicago Press',
    monogram: 'UCP', color: '#800000', year: 2021, sources: CHICAGO_HUMANITIES_DISCOVERY,
  })),
  ...[
    { name: 'Music Perception', issn: '0730-7829', eissn: '1533-8312', url: 'https://online.ucpress.edu/mp', discovery: 'https://libraryguides.helsinki.fi/musicology/articles-journals' },
    { name: 'Journal of Musicology', issn: '0277-9269', eissn: '1533-8347', url: 'https://online.ucpress.edu/jm', discovery: DELHI_HUMANITIES_DISCOVERY },
    { name: '19th-Century Music', issn: '0148-2076', eissn: '1533-8606', url: 'https://online.ucpress.edu/ncm', discovery: DELHI_HUMANITIES_DISCOVERY },
    { name: 'Journal of the Society of Architectural Historians', issn: '0037-9808', eissn: '2150-5926', url: 'https://online.ucpress.edu/jsah', discovery: DELHI_HUMANITIES_DISCOVERY },
    { name: 'Gastronomica', issn: '1529-3262', eissn: '1533-8622', url: 'https://online.ucpress.edu/gastronomica', discovery: DELHI_HUMANITIES_DISCOVERY },
  ].map(({ discovery, ...journal }) => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'ucpress', packageHint: 'University of California', publisher: 'University of California Press',
    monogram: 'UCP', color: '#1B3D6D', year: 2021,
    sources: Object.freeze([discovery, journal.url]),
  })),
  ...[
    { name: 'Ethnohistory', issn: '0014-1801', eissn: '1527-5477', url: 'https://read.dukeupress.edu/ethnohistory' },
    { name: 'Public Culture', issn: '0899-2363', eissn: '1527-8018', url: 'https://read.dukeupress.edu/public-culture' },
    { name: 'GLQ: A Journal of Lesbian and Gay Studies', issn: '1064-2684', eissn: '1527-9375', url: 'https://read.dukeupress.edu/glq' },
    { name: "Journal of Middle East Women's Studies", issn: '1552-5864', eissn: '1558-9579', url: 'https://read.dukeupress.edu/jmews' },
    { name: 'Theater', issn: '0161-0775', eissn: '1527-196X', url: 'https://read.dukeupress.edu/theater' },
  ].map(journal => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'dukeupress', packageHint: 'Duke University Press', publisher: 'Duke University Press',
    monogram: 'DUP', color: '#00539B', year: 2021, sources: DUKE_HUMANITIES_DISCOVERY,
  })),
  ...[
    { name: 'The Cambridge Law Journal', issn: '0008-1973', eissn: '1469-2139', url: 'https://www.cambridge.org/core/journals/cambridge-law-journal' },
    { name: 'Legal Theory', issn: '1352-3252', eissn: '1469-8048', url: 'https://www.cambridge.org/core/journals/legal-theory' },
    { name: 'American Political Science Review', issn: '0003-0554', eissn: '1537-5943', url: 'https://www.cambridge.org/core/journals/american-political-science-review' },
    { name: 'British Journal of Political Science', issn: '0007-1234', eissn: '1469-2112', url: 'https://www.cambridge.org/core/journals/british-journal-of-political-science' },
    { name: 'International Organization', issn: '0020-8183', eissn: '1531-5088', url: 'https://www.cambridge.org/core/journals/international-organization' },
    { name: 'Econometric Theory', issn: '0266-4666', eissn: '1469-4360', url: 'https://www.cambridge.org/core/journals/econometric-theory' },
    { name: 'Philosophy', issn: '0031-8191', eissn: '1469-817X', url: 'https://www.cambridge.org/core/journals/philosophy' },
    { name: 'Utilitas', issn: '0953-8208', eissn: '1741-6183', url: 'https://www.cambridge.org/core/journals/utilitas' },
    { name: 'Canadian Journal of Philosophy', issn: '0045-5091', eissn: '1911-0820', url: 'https://www.cambridge.org/core/journals/canadian-journal-of-philosophy' },
    { name: 'Victorian Literature and Culture', issn: '1060-1503', eissn: '1470-1553', url: 'https://www.cambridge.org/core/journals/victorian-literature-and-culture' },
  ].map(journal => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'cambridge', packageHint: 'Cambridge', publisher: 'Cambridge University Press',
    monogram: 'CUP', color: '#D62E2E', year: 2021,
    sources: Object.freeze([CAMBRIDGE_ROPAR_DISCOVERY, journal.url]),
  })),
  ...[
    { name: 'The Journal of Legal Studies', issn: '0047-2530', eissn: '1537-5366', url: 'https://www.journals.uchicago.edu/toc/jls/current' },
    { name: 'The Journal of Law and Economics', issn: '0022-2186', eissn: '1537-5285', url: 'https://www.journals.uchicago.edu/toc/jle/current' },
    { name: 'The Journal of Politics', issn: '0022-3816', eissn: '1468-2508', url: 'https://www.journals.uchicago.edu/toc/jop/current' },
    { name: 'Journal of Labor Economics', issn: '0734-306X', eissn: '1537-5307', url: 'https://www.journals.uchicago.edu/toc/jole/current' },
    { name: 'Economic Development and Cultural Change', issn: '0013-0079', eissn: '1539-2988', url: 'https://www.journals.uchicago.edu/toc/edcc/current' },
    { name: 'National Tax Journal', issn: '0028-0283', eissn: '1944-7477', url: 'https://www.journals.uchicago.edu/toc/ntj/current' },
    { name: 'The British Journal for the Philosophy of Science', issn: '0007-0882', eissn: '1464-3537', url: 'https://www.journals.uchicago.edu/toc/bjps/current' },
    { name: 'Modern Philology', issn: '0026-8232', eissn: '1545-6951', url: 'https://www.journals.uchicago.edu/toc/mp/current' },
    { name: 'English Literary Renaissance', issn: '0013-8312', eissn: '1475-6757', url: 'https://www.journals.uchicago.edu/toc/elr/current' },
    { name: 'Classical Philology', issn: '0009-837X', eissn: '1546-072X', url: 'https://www.journals.uchicago.edu/toc/cp/current' },
  ].map(journal => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'chicago', packageHint: 'University of Chicago', publisher: 'University of Chicago Press',
    monogram: 'UCP', color: '#800000', year: 2021, sources: CHICAGO_HUMANITIES_DISCOVERY,
  })),
  ...[
    { name: 'Journal of Advanced Nursing', issn: '0309-2402', eissn: '1365-2648', url: 'https://onlinelibrary.wiley.com/journal/13652648', discovery: NURSING_DISCOVERY },
    { name: 'Journal of Clinical Nursing', issn: '0962-1067', eissn: '1365-2702', url: 'https://onlinelibrary.wiley.com/journal/13652702', discovery: NURSING_DISCOVERY },
    { name: 'Research in Nursing & Health', issn: '0160-6891', eissn: '1098-240X', url: 'https://onlinelibrary.wiley.com/journal/1098240X', discovery: NURSING_DISCOVERY },
    { name: 'Veterinary Surgery', issn: '0161-3499', eissn: '1532-950X', url: 'https://onlinelibrary.wiley.com/journal/1532950X', discovery: VETERINARY_DISCOVERY },
    { name: 'Journal of Veterinary Pharmacology and Therapeutics', issn: '0140-7783', eissn: '1365-2885', url: 'https://onlinelibrary.wiley.com/journal/13652885', discovery: VETERINARY_DISCOVERY },
    { name: 'Journal of Animal Physiology and Animal Nutrition', issn: '0931-2439', eissn: '1439-0396', url: 'https://onlinelibrary.wiley.com/journal/14390396', discovery: VETERINARY_DISCOVERY },
  ].map(({ discovery, ...journal }) => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'wiley', packageHint: 'Wiley', publisher: 'Wiley',
    monogram: 'W', color: '#1F3F77', year: 2021,
    sources: Object.freeze([discovery, journal.url]),
  })),
  ...[
    { name: 'Urban Geography', issn: '0272-3638', eissn: '1938-2847', url: 'https://www.tandfonline.com/journals/rurb20', discovery: GEOGRAPHY_DISCOVERY },
    { name: 'Regional Studies', issn: '0034-3404', eissn: '1360-0591', url: 'https://www.tandfonline.com/journals/cres20', discovery: CALCUTTA_DISCOVERY },
    { name: 'Journal of the American Planning Association', issn: '0194-4363', eissn: '1939-0130', url: 'https://www.tandfonline.com/journals/rjpa20', discovery: CALCUTTA_DISCOVERY },
    { name: 'Housing Studies', issn: '0267-3037', eissn: '1466-1810', url: 'https://www.tandfonline.com/journals/chos20', discovery: CALCUTTA_DISCOVERY },
    { name: 'Transport Reviews', issn: '0144-1647', eissn: '1464-5327', url: 'https://www.tandfonline.com/journals/ttrv20', discovery: CALCUTTA_DISCOVERY },
    { name: 'Cartography and Geographic Information Science', issn: '1523-0406', eissn: '1545-0465', url: 'https://www.tandfonline.com/journals/tcag20', discovery: GEOGRAPHY_DISCOVERY },
  ].map(({ discovery, ...journal }) => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'tandf', packageHint: 'Taylor', publisher: 'Taylor & Francis',
    monogram: 'T&F', color: '#0A5485', year: 2021,
    sources: Object.freeze([discovery, journal.url]),
  })),
  ...[
    { name: 'Operations Research', issn: '0030-364X', eissn: '1526-5463', code: 'opre', discovery: `${INFORMS_DISCOVERY}?page=1` },
    { name: 'Mathematics of Operations Research', issn: '0364-765X', eissn: '1526-5471', code: 'moor', discovery: `${INFORMS_DISCOVERY}?page=1` },
    { name: 'Transportation Science', issn: '0041-1655', eissn: '1526-5447', code: 'trsc', discovery: `${INFORMS_DISCOVERY}?page=1` },
    { name: 'Manufacturing & Service Operations Management', issn: '1523-4614', eissn: '1526-5498', code: 'msom', discovery: INFORMS_DISCOVERY },
    { name: 'INFORMS Journal on Computing', issn: '1091-9856', eissn: '1526-5528', code: 'ijoc', discovery: INFORMS_DISCOVERY },
    { name: 'Marketing Science', issn: '0732-2399', eissn: '1526-548X', code: 'mksc', discovery: INFORMS_DISCOVERY },
  ].map(({ code, discovery, ...journal }) => ({
    ...journal, kind: 'journal' as const, id: `journal-${journal.issn}`,
    platformId: 'informs', packageHint: 'INFORMS', publisher: 'INFORMS',
    url: `https://pubsonline.informs.org/journal/${code}`,
    monogram: 'INF', color: '#00447C', year: 2021,
    sources: Object.freeze([discovery, `https://pubsonline.informs.org/page/${code}/prices-and-ordering`]),
  })),
].map(entry => Object.freeze({ kind: 'platform' as const, ...entry })));

export async function handleInstitutionServices(request: Request, env: WorkerEnv) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  const query = readInstitutionQuery(url.searchParams);
  const store = env.INSTITUTION_SERVICES_STORE;
  // Logged by the router and answered as an outage: without the store every
  // request would read the library from the start and never finish it.
  if (!store) throw new Error('INSTITUTION_SERVICES_STORE binding is missing');
  const payload = await lookupInstitutionServices(query, { env, store });
  // The store is the cache. A request that left entries unanswered is asked
  // again at once, so no cache may hand it back.
  return json(payload, 200, { ...corsHeaders(origin, env), 'cache-control': 'no-store' });
}

/**
 * The store key of a library's verdicts: the parameters its probes are sent
 * with (`upstreamParams`, so every mail domain of a university shares one
 * record, and the ids only once GetFTR gets them) and how the resolver's
 * answers are read. Hashed: an entityId alone may run to 300 characters,
 * and a KV key to 512 bytes.
 */
export async function servicesStoreKey(query: InstitutionQuery, env: WorkerEnv) {
  const params = { ...upstreamParams(query, env), reading: RESOLVER_READING };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(params)));
  return `services:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * What a stored verdict answers for: the entry, what its probe asked (ISSN,
 * year, DOI) and how the answer was read (`packageHint` decides
 * `ownPlatform`). A changed probe is a new entry; a renamed or recoloured one
 * keeps its verdict, since the catalogue supplies what is displayed.
 */
export function probeKey(entry: ServiceEntry) {
  return [entry.id, entry.issn, entry.year, entry.doi || '', entry.packageHint].join('|');
}

/** Whether a package name is the platform's or its publisher's own. */
function namesPlatform(packageName: unknown, entry: ServiceEntry) {
  return String(packageName || '').toLowerCase().includes(entry.packageHint.toLowerCase());
}

/**
 * The library's resolver on one platform's flagship journal:
 * `{ collection, ownPlatform }` when it subscribes, null when it does not.
 * Throws when the resolver could not answer, so the caller can report the
 * list as partial.
 */
async function probeResolver(entry: ServiceEntry, resolver: InstitutionResolver, fetchImpl: typeof fetch, signal: AbortSignal) {
  const answer = await askResolver(resolver, { issn: entry.issn, year: entry.year }, fetchImpl, signal);
  if (!answer) throw new Error('unreadable resolver answer');
  // A free service is open access, which says nothing about the library. Among
  // the paid ones, the publisher's own package outranks an aggregator's: the
  // USAL lists Nature under a ProQuest collection before its "Nature" package,
  // and the row should name the package that is really the platform. SFX marks
  // no service free, only names its free collections; a service it does not
  // name free counts here because every catalogue journal is a subscription
  // journal (including archived subscription years). The per-paper
  // answer asks about the article itself. New journal and press titles have no
  // probe article; The Guardian, free on the web, came back from TUM and LMU only
  // through PressReader, Gale and Nexis Uni (2026-10-20).
  const paid = answer.services.filter(service => service.url && !service.free);
  const own = paid.find(service => namesPlatform(service.name, entry));
  const subscription = own || paid[0];
  if (subscription) return {
    collection: subscription.name,
    ownPlatform: Boolean(own),
    // Journal and press titles may only be available through an aggregator, whose library
    // link must be used instead of sending the reader to the publisher paywall.
    ...(!entry.doi ? { accessUrl: libraryLink(resolver, subscription.url!) } : {}),
  };
  // A service hidden by an IP or group filter is one this probe cannot see:
  // the platform is unchecked, not absent.
  return answer.restricted ? UNCHECKED : null;
}

/**
 * GetFTR on the undecided entries with DOIs, a batch per request. Fills
 * `outcomes` with `{ collection: null, ownPlatform: true }`, null, or leaves
 * a platform undefined for the resolver to decide (GetFTR's `maybe`, a
 * publisher outside it) — UNCHECKED when there is no resolver to ask. A
 * request that fails leaves its platforms to the resolver too, or FAILED
 * without one.
 */
async function askGetFtrForCatalogue(entries: readonly ServiceEntry[], outcomes: ServiceOutcome[], { resolver, entityId, rorId, env, fetchImpl, signal }: Pick<InstitutionQuery, 'entityId' | 'rorId'> & { resolver: InstitutionResolver | null | undefined; env: WorkerEnv; fetchImpl: typeof fetch; signal: AbortSignal }) {
  const candidates = entries.flatMap((entry, index) => entry.doi && outcomes[index] === undefined ? [{ index, doi: entry.doi }] : []);
  const batches = [];
  for (let start = 0; start < candidates.length; start += GETFTR_BATCH_SIZE) {
    batches.push(candidates.slice(start, start + GETFTR_BATCH_SIZE));
  }
  await Promise.all(batches.map(async (batch) => {
    let verdicts = null;
    try {
      verdicts = await askGetFtrBatch({ dois: batch.map(({ doi }) => doi), entityId, rorId }, env, fetchImpl, signal);
    } catch {
      // Left null: the resolver takes the batch, or it counts as failed.
    }
    for (const { index, doi } of batch) {
      const verdict = verdicts ? verdicts.get(doi) : null;
      if (verdict) outcomes[index] = verdict.status === 'entitled' ? { collection: null, ownPlatform: true } : null;
      else if (resolver) outcomes[index] = undefined;
      else outcomes[index] = verdicts ? UNCHECKED : FAILED;
    }
  }));
}

/**
 * The library's list from its stored verdicts, probing the entries that have
 * none. `remaining` counts the entries no probe started for before the window
 * closed: the caller asks again, and the next request goes on from the store.
 * Two requests for one library at once probe the same entries and the later
 * write wins; its verdicts are the same, so nothing is lost but the probes.
 * Without a store (tests), nothing is remembered between requests.
 */
export async function lookupInstitutionServices(
  { domain, entityId = null, rorId = null }: InstitutionQuery,
  { fetchImpl = (...args) => fetch(...args), env = {}, now = Date.now, store }: LookupOptions & { store?: ServicesStore } = {},
) {
  const resolver = findResolver({ domain, rorId });
  const getFtr = Boolean(env.GETFTR_API_KEY) && Boolean(entityId || rorId);
  if (!resolver && !getFtr) throw new InstitutionAccessError('INSTITUTION_NOT_SUPPORTED', 404);
  const key = await servicesStoreKey({ domain, entityId, rorId }, env);
  const stored: StoredVerdicts = (store && await store.get<StoredVerdicts>(key, 'json')) || {};
  const startedAt = now();
  const signal = AbortSignal.timeout(SERVICES_DEADLINE_MS);

  // What the store answers; `undefined` is an entry still to be asked about
  // (filled: a hole would be skipped by the iteration below).
  const outcomes: ServiceOutcome[] = SERVICE_CATALOGUE.map((entry) => {
    const known = stored[probeKey(entry)];
    if (!known || startedAt - known.at >= VERDICT_TTL_MS) return undefined;
    return known.verdict === 'unchecked' ? UNCHECKED : known.verdict;
  });
  const probing = new Set(outcomes.flatMap((outcome, index) => (outcome === undefined ? [index] : [])));
  if (getFtr) {
    await askGetFtrForCatalogue(SERVICE_CATALOGUE, outcomes, { resolver, entityId, rorId, env, fetchImpl, signal });
  }

  // The resolver, one journal per request, for what is still undecided, in
  // catalogue order, so the platforms most libraries hold are asked about
  // first. The window opens with the resolver's probes, so the time GetFTR
  // took does not shorten the request: what the deadline then cuts is
  // partial, what the window leaves unstarted is remaining.
  const pending = outcomes.flatMap((outcome, index) => (outcome === undefined ? [index] : []));
  if (resolver) {
    let next = 0;
    const windowOpenedAt = now();
    const drain = async () => {
      while (next < pending.length && now() - windowOpenedAt < SERVICES_START_WINDOW_MS) {
        const index = pending[next++];
        outcomes[index] = await probeResolver(SERVICE_CATALOGUE[index], resolver, fetchImpl, signal).catch(() => FAILED);
      }
    };
    await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, drain));
  } else {
    for (const index of pending) outcomes[index] = UNCHECKED;
  }

  // Every probe made failed and the store answered nothing: an outage, not
  // an empty library. With a list in hand, failed probes make it partial.
  const asked = [...probing].map(index => outcomes[index]).filter(outcome => outcome !== undefined && outcome !== UNCHECKED);
  const remembered = outcomes.some((outcome, index) => outcome !== undefined && !probing.has(index));
  if (asked.length > 0 && asked.every(outcome => outcome === FAILED) && !remembered) {
    throw new InstitutionAccessError('ACCESS_LOOKUP_UNAVAILABLE', 502);
  }

  if (store) {
    const record: StoredVerdicts = {};
    let learned = false;
    SERVICE_CATALOGUE.forEach((entry, index) => {
      const outcome = outcomes[index];
      if (outcome === undefined || outcome === FAILED) return;
      const id = probeKey(entry);
      if (probing.has(index)) {
        record[id] = { at: startedAt, verdict: outcome === UNCHECKED ? 'unchecked' : outcome };
        learned = true;
      } else {
        record[id] = stored[id];
      }
    });
    // Entries no longer in the catalogue are left out. A write that fails
    // costs the next request these probes again; the answer stands.
    if (learned) {
      await store.put(key, JSON.stringify(record), { expirationTtl: STORE_RECORD_TTL_SECONDS })
        .catch(error => console.error('Institution services store write failed', error));
    }
  }

  const services: Array<Pick<ServiceEntry, 'id' | 'name' | 'publisher' | 'url' | 'monogram' | 'color' | 'platformId'> & ServiceSubscription> = [];
  SERVICE_CATALOGUE.forEach(({ id, name, publisher, url, monogram, color, platformId }, index) => {
    const outcome = outcomes[index];
    if (outcome && outcome !== FAILED && outcome !== UNCHECKED) {
      services.push({ id, name, publisher, url: outcome.accessUrl || url, monogram, color, collection: outcome.collection, ownPlatform: outcome.ownPlatform, ...(platformId ? { platformId } : {}) });
    }
  });
  return {
    services,
    partial: outcomes.includes(FAILED),
    unchecked: outcomes.filter(outcome => outcome === UNCHECKED).length,
    remaining: outcomes.filter(outcome => outcome === undefined).length,
    checkedAt: new Date(now()).toISOString(),
  };
}
