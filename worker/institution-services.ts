import type { WorkerEnv } from './env.ts';
import type { InstitutionQuery, InstitutionResolver, LookupOptions } from './institution-access.ts';

interface ServiceEntry {
  id: string; packageHint: string; name: string; publisher: string; url: string;
  monogram: string; color: string; issn: string; year: number; doi?: string;
}
type ServiceSubscription = { collection: string | null | undefined; ownPlatform: boolean; accessUrl?: string };
type ServiceOutcome = ServiceSubscription | null | undefined | typeof FAILED | typeof UNCHECKED;


/**
 * Publications and publisher platforms found through the library.
 *
 * Each platform in the catalogue is probed with the same providers, in the
 * same order, as `/access`: GetFTR when a paywalled probe DOI is available,
 * then the library's link resolver with the ISSN and year of one of its
 * journals. The catalogue already knows the journal, so Crossref is not asked.
 * A platform is listed when its probe is entitled; the list describes the
 * library and is informative only, the per-paper answer stays with `/access`.
 */

import {
  ACCESS_CACHE_SECONDS,
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

import { cacheResponse } from './provider-runtime.ts';

export const INSTITUTION_SERVICES_PATH = '/institution/services';
const SERVICES_PARTIAL_CACHE_SECONDS = 60 * 60;

// Each page must finish before the browser's 15 s request deadline.
// Timeouts remain partial results rather than evidence of absent access.
const SERVICES_DEADLINE_MS = 12000;
const PROBE_CONCURRENCY = 4;
// How many requests one lookup may send upstream. A Worker invocation on the
// free plan may make 50 subrequests, and the route spends a handful around
// this lookup (the identity check, the edge cache); the 66-platform
// catalogue blew through it on 2026-10-14 and every USAL list came back 502.
// GetFTR takes twenty DOIs per request, so with a key the whole catalogue is
// a few requests; the resolver answers one journal per request, so without a
// key the platforms past the budget are reported as unchecked, not absent.
export const SUBREQUEST_BUDGET = 40;
// Leaves room for two GetFTR batches even when every DOI needs a resolver fallback.
const SERVICES_PAGE_SIZE = 36;
// No probe starts later than this after a page's first resolver probe, so the
// slowest one in flight still has half the deadline when GetFTR was quick, and
// the page ends at the first platform not yet asked about, where the next page
// begins. TUM's SFX took about 1.3 s a probe: 36 at four at a time ran into the
// deadline on 2026-10-20, and every retry of the list probed the same first
// titles and lost the same last ones.
const SERVICES_START_WINDOW_MS = 6000;
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
  { id: 'economist', packageHint: 'Economist', name: 'The Economist', publisher: 'The Economist Group', url: 'https://www.economist.com', monogram: 'E', color: '#E3120B', issn: '0013-0613', year: 2025 },
  { id: 'financialtimes', packageHint: 'Financial Times', name: 'Financial Times', publisher: 'Financial Times', url: 'https://www.ft.com', monogram: 'FT', color: '#FFF1E5', issn: '0307-1766', year: 2025 },
  { id: 'wsj', packageHint: 'Wall Street Journal', name: 'The Wall Street Journal', publisher: 'Dow Jones', url: 'https://www.wsj.com', monogram: 'WSJ', color: '#1C1C1C', issn: '0099-9660', year: 2025 },
  { id: 'nytimes', packageHint: 'New York Times', name: 'The New York Times', publisher: 'The New York Times Company', url: 'https://www.nytimes.com', monogram: 'NYT', color: '#1C1C1C', issn: '0362-4331', year: 2025 },
  { id: 'newyorker', packageHint: 'New Yorker', name: 'The New Yorker', publisher: 'Condé Nast', url: 'https://www.newyorker.com', monogram: 'NY', color: '#1C1C1C', issn: '0028-792X', year: 2025 },
  { id: 'guardian', packageHint: 'Guardian', name: 'The Guardian', publisher: 'Guardian News & Media', url: 'https://www.theguardian.com', monogram: 'G', color: '#052962', issn: '0261-3077', year: 2025 },
  { id: 'hbr', packageHint: 'Harvard Business', name: 'Harvard Business Review', publisher: 'Harvard Business Publishing', url: 'https://hbr.org', monogram: 'HBR', color: '#C8102E', issn: '0017-8012', year: 2025 },
  { id: 'businessweek', packageHint: 'Bloomberg', name: 'Bloomberg Businessweek', publisher: 'Bloomberg', url: 'https://www.bloomberg.com/businessweek', monogram: 'BW', color: '#1C1C1C', issn: '0007-7135', year: 2025 },
].map(entry => Object.freeze(entry)));

