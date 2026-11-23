import assert from 'node:assert/strict';
import test from 'node:test';
import { conferenceInText } from './accepted-conference.ts';

// Catalogue spellings from the local arXiv samples, used in explicit acceptance statements.
test('accepts measured spellings and disambiguates shared acronyms from the primary archive and comment', () => {
  const samples: Array<[string, string, string, string, number]> = [
    ['6 pages, 6 figures, accepted for presentation in IEEE Globecom 2026', 'cs.NI', 'S4210205019', 'GLOBECOM', 2026],
    ['Accepted (ACM UIST 2026)', 'cs.HC', 'S7407087746', 'UIST', 2026],
    ["19 pages, 11 figures, 9 tables. To appear in NSDI '27 (24th USENIX Symposium on Networked Systems Design and Implementation)", 'cs.NI', 'S4306420602', 'NSDI', 2027],
    ['Accepted at NeurIPS 2026 (poster)', 'cs.LG', 'S4363606243', 'NeurIPS', 2026],
    ["Accepted at NIPS'18", 'cs.AI', 'S4363606243', 'NeurIPS', 2018],
    ['This paper is presented at IEEE VLSI Test Symposium (VTS) 2025', 'cs.CR', 'S4210180668', 'VTS', 2025],
    ['Accepted at ESEC/FSE 2022', 'cs.CR', 'S4363608883', 'ESEC/FSE', 2022],
    ['Accepted at CCC 2026', 'cs.DS', 'S4210204929', 'CCC', 2026],
    ['6 pages, 2 figures. Presented at ACM International Symposium on Wearable Computing (ISWC) 2026', 'cs.AI', 'S7407086454', 'ISWC', 2026],
    ['Accepted at ISWC 2024', 'cs.CV', 'S4306420056', 'ISWC', 2024],
    ["Accepted to ACE'25", 'cs.CY', 'S4306417782', 'ACE', 2025],
  ];
  for (const [text, category, id, label, year] of samples) {
    assert.deepEqual(conferenceInText(text, category, 'arxiv-comment'), { id, label, year, evidence: 'arxiv-comment' }, text);
  }
});

test('refuses measured workshops, submissions, unrelated conferences and category collisions', () => {
  for (const [text, category] of [
    // A location-and-date tail is left unparsed.
    ['7 pages, 4 figures, 5 tables. Accepted and presented at the 2026 IEEE 29th International Conference on Intelligent Transportation Systems (ITSC), Naples, Italy, September 15-18, 2026', 'cs.RO'],
    ['Accepted to the Conference on Robot Learning (CoRL 2026), November 9-12, 2026, Austin, TX, USA', 'cs.RO'],
    ['NeurIPS 2025 submission', 'cs.LG'],
    ['Withdrawn from NeurIPS 2025', 'cs.LG'],
    ['Not accepted at NeurIPS 2025', 'cs.LG'],
    ['Extended version of our NeurIPS 2023 paper', 'cs.LG'],
    ['Journal extension of the paper accepted at ICML 2024', 'cs.LG'],
    ['Accepted at TMLR; earlier version presented at NeurIPS 2023', 'cs.LG'],
    ['NeurIPS 2025 reproducibility report', 'cs.LG'],
    ['Accepted at the NeurIPS 2025 ML4H symposium', 'cs.LG'],
    ['Accepted in ML4H 2025 (NeurIPS)', 'cs.LG'],
    ['Accepted at Nature Medicine (NeurIPS 2025)', 'cs.LG'],
    ['NeurIPS 2025 preprint. Accepted at TMLR', 'cs.LG'],
    ['Accepted at Nature Medicine and also presented at NeurIPS 2023', 'cs.LG'],
    ['Accepted at TMLR; also presented at NeurIPS 2023', 'cs.LG'],
    ['To be presented at a NeurIPS 2025 affinity event', 'cs.LG'],
    ['Accepted at AAAI 2026 Student Abstract', 'cs.AI'],
    ['Accepted at ACL 2025 SRW', 'cs.CL'],
    ['accepted to CoDecFin 2026 at FC 2026', 'cs.DC'],
    ['BioNLP @ ACL 2024', 'cs.CL'],
    ['TrustNLP @ ACL 2023', 'cs.CL'],
    ['Chinese CHI 2021', 'cs.HC'],
    ["Submitted to CHI'25", 'cs.HC'],
    ['CHI 2026 BiAlign Workshop', 'cs.HC'],
    ['CCC 2025', 'cs.LG'],
    ["It' s accepted to ISCA 2022", 'eess.AS'],
  ]) assert.equal(conferenceInText(text, category, 'arxiv-comment'), undefined, text);
});

