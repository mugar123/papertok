# Europe PMC notable leaves

Which medicine and biology leaves' notable lanes also list Europe PMC's
most-cited records (`europepmc-notable` in `worker/paper-sources.ts`), and the
evidence for each.

```bash
node scripts/generate-europepmc-notable-leaves.ts
node scripts/generate-europepmc-notable-leaves.ts --check
```

The generator reads `scripts/data/europepmc-notable-reviews.json` and writes
`worker/europepmc-notable-leaves.generated.ts` (`EUROPE_PMC_NOTABLE_LEAVES`)
and the report `scripts/data/europepmc-notable-coverage.json`. `npm test` runs
`--check`. The generator does not call Europe PMC.

## The listing

For each of the ten completed years before the current one, an admitted leaf's
notable lane lists Europe PMC's 100 most-cited records first published that
year whose title, abstract or keywords name the leaf, with the label query of
the medicine and biology category lanes without their date range
(`europePmcLabelQuery` in `src/services/domain-source-records.ts`):

`query=<europePmcLabelQuery([leaf])> AND FIRST_PDATE:[<year>-01-01 TO <year>-12-31] AND (SRC:MED OR SRC:PPR) NOT PUB_TYPE:"retracted publication" NOT PUB_TYPE:"retraction of publication" NOT PUB_TYPE:"published erratum" NOT ((PUB_TYPE:"editorial" OR PUB_TYPE:"letter" OR PUB_TYPE:"comment") AND HAS_ABSTRACT:n) sort_cited:y`, `resultType=core`, `pageSize=100`

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
| `query` | `<europePmcLabelQuery([leaf])> AND PUB_YEAR:[<Y−10> TO <Y−1>] AND HAS_ABSTRACT:y sort_cited:y` |
| `format`, `resultType` | `json`, `core` |
| `pageSize`, `page` | `15`, `1` |

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
sample. A leaf whose label matches fewer than 1,000 records in the ten
years (`small-population`) is not admitted however its sample reads: the
listing, 100 a year, would take nearly every record, uncited ones included,
and the sample measures only the most cited. A passing leaf joins
`EUROPE_PMC_NOTABLE_LEAVES`. The sample is evidence about the head of the
population, not about a year's 100th record; the check after the lanes deploy
counts each admitted lane's records and citations a year. Each batch of
admitted leaves changes what every reader of those leaves is shown, so it is
authorized under AGENTS.md before it is committed.

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
