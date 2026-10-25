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

Since ENG-104, a leaf's venue lane files the articles of the journals a
labelled sample admitted for that leaf
([venue lanes](../scripts/README-openalex-leaf-venues.md)). Such an article
leaves its area lane before similarity is tried, so similarity only sees
articles from other journals.

## Decision

No area gets a rule. Every area's journal articles that no leaf's lane holds
stay at area level, as before.

| Area | Labelled articles scored | Left out: venue lane, own preprint | Leaves with a centroid | Rule chosen on the calibration half | Held-out precision | Held-out recall | Held-out share filed | Area-lane sample filed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| math | 166 | 177, 0 | 16 of 17 | 0.53 / 0.045 | 0.86 (24/28), 0.685–0.943 | 0.53 (24/45), 0.391–0.671 | 0.46 (38/83), 0.355–0.564 | 42/94, 0.350–0.547 |
| physics | 314 | 371, 6 | 26 of 26 | none | | | | |
| cs | 285 | 224, 1 | 20 of 21 | none | | | | |
| q-fin | 107 | 34, 0 | 4 of 8 | none | | | | |
| eess | 88 | 74, 0 | 3 of 7 | none | | | | |
| econ | 109 | 64, 0 | 3 of 3 | none | | | | |

Ranges are Wilson 95% intervals. Precision counts the filings whose outcome
the labels decide; recall is over the held-out articles labelled on target for
a leaf of the area. Mathematics misses the bar twice: its 28 decided held-out
filings are under 30, and 0.86 is under 0.9. Ten more of its 38 held-out
filings are unknown; were all ten correct, this rule would reach 34 of 38
(0.89), still under the bar. In the other areas no rule reached 95% precision over 20
decided filings on the calibration half, so nothing was measured on their
held-out halves. Half the leaves of q-fin publish under 50 arXiv papers in 90
days, and four of the seven eess leaves (telecommunications, electronics,
power, optics) are not arXiv categories: neither has a centroid, so their
articles can only be filed wrong. Mechanical, civil and chemical engineering
have no arXiv leaf, so no centroid.

The table is the run of 2026-10-24. Since then ENG-113 (#319) made cs.AI,
cs.LG, cs.CV, cs.CL and cs.NE the area `ai`, so the command now splits the
computer science row. `cs`: 235 articles scored (164 left out for a venue lane,
1 for its own preprint), 15 leaves with a centroid; the rule chosen on the
calibration half, 0.66 / 0.02, files 21 held-out articles, 15 correct, 3 wrong
and 3 unknown: 0.83 precision (15/18, 0.608–0.942), over fewer decided filings
than the 30 the bar asks for. `ai`: 60 articles scored (60 left out for a
venue lane), 5 leaves with a centroid, and no rule reaches 95% precision over
20 decided filings on the calibration half. No area has a rule, as in the
table.

### Before the venue lanes

The first calibration, on the same dataset before ENG-104 was merged, also
scored the articles the venue lanes now take. It chose similarity 0.58 and
margin 0.065 for mathematics: 48 of 49 decided held-out filings were correct
(0.893–0.996), and 10 more were unknown, so 48 of 59 filed articles were known
to be correct. Physics reached 0.88 (22/25) and computer science 0.78 (25/32),
both under the bar. After the seven articles whose preprint builds a centroid
(six physics, one computer science) were left out, still before the venue
lanes, the rules chosen reached 0.84 (37/44) and 0.76 (25/33); mathematics has
no such article and did not change. Split by journal, in a check outside the
committed command, that mathematics rule filed 33 of the 87 held-out articles
from journals a mathematics venue lane now takes: 31 correct and 2 unknown. It
filed 26 of the 84 from other journals: 17 correct, 1 wrong and 8 unknown.
Only articles of the second kind still reach similarity, and their 18 decided
filings are under the 30 the bar asks for.

## Method

- Labels: `scripts/data/openalex-topic-reviews.json` and, in
  `scripts/data/openalex-venue-reviews.json`, the blind labels of two later
  reviews (venue samples for physics, mathematics, computer science and
  engineering; economics and finance samples), among them the samples the
  curators did not recommend (`otherSamples`), as (OpenAlex work, leaf) pairs.
  A pair is on target, off target or doubted; a doubted or uncertain call, or
  two calls that disagree, is doubted, and only an on-target pair is a
  positive.
- Vectors: `@cf/qwen/qwen3-embedding-0.6b` on Workers AI, from the text the
  corpus embeds, kept in the stored form (`quantize` in `paper-store.ts`). The
  texts were taken from `ingestPapers` and `embedPending` on a local D1.
- Centroids: `leaf_centroids` was empty in production, as no area had a rule.
  They were computed with `leafCentroids` from up to 60 of each arXiv leaf's
  65 newest papers with that primary category, submitted in the 90 days before
  2026-10-24 (arXiv API). A leaf's papers span from under half a day (cs.LG,
  cs.CV) to 86 days (q-fin.CP, q-fin.RM); mathematics leaves span 1 day
  (math.AP) to 14 days (math.LO). The harvest averages the newest 500, which
  cover a different time in each leaf, so production centroids point somewhat
  differently.
