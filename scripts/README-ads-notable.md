# ADS notable leaves

Which arXiv categories' notable lanes list only the papers arXiv files under
them first (`ads-notable` in `worker/paper-sources.ts`), and the evidence for
each.

```bash
node scripts/generate-ads-notable-leaves.ts
node scripts/generate-ads-notable-leaves.ts --check
```

The generator reads `scripts/data/ads-notable-reviews.json` and writes
`worker/ads-notable-leaves.generated.ts` (`ADS_NOTABLE_OWN_CLASS_LEAVES`) and
the report `scripts/data/ads-notable-coverage.json`. `npm test` runs
`--check`. The generator does not call ADS.

## The listing

For each of the ten completed years before the current one, the notable lane
of an arXiv category lists NASA ADS's 100 most-cited papers of the class
(`worker/README.md`, step 3). ADS's `arxiv_class` names every class a paper is
listed in, arXiv's primary class first, so the listing of a class also takes
the papers cross-listed to it. ADS cannot be asked for the first class alone:
its search help documents the `pos()` operator for author, affiliation and
title only.

For a leaf of `ADS_NOTABLE_OWN_CLASS_LEAVES`, the listing keeps only the papers
whose first class is the leaf (`fetchAdsNotable` in `worker/physics-api.ts`).
It asks ADS for the bibcodes and classes of the year's 2,000 most-cited papers
of the class (`fl=bibcode,arxiv_class`, `rows=2000`, waiting up to 15
seconds), then for the records of the first 100 of them whose first class is
the leaf (`q=bibcode:("…" OR …)`), most cited first. A cross-listed paper can
still reach the lane of its own class. The other arXiv categories' listings
are unfiltered.

## Evidence

`ads-notable-reviews.json` has one key, `leaves`, keyed by leaf. Each leaf
holds two samples, `listed` and `ownClass`. A sample holds `capturedAt`, the
`query` as sent (the token travels in a header), `numFound` (every record the
query matched), every sampled record (`bibcode`, `title`, `year`,
`citationCount`, `arxivClass`) and one label per record: `on-target`,
`off-target`, or `uncertain: true` without a label for a call the labeller
doubted, which counts as a miss.

The query must be exactly this, with Y the capture year:

| Parameter | Value |
| --- | --- |
| `q` | `arxiv_class:"<leaf>" year:<Y−10>-<Y−1> doctype:(article OR eprint OR inproceedings)` |
| `fl` | `bibcode,title,abstract,year,pubdate,doi,identifier,arxiv_class,citation_count,doctype,pub,property` |
| `sort`, `start` | `citation_count desc`, `0` |
| `rows` | `15` for `listed`, `2000` for `ownClass` |

`listed` is the page as ADS returned it: the listing without the filter.
`ownClass` is the first 15 records of the page of 2,000 whose first class is
the leaf, in the page's order. The records must fall in the ten years, in
non-increasing citation order, name the leaf among their classes (in
`ownClass`, as the first) and carry one label each.

## Decision

The gate of the topic, venue and Europe PMC lanes, applied to `ownClass`: a
full page of 15, at least 10 on target without doubt. A passing leaf joins
`ADS_NOTABLE_OWN_CLASS_LEAVES`; a leaf whose sample fails keeps the unfiltered
listing every arXiv category has (`ADS_NOTABLE_LEAVES` in
`worker/paper-sources.ts`). The report gives each leaf the `status`,
`sampleSize`, `onTarget`, `precision` and `numFound` of both samples; `listed`
admits nothing and records how the listing read without the filter. The
sample is evidence about the head of the population, not about a year's
100th paper. Each batch of admitted leaves changes what every reader of those
leaves is shown, so it is authorized under AGENTS.md before it is committed.

## The 2026-10-26 sample

The 15 arXiv categories whose notable lane had no other listing were sampled:
cs.AI, cs.GT, cs.MM, math.AG, math.CA, math.GR, math.GT, nucl-ex, nucl-th and
the six finance leaves. Nicolás asked ADS with his token: the `listed` pages
between 20:31 and 20:32 UTC, the pages of 2,000 between 20:32 and 20:35. Each
leaf's sheet held both samples, shuffled under opaque row IDs, with the title
and the first 1,500 characters of the abstract and nothing else; a record in
both samples was one row. Four fresh agent contexts labelled them, one per
area (computer science, mathematics, nuclear physics, quantitative finance),
each given only its own sheets, answering whether a researcher who chose the
leaf would recognise the article as a notable work of their field. The labels
were joined to the records afterwards. All 15 leaves passed on `ownClass`; the
counts are records on target without doubt, of 15.