test('requires an acceptance of this paper at the catalogued venue', () => {
  for (const comment of [
    'Extension of our NeurIPS 2023 paper',
    'Extended from our ICML 2024 paper',
    'Full version of the NeurIPS 2024 paper',
    'Preliminary version appeared in ICML 2022',
    'A preliminary version of this work appeared at NeurIPS 2022',
    'Published in TPAMI; extends our CVPR 2022 paper',
    'In review at NeurIPS 2025',
    'NeurIPS 2025 (in review)',
    'NeurIPS 2025 reject',
    'Declined at NeurIPS 2025',
    'NeurIPS 2025 (retracted)',
    'Not presented at NeurIPS 2025',
    'Our ICML 2024 paper is related',
    'Builds on our NeurIPS 2023 paper',
    'Draft for ICML 2025',
    'Targeting NeurIPS 2025',
    'Erratum to our NeurIPS 2024 paper',
    'Code for the NeurIPS 2024 paper X',
    'Slides from NeurIPS 2024 talk',
    'MLRC 2023 (reproduction of a NeurIPS 2022 paper)',
    'ICLR 2025 Tiny Paper',
    'Accepted at ICLR 2024 TinyPaper track',
    'Accepted at ICLR 2025 Blog Track',
    'Accepted to the NeurIPS 2025 Creative AI track',
    'NeurIPS 2025 High School Projects track',
    'NeurIPS 2025 Education track',
    'NeurIPS 2025 Sponsor Expo',
    'Accepted to the ICML 2025 Expo',
    'Accepted at NeurIPS 2025 as a Tiny Paper',
    'NeurIPS 2025 WiML',
    'Queer in AI @ NeurIPS 2025',
    'Presented at NeurIPS 2025 in the Black in AI session',
    'Accepted at EMNLP 2024 BlackboxNLP',
    'Accepted at the ICML 2025 AI4Science',
    'Accepted to NeurIPS 2025 Lock-LLM',
    'NeurIPS 2025 MusIML',
    'Accepted at the NeurIPS 2025 Ws on X',
    'Accepted at the NeurIPS 2025 Machine Learning for Health (ML4H) Findings track',
    'CHI 2025 LBW',
    'Accepted to UIST 2025 Adjunct',
    'Accepted in UIST 2024 Posters',
    'CSCW 2025 Companion',
    'Accepted at WWW 2025 Companion',
    'Accepted at Interspeech 2025 Show and Tell',
    'Accepted at AAAI 2026 EAAI',
    'AAAI 2026 SA',
    'Accepted at AAAI 2025 Bridge Program',
    'Accepted at the AAAI 2025 New Faculty Highlights',
    'AAAI 2026 Senior Member track',
    'RSS 2025 Pioneers',
    'Accepted at NeurIPS 2025 (pending)',
    'Conditionally accepted at CHI 2025',
    'ICML 2025',
    'Camera-ready version for ACL 2024 Findings',
    'Camera-ready version for Findings of ACL 2024',
    'ECCV 2026 Accepted',
    'Published as a conference paper at ICLR 2026, Position Paper Track',
    'Accepted by WACV 2027, code: https://example.org/code and a workshop',
    'Accepted by WACV 2027, research track, 12 pages',
    'Accepted by WACV 2027, industry track',
    'Published as a conference paper at ICLR 2026. Position Paper Track',
    'Accepted by WACV 2027, 12 pages. Industry track',
    'Accepted by WACV 2027, website: conference workshop',
    'Accepted by WACV 2027, code: https://example.org/code, EMNLP 2026',
    'Our baseline was published in NeurIPS 2025',
    'In Proceedings of another meeting (ICML 2024)',
    'Accepted at ICML 2025 Unlisted Event',
    'Accepted at ICML 2025. In review at Nature',
    'Published in TMLR; NeurIPS 2025 (poster)',
    'Accepted at AAAI (ICML 2024)',
    'Accepted at a Conference on ICML 2024',
    'Accepted at the 2023 International Conference on Machine Learning (ICML 2024)',
    'Accepted at ICML 2025, 中文论坛',
  ]) assert.equal(conferenceInText(comment, 'cs.LG', 'arxiv-comment'), undefined, comment);

  for (const [comment, label, year] of [
    ['Published as a conference paper at ICLR 2026', 'ICLR', 2026],
    ['37 pages (13+24), 5 figures, published as Conference Paper in the 40th Conference on Neural Information Processing Systems (NeurIPS 2026)', 'NeurIPS', 2026],
    ['Accepted by WACV 2027, website: https://sketchverify.github.io/', 'WACV', 2027],
    ['Accepted at ICML 2025, 12 pages, 4 figures, 1 table', 'ICML', 2025],
    ['Accepted at ICML 2025 (Main Conference)', 'ICML', 2025],
    ['Accepted at ICML 2025', 'ICML', 2025],
    ['To appear in CVPR 2025', 'CVPR', 2025],
    ['Camera-ready for Findings of ACL 2024', 'ACL Findings', 2024],
    ['Accepted at the 41st International Conference on Machine Learning (ICML 2024)', 'ICML', 2024],
    ['Accepted @ NeurIPS 2024', 'NeurIPS', 2024],
    ['Published in the Proceedings of AAAI 2025', 'AAAI', 2025],
    ['Oral presentation at ICLR 2024', 'ICLR', 2024],
    ['Has been accepted by ICRA 2025', 'ICRA', 2025],
    ['Paper accepted to CVPR 2025', 'CVPR', 2025],
    ['Accepted by NeurIPS 2021 Track on Datasets and Benchmarks', 'NeurIPS', 2021],
    ['This paper appears in ICML 2024', 'ICML', 2024],
    ['ICLR 2025 (oral)', 'ICLR', 2025],
    ['ICLR 2025 (poster)', 'ICLR', 2025],
    ['Accepted to EMNLP 2026 Main Conference', 'EMNLP', 2026],
    ['Camera-ready for ICLR 2024', 'ICLR', 2024],
    ['In Proceedings of CVPR 2024', 'CVPR', 2024],
    ['Accepted at NeurIPS 2025 Datasets and Benchmarks Track', 'NeurIPS', 2025],
    ['Presented at ICML 2025 Main Track; code and data available', 'ICML', 2025],
  ] as const) {
    const mark = conferenceInText(comment, 'cs.LG', 'arxiv-comment');
    assert.equal(mark?.label, label, comment);
    assert.equal(mark.year, year, comment);
  }
});