- Left out before the split: an article whose OpenAlex record names one of
  those arXiv papers as its preprint, matched by arXiv id, because that
  preprint's leaf already holds it in the corpus and the preprint is part of
  the centroid; and an article, labelled or in the area-lane sample, that the
  venue lane of a leaf of the area takes (its journal listed in
  `worker/openalex-leaf-venues.generated.ts`, and its type and any topic or
  author-count filter matching), because that lane files it by journal.
- Split and selection, fixed before any held-out result was computed: each
  area's labelled articles, ordered by id, are shuffled with seed 107 and
  halved. The grid is similarity 0.30 to 0.95 by 0.01 and margin 0 to 0.20 by
  0.005. On the calibration half, the rule with the most correct filings at
  95% precision or more over 20 decided filings or more is chosen; the area
  gets it only when its held-out precision is 90% or more over 30 decided
  filings or more. Both exclusions were added after the first results, the
  preprint one in review and the venue one when ENG-104 was merged; the split
  and selection did not change.
- A filing is correct under a leaf labelled on target, wrong under one
  labelled off target or doubted, or under an unlabelled leaf while another
  leaf of the area is on target, and unknown otherwise.
- The area-lane sample is the newest 100 articles of each area under the
  harvest's own OpenAlex filter on 2026-10-24.

## Consequences

Nothing changes in production: no centroid is stored, and no article is filed
under a leaf by similarity. An area lane loses only the articles a leaf's lane
already holds.

Mathematics is the area closest to the bar. Blind labels for articles from
the mathematics area lane itself, from journals no venue lane takes, would
measure the articles similarity actually sees and add decided filings. Labels
for the leaf each unknown filing went to would turn those unknowns into
outcomes.

A rule shipped by a later calibration would also change who gets the articles
it files, and how far back. Only a category request reads area lanes: a
request with follows never does (`parseFeedRequest`), and the app sends
follows only in its separate followed-entities request, so no request
combines area lanes and follows. A category request asks for at most 10
leaves. It reads the newest `floor(800 / area lanes asked)` papers of an area
lane: all 373 articles of the mathematics lane (published 2026-10-06 to
2026-10-24) for a reader whose leaves are all mathematics. It reads the
newest `ceil(4,000 / non-area lanes asked)` papers of a leaf lane, the
non-area lanes being the reader's leaves and, when one of them is in economics
or q-fin, the working-paper series. There a filed article competes by date
with the leaf's preprints. In the 30 days to 2026-10-22, the arXiv API counts
from 185 (math.LO) to 1,409 (math.CO) papers in each mathematics leaf with a
centroid, cross-lists included. A reader of 10 leaves therefore gets the
newest 400 papers of each leaf (364 when the working-paper series takes a
share) and reaches back about 8 to 9 days in math.CO and math.AP and 59 to 65
days in math.LO. A reader of 4 leaves (1,000, without the series) reaches
back from 21 days in math.CO to the whole 90-day corpus in math.LO, math.RA
and math.GT, and a reader of one leaf (4,000) about the whole corpus in each
leaf. Leaf lanes also take papers from other sources, venue lanes among
them, so these spans are upper bounds. A filed article older than its
reader's span is no longer a candidate for that reader, though at area level
it was. A local probe with 400 newer math.CO preprints showed this for a
reader of 12 leaves, the most the Worker accepts: a filed article published
14 days earlier was a candidate before filing and not after, while readers of
1 and 4 leaves still got it.

