import economist from '../../assets/publishers/economist.ico';
import financialtimes from '../../assets/publishers/financialtimes.svg';
import wsj from '../../assets/publishers/wsj.ico';
import nytimes from '../../assets/publishers/nytimes.ico';
import newyorker from '../../assets/publishers/newyorker.ico';
import guardian from '../../assets/publishers/guardian.png';
import hbr from '../../assets/publishers/hbr.png';
import businessweek from '../../assets/publishers/businessweek.ico';
import aaa from '../../assets/publishers/aaa.png';
import aacr from '../../assets/publishers/aacr.svg';
import aap from '../../assets/publishers/aap.svg';
import acm from '../../assets/publishers/acm.svg';
import acp from '../../assets/publishers/acp.svg';
import acs from '../../assets/publishers/acs.svg';
import ada from '../../assets/publishers/ada.svg';
import aea from '../../assets/publishers/aea.svg';
import aha from '../../assets/publishers/aha.svg';
import aiaa from '../../assets/publishers/aiaa.png';
import aip from '../../assets/publishers/aip.svg';
import ametsoc from '../../assets/publishers/ametsoc.png';
import ams from '../../assets/publishers/ams.svg';
import annualreviews from '../../assets/publishers/annualreviews.svg';
import aom from '../../assets/publishers/aom.png';
import apa from '../../assets/publishers/apa.svg';
import aps from '../../assets/publishers/aps.svg';
import asce from '../../assets/publishers/asce.svg';
import asco from '../../assets/publishers/asco.svg';
import asme from '../../assets/publishers/asme.svg';
import biologists from '../../assets/publishers/biologists.svg';
import bmj from '../../assets/publishers/bmj.png';
import brepols from '../../assets/publishers/brepols.svg';
import brill from '../../assets/publishers/brill.svg';
import cambridge from '../../assets/publishers/cambridge.svg';
import canscipub from '../../assets/publishers/canscipub.svg';
import chicago from '../../assets/publishers/chicago.svg';
import degruyter from '../../assets/publishers/degruyter.svg';
import dukeupress from '../../assets/publishers/dukeupress.svg';
import edinburghup from '../../assets/publishers/edinburghup.png';
import emerald from '../../assets/publishers/emerald.svg';
import euclid from '../../assets/publishers/euclid.png';
import guilford from '../../assets/publishers/guilford.svg';
import ieee from '../../assets/publishers/ieee.svg';
import informs from '../../assets/publishers/informs.png';
import iop from '../../assets/publishers/iop.svg';
import jama from '../../assets/publishers/jama.svg';
import jstor from '../../assets/publishers/jstor.svg';
import karger from '../../assets/publishers/karger.svg';
import liverpoolup from '../../assets/publishers/liverpoolup.svg';
import lyell from '../../assets/publishers/lyell.svg';
import microbiologysociety from '../../assets/publishers/microbiologysociety.png';
import mitpress from '../../assets/publishers/mitpress.svg';
import msp from '../../assets/publishers/msp.png';
import muse from '../../assets/publishers/muse.png';
import nature from '../../assets/publishers/nature.svg';
import nejm from '../../assets/publishers/nejm.svg';
import optica from '../../assets/publishers/optica.svg';
import oup from '../../assets/publishers/oup.svg';
import physiology from '../../assets/publishers/physiology.png';
import portland from '../../assets/publishers/portland.svg';
import royalsociety from '../../assets/publishers/royalsociety.png';
import rsc from '../../assets/publishers/rsc.svg';
import rsna from '../../assets/publishers/rsna.svg';
import sage from '../../assets/publishers/sage.svg';
import science from '../../assets/publishers/science.svg';
import sciencedirect from '../../assets/publishers/sciencedirect.svg';
import siam from '../../assets/publishers/siam.svg';
import spie from '../../assets/publishers/spie.svg';
import springerlink from '../../assets/publishers/springerlink.svg';
import tandf from '../../assets/publishers/tandf.svg';
import thieme from '../../assets/publishers/thieme.svg';
import ucpress from '../../assets/publishers/ucpress.svg';
import wiley from '../../assets/publishers/wiley.svg';
import wolterskluwer from '../../assets/publishers/wolterskluwer.svg';
import worldscientific from '../../assets/publishers/worldscientific.png';

// Keyed by the Worker catalogue's platform id. Each import is named after its
// file, which `publisherLogos.test.ts` relies on to check the map from source.
const LOGOS = {
  economist,
  financialtimes,
  wsj,
  nytimes,
  newyorker,
  guardian,
  hbr,
  businessweek,

  aaa,
  aacr,
  aap,
  acm,
  acp,
  acs,
  ada,
  aea,
  aha,
  aiaa,
  aip,
  ametsoc,
  ams,
  annualreviews,
  aom,
  apa,
  aps,
  asce,
  asco,
  asme,
  biologists,
  bmj,
  brepols,
  brill,
  cambridge,
  canscipub,
  chicago,
  degruyter,
  dukeupress,
  edinburghup,
  emerald,
  euclid,
  guilford,
  ieee,
  informs,
  iop,
  jama,
  jstor,
  karger,
  liverpoolup,
  lyell,
  microbiologysociety,
  mitpress,
  msp,
  muse,
  nature,
  nejm,
  optica,
  oup,
  physiology,
  portland,
  royalsociety,
  rsc,
  rsna,
  sage,
  science,
  sciencedirect,
  siam,
  spie,
  springerlink,
  tandf,
  thieme,
  ucpress,
  wiley,
  wolterskluwer,
  worldscientific,
};

export function publisherLogoFor(id: string) {
  return Object.hasOwn(LOGOS, id) ? LOGOS[id as keyof typeof LOGOS] : null;
}
