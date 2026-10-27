# Europe PMC notable leaves

Which medicine and biology leaves' notable lanes also list Europe PMC's
most-cited records (`europepmc-notable` in `worker/paper-sources.ts`), the
query each lists with, and the evidence for each.

```bash
node scripts/generate-europepmc-notable-leaves.ts
node scripts/generate-europepmc-notable-leaves.ts --check
```

The generator reads `scripts/data/europepmc-notable-reviews.json` and writes
`worker/europepmc-notable-leaves.generated.ts` (`EUROPE_PMC_NOTABLE_QUERIES`,
each admitted leaf with the query its sample asked) and the report
`scripts/data/europepmc-notable-coverage.json`. `npm test` runs `--check`. The
generator does not call Europe PMC.

## The listing

For each of the ten completed years before the current one, an admitted leaf's
notable lane lists Europe PMC's 100 most-cited records first published that
year that the leaf's query matches, the query its sample asked (Evidence,
below): the leaf's label in the title, abstract or keywords, the label query
of the medicine and biology category lanes without their date range
(`europePmcLabelQuery` in `src/services/domain-source-records.ts`), or its
MeSH descriptors, or its journals:

`query=<the leaf's query> AND FIRST_PDATE:[<year>-01-01 TO <year>-12-31] AND (SRC:MED OR SRC:PPR) NOT PUB_TYPE:"retracted publication" NOT PUB_TYPE:"retraction of publication" NOT PUB_TYPE:"published erratum" NOT ((PUB_TYPE:"editorial" OR PUB_TYPE:"letter" OR PUB_TYPE:"comment") AND HAS_ABSTRACT:n) sort_cited:y`, `resultType=core`, `pageSize=100`

That is PubMed's records, subscription and open alike, and the preprint
servers' (not Europe PMC's patents, theses or books), without retracted
papers, which stay cited, retraction notices and errata, and, as in the PubMed
lane, editorials, letters and comments without an abstract. The year is the
first publication's, the date the store files and reads a paper by; the issue
year can be the next one. A record Europe PMC files under its preprint source (`PPR`)
or that PubMed types Preprint is mapped as a preprint. The records are mapped
with `mapEuropePmcSearchResult`, filed under `notable:<leaf>` and kept as the
other notable listings are, so a leaf that OpenAlex lists too holds up to
2,000 papers. A record merges with the same paper from another listing or lane
by its DOI, its PubMed id, or its title and first author. The listing waits 15
seconds for a page, as the enrichment's Europe PMC calls do: a core page of
100 is about 1.4 MB.

## Evidence

`europepmc-notable-reviews.json` has one key, `leaves`, keyed by leaf. Each
sample holds `capturedAt`, the `query` as sent, `hitCount` (every record the
query matched), every returned record (`id`, `source`, `title`, `pubYear`,
`citedByCount`) and one label per record: `on-target`, `off-target`, or
`uncertain: true` without a label for a call the labeller doubted, which
counts as a miss.

The query must be exactly this, with Y the capture year:

| Parameter | Value |
| --- | --- |
| `query` | `<the leaf's query> AND PUB_YEAR:[<Y−10> TO <Y−1>] AND HAS_ABSTRACT:y sort_cited:y` |
| `format`, `resultType` | `json`, `core` |
| `pageSize`, `page` | `15`, `1` |

The leaf's query takes one of three forms, and the listing asks the one its
sample asked:

| Form | Query | What it matches |
| --- | --- | --- |
| Label | `europePmcLabelQuery([leaf])`: `(TITLE_ABS:"<label>" OR KW:"<label>")` | The label in the title, abstract or keywords, as the category lanes ask |
| MeSH | `(KW:"<descriptor>" OR KW:"<descriptor>" …)` | Europe PMC's `KW` holds a PubMed record's MeSH descriptors beside its authors' keywords, not MeSH qualifiers. A phrase also matches every descriptor whose name holds it: `Surgical Procedures` matches `Cardiac Surgical Procedures` |
| Journals | `(ISSN:"<ISSN>" OR ISSN:"<ISSN>" …)` | A journal's print or electronic ISSN |