test('separate side-track notes and links cannot identify the main proceedings', () => {
  for (const counts of ['', ', 6 pages']) {
    for (const [venue, track] of [['CHI', 'LBW'], ['EMNLP', 'Findings'], ['ICLR', 'Tiny paper'],
      ['CVPR', 'CVPRW'], ['ICCV', 'ICCVW'], ['ECCV', 'ECCVW']]) {
      assert.equal(conferenceInText(`Accepted at ${venue} 2026${counts}. ${track}`, 'cs.LG', 'arxiv-comment'), undefined);
    }
  }
  for (const text of ['Accepted at www.kaggle.com', 'Accepted at https://example.org/ICML',
    'Project: https://example.org/;ICLR2025 (poster)', 'Accepted at CHI 2026. Website: https://example.org;LBW',
    'Accepted at CHI 2026. Demos', 'Accepted at CVPR 2026. CVPRW2026', 'Accepted at NeurIPS 2026. NewInML @ NeurIPS',
    'Accepted at ICML 2026, Workshop, Italy, September 15-18, 2026',
    'Accepted at ICML 2025, Naples, Italy, September 15-18, 2026',
    "To appear in NSDI '27 (USENIX Symposium on Something Else)"]) {
    assert.equal(conferenceInText(text, 'cs.LG', 'arxiv-comment'), undefined, text);
  }
});

