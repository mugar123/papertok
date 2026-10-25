# Leaf filing calibration

Status: proposed on 2026-10-24 (ENG-107).

## Context

The harvest's area lanes hold OpenAlex journal articles labelled with an area,
not a leaf. Step 9 of the harvest ([worker/README.md](README.md#paper-store))
files one under a leaf only in an area with a rule in `LEAF_FILING_RULES`
(`worker/leaf-filing.ts`): the article's vector must reach the rule's
similarity to its closest leaf centroid and beat the next leaf by the rule's
margin. The product decision of 2026-10-23 is to file under a leaf only where
held-out precision is at least 90%, and otherwise to keep the area's articles
at area level. Precision here is over the held-out filings that the labels
decide. A filing under a leaf the article has no label for, while no leaf of
the area is on target for it, is reported as unknown and left out of
precision.

## Decision

Mathematics gets a rule: similarity 0.58, margin 0.065. No other area gets one.

| Area | Labelled articles | Leaves with a centroid | Rule chosen on the calibration half | Held-out precision | Held-out recall | Held-out share filed | Area-lane sample filed | Shipped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| math | 343 | 16 of 17 | 0.58 / 0.065 | 0.98 (48/49), 0.893–0.996 | 0.43 (48/112), 0.341–0.521 | 0.35 (59/171), 0.278–0.419 | 28/100, 0.201–0.375 | yes |
| physics | 685 | 26 of 26 | 0.63 / 0.085 | 0.84 (37/44), 0.706–0.921 | 0.17 (37/222), 0.123–0.221 | 0.15 (51/342), 0.115–0.191 | 20/100, 0.133–0.289 | no: under 90% |
| cs | 509 | 20 of 21 | 0.68 / 0.05 | 0.76 (25/33), 0.590–0.872 | 0.15 (25/166), 0.104–0.213 | 0.14 (35/254), 0.101–0.186 | 5/100, 0.022–0.112 | no: under 90% |
| q-fin | 141 | 4 of 8 | none | | | | | no |
| eess | 162 | 3 of 7 | none | | | | | no |
| econ | 173 | 3 of 3 | none | | | | | no |

Ranges are Wilson 95% intervals. Precision counts the filings whose outcome
the labels decide; recall is over the held-out articles labelled on target for
a leaf of the area. In q-fin, eess and econ no rule reached 95% precision over
20 decided filings on the calibration half (the best reached 0.57, 0.85 and
0.81), so nothing was measured on their held-out halves. Half the leaves of
q-fin publish under 50 arXiv papers in 90 days, and four of the seven eess
leaves (telecommunications, electronics, power, optics) are not arXiv
categories: neither has a centroid, so their articles can only be filed wrong.
Mechanical, civil and chemical engineering have no arXiv leaf, so no centroid.

In mathematics the point estimate meets the bar: 48 of 49 decided held-out
filings are correct. The lower end of its interval, 0.893, is below 0.9. Ten
more held-out filings, and seven on the calibration half, went to a leaf the
article has no label for; each of those articles is labelled only off target
or doubted for other mathematics leaves. They are outside precision. Counted
as wrong, held-out precision would be 48 of 59 (0.81), and it stays at 0.9 or
more only if at most four of the ten are wrong. Blind labels for the leaf each
of these 17 articles went to would turn the unknowns into outcomes.

## Method

- Labels: `scripts/data/openalex-topic-reviews.json` and the blind labels of
  two later reviews kept outside the repository (venue samples for physics,
  mathematics, computer science and engineering; economics and finance
  samples), as (OpenAlex work, leaf) pairs. A pair is on target,
  off target or doubted; a doubted or uncertain call, or two calls that
  disagree, is doubted, and only an on-target pair is a positive.
- Vectors: `@cf/qwen/qwen3-embedding-0.6b` on Workers AI, from the text the
  corpus embeds, kept in the stored form (`quantize` in `paper-store.ts`). The
  texts were taken from `ingestPapers` and `embedPending` on a local D1.
- Centroids: `leaf_centroids` was empty in production, as no area had a rule.
  They were computed with `leafCentroids` from up to 60 of each arXiv leaf's
  65 newest papers with that primary category, submitted in the 90 days before
  2026-10-24 (arXiv API). The harvest averages the newest 500 instead; see
  [Checks outside the command](#checks-outside-the-command).
- Left out: a labelled article whose OpenAlex record names one of those arXiv
  papers as its preprint, matched by arXiv id. That is six in physics, one in
  computer science and none in mathematics. Its preprint is part of the
  centroid it would be scored against, and in the corpus that preprint's leaf
  already holds it, so similarity never files it.
- Split and selection, fixed before any held-out result was computed: each
  area's labelled articles, ordered by id, are shuffled with seed 107 and
  halved. The grid is similarity 0.30 to 0.95 by 0.01 and margin 0 to 0.20 by
  0.005. On the calibration half, the rule with the most correct filings at
  95% precision or more over 20 decided filings or more is chosen; the area
  gets it only when its held-out precision is 90% or more over 30 decided
  filings or more. The left-out articles were removed after the first
  results; that changed the physics and computer science rows and nothing in
  mathematics.
- A filing is correct under a leaf labelled on target, wrong under one
  labelled off target or doubted, or under an unlabelled leaf while another
  leaf of the area is on target, and unknown otherwise.
- The area-lane sample is the newest 100 articles of each area under the
  harvest's own OpenAlex filter on 2026-10-24.

## Checks outside the command

These come from scripts run on the same dataset outside the repository; the
committed command does not produce them. None of them changes the decision.

- Neighbouring rules: similarities from 0.57 to 0.59 file the same 59
  held-out mathematics articles. Margins of 0.06 and 0.07 give a held-out
  precision of 0.96 (51/53) and 0.98 (46/47).
- Centroid size: scaling each leaf's similarities for a 500-paper mean files
  the same 59 held-out articles.
- Centroid composition: each leaf's 60 papers span 2 days (math.AP) to 15 days
  (math.LO), while the harvest's 500 cover weeks, so production centroids
  point somewhat differently. With centroids from disjoint 30-paper halves of
  each leaf's papers, rescaled to 500, 40 draws gave a held-out precision of
  0.91 to 1.0 (median about 0.96) and filed 23 to 35 of the 100 area-lane
  articles. With any one leaf's centroid removed, held-out precision ranged
  from 0.92 to 0.98.

## Consequences

Each night the harvest stores a centroid for each mathematics leaf with 50
arXiv papers or more (16 in the sample), and files the mathematics area lane's
articles that the rule places: 28 of the newest 100 in the sample. A filed
article leaves the area lane, so readers of the other mathematics leaves no
longer get it. It joins its leaf's lane, where it competes by date with that
leaf's preprints. The other areas' articles stay at area level.

Joining the leaf lane also shortens how far back a reader of many leaves gets
the article. The category feed reads the newest `floor(800 / area lanes asked)`
papers of an area lane: all 373 articles of the mathematics lane (published
2026-10-06 to 2026-10-24) for a reader whose leaves are all mathematics. It
reads the newest `ceil(4,000 / leaf lanes asked)` papers of a leaf lane. In the
30 days to 2026-10-22, the arXiv API counts from 185 (math.LO) to 1,409
(math.CO) papers in each mathematics leaf with a centroid, cross-lists
included. A reader of 12 leaves (334 papers a leaf) therefore reaches back
about 7 days in math.CO and math.AP and 54 days in math.LO. A reader of 4
leaves (1,000) reaches back 21 to 162 days, and a reader of one leaf (4,000)
about the whole 90-day corpus. Leaf
lanes also take papers from other sources, so these spans are upper bounds. A
filed article older than its reader's span is no longer a candidate for that
reader, though at area level it was. A local probe with 400 newer math.CO
preprints showed this: a reader of 12 leaves got a filed article published 14
days earlier before filing and not after, while readers of 1 and 4 leaves
still got it.

The feed could keep the window by reading the journal articles in an asked
area's leaf lanes within the area lanes' share, so that filing narrows who
gets an article without shortening how far back they get it. That changes how
the feed selects papers and is not part of this decision.

The labelled articles come from topic-lane samples and venue reviews, not from
the area lanes. An area lane keeps only the articles no leaf's own lane holds,
so its articles may be harder to place than the labelled ones.

## Reproduce

Only the mathematics held-out half is in the repository, as the fixture the
command below writes. The full dataset is `leaf-filing-dataset.json` (2.8 MB,
SHA-256 `7f69e4f88ce598d5db72a454b745ae48724b626a5dc61fe80210c100f0b37e35`):
arXiv and OpenAlex ids, labels, the arXiv ids each labelled article's OpenAlex
record names, and int8 vectors, with no text. It was built from the aggregated
labels `labels.json` (SHA-256
`730abb9b5393feb9a93737feb61bf28446156e05a95d8657268a7b715530c85c`), which
collect the repository's topic reviews and the venue and economics and
finance review labels. The dataset, `labels.json` and those review labels
exist only in temporary folders on the laptop that ran the calibration. Until
they are stored somewhere durable, the calibration half and the other areas'
results cannot be rerun. Rebuilding the dataset takes about 75 Workers AI
embedding calls and a new arXiv pull, which returns different papers. With the
dataset:

```bash
node worker/test-support/calibrate-leaf-filing.ts leaf-filing-dataset.json worker/test-support/leaf-filing-held-out.json
```

The command prints each area's report and writes the centroids and held-out
articles of the areas that get a rule. `worker/leaf-filing.test.ts` files that
fixture with the shipped rules and checks the measured outcome.