The generator refuses other fields, `NOT`, a mix of forms, a title and
abstract phrase other than the leaf's label, and a phrase with a backslash or
a control character, which could end its quotes or break the generated
string. It checks the form only: a `KW` phrase can be any keyword, so that
each phrase is a MeSH descriptor, or a phrase descriptors' names share, is
checked before sampling (with NLM's MeSH lookup service, as on 2026-10-26).

The sample asks `HAS_ABSTRACT:y` because the labellers read the abstracts; the
listing does not. The 2026-10-26 samples asked by issue year (`PUB_YEAR`) and
without the listing's sources and types; every sampled record has an abstract,
so the type clause leaves them all in the listing. The records must fall in the ten years, in
non-increasing citation order, each labelled once. Only a medicine or biology
leaf of the taxonomy takes a sample.

## Decision

The gate of the topic and venue lanes: a full page of 15, at least 10 on
target without doubt. Records with the same title of 30 or more letters and
digits (a guideline two journals publish) are one work for a reader, as the
store joins them, so they count once, on target only when every copy is; a
page with such a pair is short of 15 works, and its leaf waits for a later
sample. A leaf whose query matches fewer than 1,000 records in the ten
years (`small-population`) is not admitted however its sample reads: the
listing, 100 a year, would take nearly every record, uncited ones included,
and the sample measures only the most cited. A passing leaf joins
`EUROPE_PMC_NOTABLE_QUERIES` with its query. The sample is evidence about the
head of the population, not about a year's 100th record; the check after the
lanes deploy counts each admitted lane's records and citations a year. Each
batch of admitted leaves changes what every reader of those leaves is shown,
so it is authorized under AGENTS.md before it is committed.

## The 2026-10-26 sample

Every medicine and biology leaf was sampled: 31 requests between 09:52 and
09:53 UTC on 2026-10-26. Each sheet named the leaf in its heading and held
shuffled opaque row IDs, the title and the first 1,500 characters of the
abstract, and nothing else. The samples were labelled by the agent at
Nicolás's request: four fresh agent contexts (two for medicine, two for
biology), each given only its own sheets (that a labeller read nothing else
cannot be proved from the files), answering whether a researcher who chose the
leaf would recognise the article as a notable work of their field. The labels
were joined to the records afterwards. 6 leaves passed; the counts are works
on target without doubt, of the distinct works sampled.

| Status | Leaves |
| --- | --- |
| Passed | bio.comp 14 of 15, bio.micro 10, bio.neuro 10, med.endo 11, med.onco 14, med.pharma 10 |
| Too few records matched | med.psych (57 records, 14 on target), med.pubh (76), med.radio (405), med.neuro (761, 12 on target), bio.marine (915), bio.zoo (928), med.immuno (974, 14 on target) |
| Fewer than 15 distinct works | bio.evo (5: a preprint and its journal version), bio.immuno (3), med.cardio (14, 10 on target: a guideline in two journals), med.peds (14: a guideline twice) |
| Rejected | bio.biochem 9, bio.biotech 4, bio.bot 6, bio.cell 7, bio.eco 7, bio.gen 7, bio.mol 1, bio.physio 0, med.derma 8, med.gen 2, med.infect 6 (one doubted), med.path 5 (one doubted), med.surg 6, med.tox 8 |

Most misses name the leaf only in passing: "National Center for
Biotechnology Information" in bio.biotech, "physiology and disease" in
bio.physio, "Alzheimer's disease pathology" in med.path, a trial group's name
(the American College of Radiology Imaging Network) in med.radio, and a
"General Medicine" ward or journal in med.gen. Of the six admitted leaves,
med.pharma has no OpenAlex notable listing, so Europe PMC's is its only one.
The six lanes bring up to 6,000 new papers on their first night for the
nightly enrichment and embedding to reach.

## The 2026-10-26 MeSH and journal samples

