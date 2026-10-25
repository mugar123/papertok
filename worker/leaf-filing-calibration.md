# Leaf filing calibration

Status: proposed on 2026-10-24 (ENG-107).

## Context

The harvest's area lanes hold OpenAlex journal articles labelled with an area,
not a leaf. Step 9 of the harvest ([worker/README.md](README.md#paper-store))
files one under a leaf only in an area with a rule in `LEAF_FILING_RULES`
(`worker/leaf-filing.ts`): the article's vector must reach the rule's
similarity to its closest leaf centroid and beat the next leaf by the rule's
margin. The product decision of 2026-10-23 is to file under a leaf only where
at least 90% of the filed held-out articles are correct, and otherwise to keep
the area's articles at area level.

## Decision

Mathematics gets a rule: similarity 0.58, margin 0.065. No other area gets one.

| Area | Labelled articles | Leaves with a centroid | Rule chosen on the calibration half | Held-out precision | Held-out recall | Held-out share filed | Area-lane sample filed | Shipped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| math | 343 | 16 of 17 | 0.58 / 0.065 | 0.98 (48/49), 0.893–0.996 | 0.43 (48/112), 0.341–0.521 | 0.35 (59/171), 0.278–0.419 | 28/100, 0.201–0.375 | yes |
| physics | 691 | 26 of 26 | 0.68 / 0.07 | 0.88 (22/25), 0.700–0.958 | 0.10 (22/229), 0.064–0.141 | 0.10 (35/345), 0.074–0.138 | 16/100, 0.101–0.244 | no: under 90%, and 25 decided filings, under 30 |
| cs | 510 | 20 of 21 | 0.69 / 0.05 | 0.78 (25/32), 0.612–0.890 | 0.15 (25/166), 0.104–0.213 | 0.13 (34/255), 0.097–0.181 | 4/100, 0.016–0.098 | no: under 90% |
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

In mathematics, 10 more held-out filings went to a leaf the article has no
label for: it was labelled off target for another mathematics leaf only. They
are outside precision; counted as wrong, precision would be 48/59 (0.81). The
rule's margin decides which articles are filed: similarities from 0.57 to 0.59
file the same held-out articles, and margins of 0.06 and 0.07 give a held-out
precision of 0.96 and 0.98.

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
  2026-10-24 (arXiv API). The harvest averages the newest 500 instead; scaling
  each leaf's similarities for a 500-paper mean leaves the mathematics outcome
  unchanged.
- Split and selection, fixed before any held-out result was computed: each
  area's labelled articles, ordered by id, are shuffled with seed 107 and
  halved. The grid is similarity 0.30 to 0.95 by 0.01 and margin 0 to 0.20 by
  0.005. On the calibration half, the rule with the most correct filings at
  95% precision or more over 20 decided filings or more is chosen; the area
  gets it only when its held-out precision is 90% or more over 30 decided
  filings or more.
- A filing is correct under a leaf labelled on target, wrong under one
  labelled off target or doubted, or under an unlabelled leaf while another
  leaf of the area is on target, and unknown otherwise.
- The area-lane sample is the newest 100 articles of each area under the
  harvest's own OpenAlex filter on 2026-10-24.

## Consequences

Each night the harvest stores a centroid for each mathematics leaf with 50
arXiv papers or more (16 in the sample), and files the mathematics area lane's
articles that the rule places. On the sample, that is about 28% of the lane. A filed
article reaches the readers of its leaf and leaves those of the other
mathematics leaves. The other areas' articles stay at area level.

The labelled articles come from topic-lane samples and venue reviews, not from
the area lanes. An area lane keeps only the articles no leaf's own lane holds,
so its articles may be harder to place than the labelled ones.

## Reproduce

The dataset (arXiv and OpenAlex ids, labels and int8 vectors, no text) is
kept outside the repository. With it:

```bash
node worker/test-support/calibrate-leaf-filing.ts dataset.json worker/test-support/leaf-filing-held-out.json
```

The command prints each area's report and writes the centroids and held-out
articles of the areas that get a rule. `worker/leaf-filing.test.ts` files that
fixture with the shipped rules and checks the measured outcome.