Filing also adds candidates. The followed-entities request never reads area
lanes, so an article kept at area level could not reach, through that
request, a reader who follows its leaf as a topic. A filed article sits in the
leaf's lane, which that request reads for the topic follow, and can. The
category request already reads the area lane for such a reader when the
followed leaf is among its 10 categories, as followed topics join them. What
filing adds there is the card that names the follow. It adds reach when the
leaf is not among those 10, or when the topic lookup misses its time budget.

The feed could keep the window by reading the journal articles in an asked
area's leaf lanes within the area lanes' share, so that filing narrows who
gets an article without shortening how far back they get it. That changes how
the feed selects papers and would be a decision of its own.

The labelled articles come from topic-lane samples and venue reviews, not from
the area lanes, so even after the exclusions they may be easier to place than
an area lane's articles.

## Reproduce

The labels are in the repository: all 2,785 (OpenAlex work, leaf) pairs of the
areas with an area lane, in `scripts/data/openalex-topic-reviews.json` and
`scripts/data/openalex-venue-reviews.json`. Of them, 281 pairs (physics,
economics, finance and engineering) were in neither file before ENG-107: they
belong to samples the curators took and did not recommend, now the `otherSamples`
of the venue file, with the same fields as its other samples
([evidence](../scripts/README-openalex-leaf-venues.md#evidence)). No lane
changes: `scripts/generate-openalex-leaf-venues.ts` reads `sources` and
`leaves` only, so its outputs are as before. The aggregated labels the dataset
was built from, `labels.json` (SHA-256
`730abb9b5393feb9a93737feb61bf28446156e05a95d8657268a7b715530c85c`), held the
same 2,785 pairs with the same labels.

The vectors are not in the repository. The dataset is
`leaf-filing-dataset.json` (3.0 MB, SHA-256
`613a20ce25494b5af27eb3a56f80cd214237afac758cae1b731a857977a96e64`), attached
to ENG-107 in Linear as "Leaf-filing calibration dataset (vectors and
labels)": arXiv and OpenAlex ids, labels, each labelled article's arXiv ids and
OpenAlex source, type, primary topic and author count, and int8 vectors, with
no text. It holds 1,984 labelled articles with 2,269 of the 2,785 pairs. The
other 516 have no vector in it; 512 of them are of mechanical, civil and
chemical engineering leaves, which have no arXiv category and so no centroid
to score them against. With the dataset downloaded and `sha256sum` matching:

```bash
node worker/test-support/leaf-filing-labels.ts leaf-filing-dataset.json
node worker/test-support/calibrate-leaf-filing.ts leaf-filing-dataset.json worker/test-support/leaf-filing-held-out.json
```

The first command compares the dataset's labels with the review files'
(`labelsFromReviews`: a pair two samples call differently is doubted). It
prints the articles and pairs of the dataset, the articles whose labels
differ, none for this dataset, and the pairs of the files the dataset holds no
vector for, 516. It exits with 1 when an article's labels differ. The second
prints each area's report and writes the centroids and held-out articles of
the areas that get a rule, none at present. `worker/leaf-filing.test.ts`
checks that each shipped rule has them and files them as calibrated.

A dataset's `labelled[].labels` are rebuilt from the files, not from the
vectors: after a label changes in the files, set the labels of the articles
the first command lists to what `labelsFromReviews` gives. A labelled article
new to the dataset also needs its vector, the Workers AI embedding of the
text the corpus embeds, from its OpenAlex record by work ID, and its
`openAlex` fields and `arxivIds` from the same record. Rebuilding the whole
dataset without the attachment takes those records for every labelled
article, about 75 Workers AI embedding calls and a new arXiv pull, which
returns different papers. Its `areaSamples` are the newest 100 articles of
each area on 2026-10-24 and cannot be taken again.