export async function handleInstitutionServices(request: Request, env: WorkerEnv) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  const query = readInstitutionQuery(url.searchParams);
  const rawOffset = url.searchParams.get('offset');
  const offset = rawOffset === null ? undefined : Number(rawOffset);
  // Any platform can start a page: a page ends where its time ran out.
  if (rawOffset !== null && (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset)
    || offset! < 0 || offset! >= SERVICE_CATALOGUE.length)) {
    throw new InstitutionAccessError('INVALID_SERVICES_OFFSET', 400);
  }
  const ttl = (payload: { partial: boolean }) => (payload.partial ? SERVICES_PARTIAL_CACHE_SECONDS : ACCESS_CACHE_SECONDS);
  return cacheResponse(request, origin, env, ttl, () => lookupInstitutionServices(query, { env, offset }), {
    canonicalParams: servicesCacheParams(query, env, offset),
  });
}

/**
 * A short fingerprint of what a list depends on besides the library: the
 * catalogue entries, paging (the page size and the window that ends a page)
 * and the budget. Includes ISSN/year and displayed metadata.
 */
export function catalogueFingerprint(entries: ReadonlyArray<ServiceEntry>, budget: number) {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify([budget, SERVICES_PAGE_SIZE, SERVICES_START_WINDOW_MS, entries])) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// Also sent with each page, so a client that keeps where a list stopped can
// tell a page of another catalogue, whose positions may not match.
const CATALOGUE_FINGERPRINT = catalogueFingerprint(SERVICE_CATALOGUE, SUBREQUEST_BUDGET);

/**
 * The edge cache key's parameters for a services list: the upstream ones
 * (`upstreamParams`) and the catalogue's fingerprint, so a platform added,
 * changed or budgeted differently is not hidden behind a week-old list.
 * Seen on 2026-10-14: the catalogue grew from 14 to 66 platforms and USAL
 * kept seeing yesterday's 12 until the entry expired.
 */
export function servicesCacheParams(query: InstitutionQuery, env: WorkerEnv, offset?: number) {
  return { ...upstreamParams(query, env), catalogue: CATALOGUE_FINGERPRINT, reading: RESOLVER_READING, ...(offset === undefined ? {} : { offset: String(offset) }) };
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
  // journal whose probe article was closed when it was chosen. The per-paper
  // answer asks about the article itself. Press titles have no probe
  // article; The Guardian, free on the web, came back from TUM and LMU only
  // through PressReader, Gale and Nexis Uni (2026-10-20).
  const paid = answer.services.filter(service => service.url && !service.free);
  const own = paid.find(service => namesPlatform(service.name, entry));
  const subscription = own || paid[0];
  if (subscription) return {
    collection: subscription.name,
    ownPlatform: Boolean(own),
    // Press titles may only be available through an aggregator, whose library
    // link must be used instead of sending the reader to the publisher paywall.
    ...(!entry.doi ? { accessUrl: libraryLink(resolver, subscription.url!) } : {}),
  };
  // A service hidden by an IP or group filter is one this probe cannot see:
  // the platform is unchecked, not absent.
  return answer.restricted ? UNCHECKED : null;
}

/**
 * GetFTR on the requested entries with DOIs, a batch per request. Fills
 * `outcomes` with `{ collection: null, ownPlatform: true }`, null, or leaves
 * a platform undefined for the resolver to decide (GetFTR's `maybe`, a
 * publisher outside it) — UNCHECKED when there is no resolver to ask. A
 * request that fails leaves its platforms to the resolver too, or FAILED
 * without one. Returns the number of requests made.
 */