test('a second event or short track note makes the acceptance ambiguous', () => {
  for (const comment of [
    'Accepted at ICML 2026. AI4Science',
    'Accepted at ICML 2026; AI for Science',
    'Accepted at ACL 2026. BioNLP',
    'Accepted at ACL 2026. WMT',
    'Accepted at ACL 2026. SIGDIAL',
    'Accepted at ACL 2026. RepL4NLP',
    'Accepted at ACL 2026. Industry',
    'Accepted at ACL 2026. Student Research',
    'Accepted at NeurIPS 2026. SoLaR',
    'Accepted at CHI 2026. alt.chi',
    'Accepted at CHI 2026. Interactivity',
    'Accepted at CHI 2026. Case Study',
    'Spotlight at NeurIPS 2026. AI4Mat',
    'Oral at CVPR 2026. EarthVision',
    'GenAI4Health. ICLR 2026 (poster)',
    'Presented at ICML 2026. Invited talk',
    'TACL 2024. Presented at ACL 2024. 12 pages',
    'Accepted at ICML 2026. Summer School on Computing 2026',
    'Accepted at ICML 2026. International Forum on Art and Design in 2026',
    'Accepted at ACL 2026. This was a paper for BioNLP',
    'Show and Tell paper. Presented at Interspeech 2024',
    '2 pages; Published in the Proceedings of Interspeech 2021; Presented in Show and Tell; For the published paper, see https://www.isca-speech.org/archive/interspeech_2021/cho21_interspeech.html',
  ]) assert.equal(conferenceInText(comment, 'cs.CL', 'arxiv-comment'), undefined, comment);
});

test('every additional clause must identify a neutral note or the same acceptance', () => {
  for (const note of [
    'Part of the Show and Tell program', 'Selected for the Creative AI program',
    'This is a work-in-progress paper', 'One of the Doctoral Colloquium papers this year',
    'A two page abstract only', 'Later the acceptance was revoked',
    'These are the lecture notes for the invited lecture', 'This is a blackboxnlp contribution',
    'The authors contributed equally to this work', 'The paper appeared there with IEEE support',
    'The experiments were completed in 2025', 'The ICML proceedings include this work',
    'Corresponding author: Alex Smith for the side event', 'Code: side-event',
  ]) {
    assert.equal(conferenceInText(`Accepted at ICML 2025. ${note}`, 'cs.LG', 'arxiv-comment'), undefined, note);
    assert.equal(conferenceInText(`${note}; Accepted at ICML 2025`, 'cs.LG', 'arxiv-comment'), undefined, note);
  }
});

test('checks rejection cues inside links before interpreting a resource note', () => {
  for (const url of [
    'https://icml.cc/virtual/2025/workshop/1234', 'https://ai4science-icml-workshop.github.io',
    'https://example.org/late_breaking', 'https://example.org/student%20abstract',
    'https://example.org/%77orkshop', 'https://example.org/icmlw2025', 'https://example.org/%zz',
  ]) {
    assert.equal(conferenceInText(`Accepted at ICML 2025. ${url}`, 'cs.LG', 'arxiv-comment'), undefined, url);
    assert.equal(conferenceInText(`Accepted at ICML 2025, code: ${url}`, 'cs.LG', 'arxiv-comment'), undefined, url);
  }
  assert.equal(conferenceInText('Accepted at ASRU workshop. Website: https://example.org/workshop', 'cs.CL', 'arxiv-comment'), undefined);
  assert.equal(conferenceInText('Accepted at SP 2025. Data: https://example.org/signal_processing', 'cs.CR', 'arxiv-comment'), undefined);
});

test('an edition beyond next year refuses the entire mark', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 11, 31, 23, 59) });
  for (const venue of ["MICRO'58", "DAC'62", 'ISCA52', "HICSS'59", "STOC'57", 'CDC64', 'NeurIPS 2028']) {
    assert.equal(conferenceInText(`Accepted at ${venue}`, 'cs.AR', 'arxiv-comment'), undefined, venue);
  }
  assert.equal(conferenceInText("Accepted at ICML'27", 'cs.LG', 'arxiv-comment')?.year, 2027);
  assert.equal(conferenceInText("Accepted at ICML'28", 'cs.LG', 'arxiv-comment'), undefined);
  assert.equal(conferenceInText('ICML', 'cs.LG', 'openreview', 'ICML.cc/2028/Conference'), undefined);
  t.mock.timers.tick(60_000);
  assert.equal(conferenceInText("Accepted at ICML'28", 'cs.LG', 'arxiv-comment')?.year, 2028);
});