| Leaf | `listed` | `ownClass` |
| --- | --- | --- |
| cs.AI | 15 | 15 |
| cs.GT | 9 | 14 |
| cs.MM | 15 | 15 |
| math.AG | 5 | 15 |
| math.CA | 9 | 12 |
| math.GR | 6 | 14 |
| math.GT | 9 (one doubted) | 13 (one doubted) |
| nucl-ex | 6 (one doubted) | 15 |
| nucl-th | 6 (seven doubted) | 15 |
| q-fin.CP | 11 | 10 |
| q-fin.PM | 9 | 14 |
| q-fin.PR | 12 | 13 |
| q-fin.RM | 8 (two doubted) | 10 |
| q-fin.ST | 11 | 12 (one doubted) |
| q-fin.TR | 10 | 13 (one doubted) |

Without the filter, 9 leaves fail. Most of their misses were filed under
another class first:

| Leaf | Misses without the filter, by first class |
| --- | --- |
| cs.GT | cs.LG 2, cs.AI, cs.CL, cs.CV, quant-ph: GAN training, adversarial machine learning, fairness, emergent language, a quantum neural network |
| math.AG | hep-th 10: F-theory, 5d and 6d SCFTs, flux compactifications |
| math.CA | cs.LG, stat.ML, math.OC, hep-ph, physics.soc-ph, nlin.SI |
| math.GR | hep-th 4, gr-qc, math-ph, math.PR, quant-ph, and a math.GR record of an optical-fibre sensor |
| math.GT | hep-th 3 (one doubted), cond-mat.str-el 2, math.SG |
| nucl-ex | hep-ph 5: hadron spectroscopy reviews, parton distributions, the Standard Model muon g-2; astro-ph.HE 2: a NICER radius, a neutron-star review; cond-mat.str-el; hep-ex, the muon g-2 measurement (doubted) |
| nucl-th | astro-ph.HE 5: NICER masses and radii, a neutron-star review; hep-ph 3: two hadron reviews, the Standard Model muon g-2; cond-mat.str-el. Seven of the nine were doubted |
| q-fin.PM | q-fin.MF 2, q-fin.TR 2, quant-ph, q-fin.PM: automated market makers, a language-model trading agent |
| q-fin.RM | quant-ph 2, q-fin.CP, q-fin.GN, q-fin.ST, q-fin.TR, q-fin.RM (two doubted) |

For all 225 `listed` records, the class ADS lists first was arXiv's primary
category (checked with arXiv's API on 2026-10-26). The same evening the
filtered listing was run against ADS for cs.AI 2022, nucl-th 2018 and
q-fin.PR 2016: each returned exactly the papers filed under the leaf first in
that year's page of 2,000 captured earlier (100, 100 and 67), most cited
first, in 1.3 to 5.6 seconds for both calls.

cs.AI and cs.MM passed without the filter: their labeller counted GPT-4,
Llama 2, the Vision Transformer and ControlNet, cross-listed from cs.CL and
cs.CV, as notable works of artificial intelligence and multimedia. A second
fresh context labelled the computer science sheets again as a check and
reached the same outcomes (cs.AI 15 and 15, cs.MM 13 and 15, cs.GT 7 and 12);
the evidence holds the first labelling. The journal sample of the same day had rejected their
journals at 9 and 3 (`README-openalex-leaf-venues.md`). All 15 listings keep
only the papers filed under the leaf first.

Each year's page of 2,000, asked by Nicolás between 20:35 and 20:43 UTC the
same day (not in the evidence file), gives the size of the filtered listings.
The computer science, mathematics and nuclear leaves still list 100 papers a
year (cs.MM: 136 of its 1,000 have no ADS citation). The six finance leaves
have fewer papers filed under them first, and ADS counts few citations of
finance journals:

| Leaf | Own papers, 2016–2025 | Years with under 100 | Listed with the filter (no ADS citation) | Listed without it, of all records (no ADS citation) |
| --- | --- | --- | --- | --- |
| q-fin.CP | 1,113 | 4 | 891 (39 %) | 990 of 2,229 (15 %) |
| q-fin.PM | 936 | 7 | 827 (55 %) | 976 of 1,541 (34 %) |
| q-fin.PR | 602 | 10 | 602 (69 %) | 979 of 1,042 (62 %) |
| q-fin.RM | 1,051 | 5 | 882 (59 %) | 1,000 of 1,905 (25 %) |
| q-fin.ST | 1,537 | 2 | 976 (20 %) | 1,000 of 2,398 (7 %) |
| q-fin.TR | 875 | 7 | 802 (37 %) | 960 of 1,421 (17 %) |

Unlike Europe PMC's, this gate has no population floor; here a floor would
leave a finance leaf's listing unfiltered rather than remove it. Nicolás chose
the filtered listing for the finance leaves too, as he kept the journal lanes
whose listing reaches every work. For these leaves the sample says nothing
about the papers beyond the 15 most cited.

These lanes were first listed without the filter. A lane's next weekly
listing names only its own papers, and a cross-listed paper leaves the lane
14 days after the last listing that named it (`work_lanes.listed_until`).