async function askGetFtrForCatalogue(entries: readonly ServiceEntry[], outcomes: ServiceOutcome[], { resolver, entityId, rorId, env, fetchImpl, signal }: Pick<InstitutionQuery, 'entityId' | 'rorId'> & { resolver: InstitutionResolver | null | undefined; env: WorkerEnv; fetchImpl: typeof fetch; signal: AbortSignal }) {
  const candidates = entries.flatMap((entry, index) => entry.doi ? [{ index, doi: entry.doi }] : []);
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
  return batches.length;
}

export async function lookupInstitutionServices(
  { domain, entityId = null, rorId = null }: InstitutionQuery,
  { fetchImpl = (...args) => fetch(...args), env = {}, now = Date.now, offset }: LookupOptions & { offset?: number } = {},
) {
  const resolver = findResolver({ domain, rorId });
  const getFtr = Boolean(env.GETFTR_API_KEY) && Boolean(entityId || rorId);
  if (!resolver && !getFtr) throw new InstitutionAccessError('INSTITUTION_NOT_SUPPORTED', 404);
  const signal = AbortSignal.timeout(SERVICES_DEADLINE_MS);
  const entries = offset === undefined ? SERVICE_CATALOGUE : SERVICE_CATALOGUE.slice(offset, offset + SERVICES_PAGE_SIZE);

  // `undefined` is a platform still to be asked about (filled: a hole would
  // be skipped by the iteration below).
  const outcomes = new Array<ServiceOutcome>(entries.length).fill(undefined);
  let budget = SUBREQUEST_BUDGET;
  if (getFtr) {
    budget -= await askGetFtrForCatalogue(entries, outcomes, { resolver, entityId, rorId, env, fetchImpl, signal });
  }

  // The resolver, one journal per request, for what is still undecided and
  // fits the budget; the rest is unchecked, in catalogue order, so the
  // platforms most libraries hold are the ones asked about.
  const pending: number[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome !== undefined) return;
    if (resolver && pending.length < budget) pending.push(index);
    else outcomes[index] = UNCHECKED;
  });
  let next = 0;
  // The window opens with the resolver's probes, so the time GetFTR took does
  // not shorten the page: what the deadline then cuts is partial. A request
  // without paging has no next page to leave platforms to, so it is not windowed.
  const startedAt = now();
  const mayStart = () => offset === undefined || now() - startedAt < SERVICES_START_WINDOW_MS;
  const drain = async () => {
    while (next < pending.length && mayStart()) {
      const index = pending[next++];
      outcomes[index] = await probeResolver(entries[index], resolver!, fetchImpl, signal).catch(() => FAILED);
    }
  };
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, drain));
  // A page ends at the first platform no probe started for, and the next page starts there.
  const end = next < pending.length ? pending[next] : entries.length;
  const reported = outcomes.slice(0, end);

  const asked = reported.filter(outcome => outcome !== UNCHECKED);
  if (asked.length > 0 && asked.every(outcome => outcome === FAILED)) {
    throw new InstitutionAccessError('ACCESS_LOOKUP_UNAVAILABLE', 502);
  }
  const services: Array<Pick<ServiceEntry, 'id' | 'name' | 'publisher' | 'url' | 'monogram' | 'color'> & ServiceSubscription> = [];
  entries.slice(0, end).forEach(({ id, name, publisher, url, monogram, color }, index) => {
    const outcome = reported[index];
    if (outcome && outcome !== FAILED && outcome !== UNCHECKED) {
      services.push({ id, name, publisher, url: outcome.accessUrl || url, monogram, color, collection: outcome.collection, ownPlatform: outcome.ownPlatform });
    }
  });
  return {
    services,
    partial: reported.includes(FAILED),
    unchecked: reported.filter(outcome => outcome === UNCHECKED).length,
    checkedAt: new Date(now()).toISOString(),
    ...(offset === undefined ? {} : {
      nextOffset: offset + end < SERVICE_CATALOGUE.length ? offset + end : null,
      catalogue: CATALOGUE_FINGERPRINT,
    }),
  };
}