Later on 2026-10-26, OpenAlex topic samples
(`scripts/README-openalex-leaf-topics.md`) admitted six of the ten leaves that
still had no notable lane and rejected four medicine leaves: med.tox,
med.surg, med.immuno and med.path. Each was proposed again here by MeSH
descriptors and, for the three that still failed, by journals. Each list was
written before its sample from the specialty's meaning, with what the leaf's
earlier samples missed in view (bare `Pathology` is left out because the label
sample's misses named Alzheimer's disease pathology): descriptors from NLM's
MeSH vocabulary, each confirmed as a descriptor by NLM's lookup service
(`Surgical Procedures` is not a descriptor but a phrase that many
operative-procedure descriptors' names share), and journals by title and
scope, each ISSN confirmed against the journal Europe PMC files under it. The
new pages repeat few records of the leaves' earlier Europe PMC pages: the MeSH
pages of med.surg, med.tox and med.path 6, 3 and 2 of their label pages; the
journal pages none (med.tox), one of each earlier page (med.path), and 2 of
the label page and 4 of the MeSH page (med.immuno). Every repeated record kept
whether it counted as on target; one, a microRNA review on med.immuno's pages,
went from doubted to off target.

| Leaf | MeSH proposal | Journal proposal |
| --- | --- | --- |
| med.surg | 10 phrases: General Surgery, Surgeons, Surgical Procedures, Postoperative Complications, Surgical Wound Infection, Perioperative Care, Enhanced Recovery After Surgery, Laparoscopy, Bariatric Surgery, Anastomotic Leak | not proposed |
| med.path | 10 descriptors: Pathology, Clinical; Pathology, Molecular; Pathology, Surgical; Forensic Pathology; Telepathology; Pathologists; Autopsy; Cytodiagnosis; Frozen Sections; Neoplasm Grading | 25 journals of surgical, clinical, molecular, cyto-, neuro-, dermato-, head and neck, endocrine and forensic pathology and pathology informatics, without the experimental pathology journals |
| med.tox | 22 descriptors: Toxicology; Forensic Toxicology; Toxicity Tests; Mutagenicity Tests; Carcinogenicity Tests; Toxicokinetics; Adverse Outcome Pathways; Poisoning; Poison Control Centers; Antidotes; Chemical and Drug Induced Liver Injury; Endocrine Disruptors; Xenobiotics; Mutagens; Carcinogens; Teratogens; Hazardous Substances; Mycotoxins; Marine Toxins; Venoms; Snake Bites; Animal Testing Alternatives | 25 journals of human, mammalian, genetic, clinical and regulatory toxicology and toxinology, without ecotoxicology and environmental-science journals |
| med.immuno | 14 descriptors: Allergy and Immunology; Hypersensitivity; Anaphylaxis; Urticaria; Angioedema; Allergens; Desensitization, Immunologic; Rhinitis, Allergic; Immunologic Deficiency Syndromes; Primary Immunodeficiency Diseases; Common Variable Immunodeficiency; Severe Combined Immunodeficiency; Mastocytosis; Eosinophilic Esophagitis | 17 allergy and clinical immunology journals |

Seven keyless requests, four at 20:19 UTC and three at 20:30 UTC, each
matching 20,463 to 268,008 records with an abstract in the ten years. The sheets were built
and labelled as for the label samples, by three fresh agent contexts: one for
the toxicology and surgery MeSH sheets, one for the clinical immunology and
pathology MeSH sheets, one for the three journal sheets.

| Leaf | MeSH, on target of 15 | Journals, of 15 | Decision |
| --- | --- | --- | --- |
| med.surg | 12 | not sampled | Admitted with its MeSH query |
| med.path | 7 | 12 | Admitted with its journals |
| med.tox | 5 | 9 | Rejected |
| med.immuno | 8 | 9 | Rejected |

med.surg's sample holds four trials of transcatheter against surgical valve
replacement and two versions of the SCARE case-report guideline, labelled on
target; its misses were a bile-acid review, a review of patient decision aids
and a doubted perioperative-chemotherapy trial. The four valve trials match
only through `Postoperative Complications`; without them the page would be 8
of 15, and that descriptor also brings other specialties' trials whose
patients had operations into the yearly lists. med.path's journal sample
doubted two neuroscience reviews and an acute lung injury review. The
rejected samples missed on papers outside the specialty: for med.tox, records
the descriptors tag in passing (oncology, diabetes, liver tests, chemistry
reviews) and, in its journals, fragrance exposure models, food antioxidant
methods and general oxidative-stress reviews; for med.immuno, a heart-failure
trial, a leukaemia classification, biomaterials and breastfeeding papers and
doubted basic immunology, and, in its journals, COVID-19 clinical papers, a
microRNA methods review and a chronic obstructive pulmonary disease review.
med.tox and med.immuno keep no notable lane.

The evidence file keeps each leaf's latest sample, which replaces its label
sample above (that one is in Git history, #389 at `00119d13`); the journal
samples' queries name every ISSN. The MeSH samples of med.path, med.tox and
med.immuno, the proposals, NLM's lookups and the ISSN checks, like every
sheet, key and raw response, stay local. med.surg and med.path have no OpenAlex
notable listing, so Europe PMC's is their only one: ten Europe PMC calls a
week each and up to 2,000 new papers on their first night. Authorized by
Nicolás on 2026-10-26, with the listing by MeSH descriptors or journals.