test('requires a compatible primary category for shared short venue spellings', () => {
  for (const [term, allowed, collision, label] of [
    ['FSE', 'cs.SE', 'cs.CR', 'ESEC/FSE'], ['SA', 'cs.GR', 'cs.SE', 'SIGGRAPH Asia'], ['SP', 'cs.CR', 'eess.SP', 'S&P'],
    ['IV', 'cs.RO', 'cs.HC', 'IV'], ['CEC', 'cs.NE', 'cs.SE', 'CEC'], ['SDM', 'cs.DB', 'eess.SY', 'SDM'],
    ['HT', 'cs.HC', 'math.AP', 'HT'], ['SAC', 'cs.SE', 'cs.CR', 'SAC'], ['SAC', 'cs.AI', 'quant-ph', 'SAC'],
  ]) {
    assert.equal(conferenceInText(`Accepted at ${term} 2025`, collision, 'arxiv-comment'), undefined, term);
    assert.equal(conferenceInText(`Accepted at ${term} 2025`, allowed, 'arxiv-comment')?.label, label, term);
  }
  assert.equal(conferenceInText('Accepted at SIGGRAPH Asia 2025', 'cs.SE', 'arxiv-comment')?.label, 'SIGGRAPH Asia');
  assert.equal(conferenceInText('Accepted at S&P 2025', 'eess.SP', 'arxiv-comment')?.label, 'S&P');
});

test('recognises neutral notes, count prefixes and parenthesised symposium names', () => {
  for (const note of ['12 pages, 3 figures, 1 table', 'Code: https://example.org/BioNLP',
    'Project page: https://example.org/AI4Science', 'Data: https://example.org/WMT',
    'Website: https://example.org/Industry', 'Camera-ready version', 'Equal contribution',
    'Corresponding author: Alex Smith',
    '12pages,12figures', '4+1 pages, 2 figures', 'XX pages, X figures', 'Code: GitHub', 'Data: GitHub https://example.org/WMT', 'Code and data: https://example.org/SoLaR',
    'Code is available at https://example.org/code', 'Project page is at https://example.org/project',
    '29 pages, including references and appendices', 'Project webpage: https://example.org/BioNLP',
    'Dataset available: https://example.org/SoLaR']) {
    assert.equal(conferenceInText(`Accepted at ICML 2026. ${note}`, 'cs.LG', 'arxiv-comment')?.label, 'ICML', note);
  }
  assert.equal(conferenceInText('37 pages (13+24), accepted at ICML 2026', 'cs.LG', 'arxiv-comment')?.label, 'ICML');
  assert.equal(conferenceInText('Accepted at ICML 2026. Presented at ICML 2026', 'cs.LG', 'arxiv-comment')?.label, 'ICML');
  const stoc = conferenceInText('Accepted at STOC 2026 (58th ACM Symposium on Theory of Computing)', 'cs.DS', 'arxiv-comment');
  assert.deepEqual(stoc, { id: 'S7407087723', label: 'STOC', year: 2026, evidence: 'arxiv-comment' });
});

test('only accepts presentation formats that identify papers at that venue', () => {
  for (const comment of [
    'CHI 2025 (poster)',
    'SIGGRAPH 2025 (Poster)',
    'Accepted at CHI 2025 (poster_presentation)',
    'Poster at SIGGRAPH 2025',
    'Accepted at CCS 2025 (poster)',
    'Poster presentation at the CCS 2025',
    'Accepted at IEEE S&P 2025 poster',
    'Accepted at WWW 2025 (poster)',
    'Accepted at UIST 2025 (poster)',
    'Accepted at GECCO 2025 poster',
    'Spotlight presentation at CHI 2025',
    'Poster at AAAI 2026',
    'ICRA 2025 (poster)',
    'KDD 2025 (poster)',
    'AAAI 2025 (poster)',
    'IJCAI 2025 (poster)',
    'ISCA 2025 (poster)',
    'SIGIR 2025 (poster)',
    'Oral at CHI 2025',
    'Poster at CVPR 2025',
    'Accepted at ICCV 2025 (spotlight)',
    'ECCV 2024 (poster)',
    'To appear in CVPR 2018. Spotlight Presentation',
    'Published at ICRA 2026. Oral Presentation',
    'Accepted at SIGGRAPH 2025. Poster abstract',
    'Accepted at CHI 2025. Poster paper',
    'Accepted at AAAI 2026. Poster paper',
    'Accepted at KDD 2025. Oral talk',
    'Accepted at KDD 2025. Posters',
    'Accepted at KDD 2025. Best poster award',
    'Accepted at ICCV 2025. Spotlight talk',
    'Accepted at ECCV 2024. Poster talk',
    'Accepted at CHI 2025. Includes oral histories',
  ]) assert.equal(conferenceInText(comment, 'cs.LG', 'arxiv-comment'), undefined, comment);

  for (const [comment, label] of [
    ['NeurIPS 2024 (spotlight)', 'NeurIPS'],
    ['Poster presentation at ICML 2025', 'ICML'],
    ['Oral at ICLR 2024', 'ICLR'],
    ['Accepted at CVPR 2025 (oral)', 'CVPR'],
    ['Oral presentation at ICCV 2025', 'ICCV'],
    ['ECCV 2024 (oral)', 'ECCV'],
    ['Accepted at ICML 2026. Poster presentation', 'ICML'],
    ['Accepted by CVPR 2025. Project Page: https://poster-maker.github.io', 'CVPR'],
  ]) assert.equal(conferenceInText(comment, 'cs.LG', 'arxiv-comment')?.label, label, comment);
});

test('applies phrase and workshop exceptions, exact case, strict archives and unresolved ties', () => {
  const mark = (text: string, category = 'cs.CL') => conferenceInText(text, category, 'arxiv-comment');
  assert.equal(mark('Published in proceedings of the combustion institute')?.label, 'Symposium on Combustion');
  assert.equal(mark('Accepted at the ASRU workshop')?.label, 'ASRU');
  assert.equal(mark('Accepted at an ASRU workshop tutorial'), undefined);
  assert.equal(mark('Published in Findings of ACL 2024')?.label, 'ACL Findings');
  assert.equal(mark('Accepted to the main conference of EMNLP 2022')?.label, 'EMNLP');
  assert.equal(mark('Accepted by International Conference on Computer Vision (ICCV 2021)')?.label, 'ICCV');
  assert.equal(mark('Accepted to Advances in Neural Information Processing Systems 33 (NeurIPS 2020)')?.label, 'NeurIPS');
  assert.equal(mark('Accepted for presentation at IEEE Workshop on Spoken Language Technology (SLT 2016)')?.label, 'SLT');
  assert.equal(mark('Accepted at ACE 2025', 'cs.DC'), undefined);
  assert.equal(mark('ACL 2025', 'physics.optics'), undefined);
  assert.equal(mark('Accepted at ACL'), undefined);
  assert.equal(mark('Accepted at neurips'), undefined);
  assert.equal(mark('Results compared to NeurIPS papers'), undefined);
  assert.deepEqual(mark('Accepted at NeurIPS'), { id: 'S4363606243', label: 'NeurIPS', evidence: 'arxiv-comment' });
});

test('OpenReview requires matching main proceedings or the listed archival track', () => {
  const mark = (text: string, venueId?: string) => conferenceInText(text, 'cs.LG', 'openreview', venueId);
  for (const [text, venueId] of [
    ['CHI 2025 Poster', 'CHI.cc/2025/Conference'],
    ['ICLR 2025 Blog Track', 'ICLR.cc/2025/Conference'],
    ['NeurIPS 2025 Creative AI Track', 'NeurIPS.cc/2025/Conference'],
    ['EMNLP 2024 BlackboxNLP', 'EMNLP.cc/2024/Conference'],
    ['ICLR 2025 Blogpost Track', 'ICLR.cc/2025/BlogPosts'],
    ['ICLR 2025 Blogpost Track', 'ICLR.cc/2025/Conference'],
    ['ICLR 2023 TinyPapers', 'ICLR.cc/2023/TinyPapers'],
    ['ICLR 2025', 'ICLR.cc/2025/TinyPapers/Conference'],
    ['ICLR 2025', 'ICLR.cc/2025/Datasets_and_Benchmarks_Track'],
    ['ICLR 2025', 'ICML.cc/2025/Conference'],
    ['ICLR 2025', 'ICLR.cc/2024/Conference'],
    ['2024 ICLR', 'ICLR.cc/2025/Conference'],
    ['ICLR 2025'],
  ]) assert.equal(mark(text, venueId), undefined, text);
  assert.equal(mark('ICLR 2025 Poster', 'ICLR.cc/2025/Conference')?.label, 'ICLR');
  assert.deepEqual(mark('NeurIPS 2025 Datasets and Benchmarks Track', 'NeurIPS.cc/2025/Datasets_and_Benchmarks_Track'),
    { label: 'NeurIPS', id: 'S4363606243', evidence: 'openreview', year: 2025 });
});
