# OpenAlex venue lanes

`worker/openalex-leaf-venues.generated.ts` lists, for each leaf with a venue
lane, the OpenAlex source IDs of the journals (and, for computer science,
statistics and electrical engineering, the proceedings) whose newest articles
the nightly harvest files under that leaf (`openalex-venues` in
`worker/paper-sources.ts`, PAP-104). Generate it, and the per-leaf report
`scripts/data/openalex-leaf-venues-coverage.json`, from the evidence in
`scripts/data/openalex-venue-reviews.json`:

```bash
node scripts/generate-openalex-leaf-venues.ts
node scripts/generate-openalex-leaf-venues.ts --check
```

`--check` fails when either output differs from what the evidence produces;
`npm test` runs it. The generator does not call OpenAlex.

## Evidence

`openalex-venue-reviews.json` has three keys:

| Key | Contents |
| --- | --- |
| `sources` | Each source ID the samples of `leaves` asked for, with the `name`, `publisher` and `type` (`journal`, `conference`) its curator verified with `/sources/<id>`, and `leaves`, the leaves its curator filed it under: the curated lists, kept here only. A source filed under none was sampled but left off the lists: the excluded insurance, derivatives and market microstructure journals of q-fin.RM, q-fin.PR and q-fin.TR, and the optional Journal of Portfolio Management and Financial Analysts Journal of q-fin.PM. Nine computer science sources the curator dropped after sampling (eight with no work since 2024, one re-dated repository copy) have no record, nor do the 24 sources only the queries of `otherSamples` name; a source without one cannot enter a lane. |
| `leaves` | Per taxonomy leaf: `sample`, the leaf's labelled sample, and optionally `sourceSamples`, samples of one of its sources each |
| `otherSamples` | Labelled samples that no gate reads, each with the `leaf` it was taken for. The generator ignores them; they are label evidence for the leaf-filing calibration ([worker/leaf-filing-calibration.md](../worker/leaf-filing-calibration.md#reproduce)). 38 samples of 537 works (472 distinct): for physics (10) and engineering (9), lists the curators tried and did not recommend; for economics and finance (19), the lists with and without `has_abstract:true`, the econ.EM list with the Journal of Applied Econometrics, the own samples of six econ.GN journals and of the Journal of Financial and Quantitative Analysis, three econ.GN topic queries and the sample of Quantitative Finance. That one names no leaf: each of its labels carries the `leaf` its labeller judged nearest, and its tenth article (newest first), judged nearest to two leaves, is left out |

A sample holds `capturedAt`, the `query` as sent without the sampler's
address (cs.DS's was derived, below), every returned work (`id`, `type`,
`title`, `publication_date`, `source`, and `primary_topic` when the query
filtered on topics) and one label per work: `on-target`, `off-target`, or
`uncertain: true` without a label for a call the labeller doubted, which
counts as a miss. A sample of `otherSamples` may hold fewer than 15 works and
may ask a topic query without sources (the three econ.GN topic samples).

## The gate

A sample is page 1 of 15, newest first, of one OR filter over the leaf's
sources, with `type:article` (`article|conference-paper` where proceedings
count), the 90 days through its capture day (or the day before, for a sample
taken after midnight UTC), `is_retracted:false`, optionally
`has_abstract:true`, and optionally one topic filter and one author-count
filter. Nothing else is accepted. The day before is a departure from the topic
lanes' gate, which takes only the window through the capture day: every
sample but economics and finance's was taken between 02:06 and 02:54 UTC on
2026-10-24 with the window that ended on 2026-10-23.

A leaf passes with a full page of 15 and at least 10 on target without doubt,
the topic lanes' rule (`README-openalex-leaf-topics.md`). Its lane then asks
for the sources its curator filed under it that have at least one article on
target without doubt, or whose own sample passes the leaf's gate: a full page
of 15, asked with the leaf's filters (the same types, abstract filter and
topic or author filter), at least 10 on target. A sample tests the curated
list and does not add to it: a leaf whose sample passes on sources its curator
left out has no lane (`not-curated` in the report).
The leaf's precision says nothing about a source its 15 newest did not reach,
so such a source stays out, as a topic does in a topic lane. Every source a
lane asks for must be one the review rule calls reviewed
(`openAlexPeerReviewed`): a listed working-paper series cannot enter.

The lane asks with the sample's type and topic or author filter, the live
window and `is_retracted:false`. It does not ask `has_abstract:true`
(Pablo, 2026-10-23: it drops most closed Elsevier, Springer and University of
Chicago Press articles), so a card without an abstract says "No abstract
available". It does not ask `primary_location.source.is_core:true`: the
sources are named, and six of them are not core in OpenAlex: the three
conferences the lanes ask for (ICPP, SPLASH and PIMRC), npj Soft Matter,
Natural Language Processing and ACM Transactions on Information Systems. The
mathematics curator did not record the core flag of its 42 sources.

The nightly run harvests the venue lanes before the working-paper series, so
a journal article and its working paper listed the same night merge into the
journal's reviewed row (#198, PAP-85). So do the two listed on one page, in
either order: with the working paper first, `asJournalRow`
(`worker/paper-store.ts`) merges the journal record first. Working papers usually appear first. An OpenAlex working paper
stored on an earlier night becomes the journal's reviewed row when OpenAlex
lists its journal article (`ingestPapers`, ENG-133): the row takes the
article's DOI, landing page and answer, drops the Working paper tag, keeps the
working paper's `false` under its own DOI, and keeps its row and the id readers
liked or saved it under. A page that lists the working paper before its
article starts the row the same way, under the id of the page's first record.
The series listing the working paper again does not put its title and
abstract back on the row. The two records pair on the title and first-author
key (`PaperBuilder.identityKeys`), as before, because they share no DOI or
OpenAlex id; the upgrade now lets that join set the row's DOI, landing page,
text and date, and only when the merge reads reviewed.

Only OpenAlex's journal record of the article, with a publisher's DOI, starts
the upgrade, and only on a row OpenAlex's working paper started. A journal
record without a DOI would leave the working paper's DOI on the reviewed row,
so it leaves the row as it was. The row names the article's work in
`openAlexId`, whichever lane listed it (venue, topic, area, notable or
followed). Enrichment and its 14-day refresh read `openAlexId` first, and the
row follows the article's own listing for its title and abstract, so both
arrival orders end up with the article's title, venue, type, topic and counts,
and its abstract when OpenAlex lists one. Otherwise the working paper's
abstract fills the gap, as when both arrive the same night.

Records from every other source merge as they did before ENG-133
(`PaperBuilder.merge`): a working paper's row keeps the working paper's DOI,
its `false` and its Working paper tag when such a record arrives later. That
covers PubMed's record, Europe PMC's with or without a PubMed id, an arXiv
eprint naming its journal and the journal's DOI, and a repository's copy in
CORE or OSTI, which reads reviewed by its `published` type alone and can list
the paper's SSRN or Zenodo DOI. A row another source started is never
upgraded either: a working paper that joins an arXiv or Hugging Face eprint
without a DOI leaves that row the eprint's, unreviewed and tagged Working
paper, when the article arrives, and arXiv's next version replaces its title
and abstract. Upgrading these cases is left to ENG-145.

A row stored before ENG-133 that already merged its journal article changes
only when a lane lists that article again, and only under the rules above.
Each night the venue lane rereads the 600 newest articles of its sources
within 90 days, a topic lane rereads up to 1,000 articles back to 14 days,
and an area lane rereads only its newest 200, about the last one or two days
of most areas. A venue that publishes more than 600 articles in 90 days drops
its older ones from that listing, and a row whose article no lane lists again
stays the working paper's. No backfill is run (Pablo, 2026-10-25).

A venue lane's article reaches its leaf's readers. When its area's lane
(`openalex-areas`) listed it too, `fileAreaPapers` (`worker/leaf-filing.ts`)
takes it out of the area lane, as it does a topic lane's, and the readers of
the area's other leaves, who got it there, no longer see it. That costs most
the leaves of an area with an area lane and no topic or venue lane of their
own: q-fin.PM, q-fin.PR, q-fin.RM, q-fin.TR, q-fin.ST and q-fin.CP lose those
of the Journal of Finance, the Journal of Financial Economics, the Review of
Financial Studies and the Review of Finance (q-fin.GN) and of the q-fin.MF
journals; cs.DS, cs.GT, math.AG and math.GR lose their areas' venue journals'.

Each night a lane reads up to 3 pages of 200, newest first, and stops after a
page that is not full; its first night reads up to 5. Unlike a topic lane, it
does not stop at a page older than its last run: OpenAlex dates every Physics
of Fluids article of a month's issue, about 390, by the issue's first day and
lists a tied date oldest record first, so an article indexed late in the month
comes after the rest of its issue. A lane with under 200 articles in 90 days
asks once a night, one with under 400 twice. From the curators' 90-day counts,
the 80 lanes ask about 133 list calls a night, 240 at most, and 152 on their
first night. cs.SY and eess.SY send the same request, which the relay answers
from its store the second time. The lanes spend from the 3,000 of the
harvest's 4,000 units a day that the category lanes share with the notable
lanes: with the topic lanes (195 at most), the area lanes (9) and the
working-paper series (4), a night's category calls are at most 448, and the
notable lanes add 390 on their first night and at most 80 a night for
re-listings (a new lane whose first listing failed is listed again beside
them).

The lanes' papers also cost enrichment calls (`worker/paper-enrichment.ts`),
which spend what the lanes leave of the nightly run's 3,700 units. Every 14
days the refresh asks OpenAlex again for a stored paper's counts, 50 papers a
call: the lanes' about 275 new articles a day, kept 90 days, come to about 33
calls a night. Each enrichment of an OpenAlex record, refreshes included, asks
Crossref for its DOI's type, 20 DOIs a call: about 96 calls a night, and about
1,080 for the about 21,700 articles of the lanes' first night, which the
embedding passes also take.

## The 2026-10-23 and 2026-10-24 samples

Curators proposed the lists and took the samples with keyless OpenAlex requests:
economics and finance on 2026-10-23 between 19:15 and 19:27 UTC, physics,
mathematics, computer science with statistics and electrical engineering, and
engineering on 2026-10-24 between 02:06 and 02:54 UTC, with the window that
ended on 2026-10-23. A leaf with a curated list is sampled on that list, as
its curator recommended it before labelling; a list tried before it and
dropped decides nothing. The dropped lists of physics, engineering, economics
and finance were labelled and have their samples in `otherSamples`; those of
mathematics, computer science, statistics and electrical engineering (21
samples) were never labelled and are not recorded. cs.DS's query was derived,
not sent: from the 14 works a six-source request returned, its curator removed
the one of the older Symposium on Discrete Algorithms ID (S4306420974), a 2000
paper a repository re-dated, and the five-source query recorded returns the
other 13, since that request held every work in the window. q-fin.PM,
q-fin.PR, q-fin.RM and q-fin.TR have no curated list: their samples asked for
the candidate journals the curator weighed and did not recommend, and record
why those leaves have no lane.
Economics and finance were sampled with and without `has_abstract:true`. The
evidence of econ.EM, econ.TH, q-fin.GN and q-fin.MF is the sample asked as the
lane asks; so are the samples of q-fin.PM, q-fin.PR, q-fin.RM and q-fin.TR,
which asked the same filters without `has_abstract:true` and have no lane.
econ.GN's is the sample with `has_abstract:true`, as the other areas'
were (Pablo, 2026-10-24): asked as its lane asks, its 15 newest were 9 on
target, three doubted (two of them Journal of Political Economy articles
without an abstract), and the leaf failed; with `has_abstract:true` they were
11 on target, one doubted. The other areas' samples and econ.GN's asked
`has_abstract:true`, so their labellers saw only articles with an abstract; the
report marks those leaves `withAbstractOnly`.

One labeller per group of areas (economics and finance; physics; mathematics;
computer science, statistics and electrical engineering; engineering)
labelled every work, without the curators' readings. The economics and
physics sheets show the title, the venue, OpenAlex's primary topic and the
start of the abstract, in OpenAlex's order; the others were not kept. The
labels are blind to the curators' calls, not to the venue.

| Area | Leaves with a lane | Leaves sampled without one |
| --- | --- | --- |
| Economics and finance | econ.EM, econ.GN, econ.TH, q-fin.GN, q-fin.MF | q-fin.RM 10 of 15 from the Journal of Risk and Insurance and Insurance: Mathematics and Economics, which its curator excluded as insurance and actuarial journals, q-fin.PM 4 of 15, q-fin.PR 9 articles in 90 days, q-fin.TR 4 |
| Physics | all 24 sampled | none |
| Mathematics | 12 | math.AG 9 of 15, math.GR 7 of 15 |
| Computer science, statistics, electrical engineering | 25 | cs.DS 13 articles with an abstract in 90 days, all on target (14 in all), cs.GT 11 with an abstract, 9 on target (24 in all): their samples asked `has_abstract:true`, which their lanes would not |
| Engineering | all 14 sampled | none |

q-fin.ST, q-fin.CP and the leaves no curator sampled have no venue lane.
eess.SP passes at exactly 10 of 15 with 5 doubted: OpenAlex lists few IEEE
signal processing articles after about 2026-06, so its lane asks Signal
Processing and Digital Signal Processing alone. Nine physics leaves keep a
topic or author-count filter Pablo approved for them: hep-ph, hep-ex, nucl-ex,
cond-mat.supr-con, cond-mat.quant-gas, cond-mat.mes-hall, astro-ph.GA,
astro-ph.SR and physics.atom-ph. hep-th keeps the `authors_count:<100` its
curator chose: it leaves out the 43 results of large experimental
collaborations JHEP published in the 90 days, and its 15 newest were the same
with and without it.

The passing leaves' samples asked for 448 sources. Their lanes ask for 246;
the other 202 had no article on target among their leaf's 15 newest. 37 of
them are conferences. 32 of those had no work in the 90 days, since they
publish their proceedings once a year (AAAI, ACL, NeurIPS, CHI and SIGIR among
them); none can enter a lane before a new sample reaches its proceedings. Four
published many in the window, but none among their leaf's 15 newest, so none
of their articles was labelled: IJCAI (cs.AI, 957 articles), KDD (cs.LG,
1,216), ICIP (eess.IV, 629) and RecSys (cs.IR, 284). The Design Automation
Conference (eess.electro, 307) had one, off target. The lanes ask for three
conferences: ICPP (cs.DC), SPLASH (cs.PL) and PIMRC, eess.telecom's only
source. Three journals entered on a
sample of their own: Physics of Fluids (14 of 15), Nonlinear Dynamics (11 of
15) and the American Economic Review (11 of 15). The Journal of the Acoustical
Society of America (9 of 15) did not.
Nor did the Journal of Financial and Quantitative Analysis, absent from
q-fin.GN's 15 newest: it published 8 articles in the 90 days, too few for a
sample of its own, and the one its curator took (6 of 8 on target) asked
`has_abstract:true` where q-fin.GN's sample did not, so it is in
`otherSamples`, not in `leaves`.

econ.GN's lane asks for four of its curator's 15 journals: the Review of
Economics and Statistics, The Quarterly Journal of Economics and The Economic
Journal, each with an article on target among its 15 newest, and the American
Economic Review. The Journal of the European Economic Association and The
Review of Economic Studies were among the 15 newest with none on target. The
other nine were not reached. Six of them had a sample of their own, none a full
page: the four American Economic Journals, American Economic Review: Insights
and the Journal of Monetary Economics held 4 to 14 articles with an abstract in
the 90 days, and those samples are in `otherSamples`. The Journal of Political
Economy and the Journal of International Economics, whose articles mostly have
no abstract in OpenAlex, had none, and OpenAlex has no Econometrica work since
March.

Without `has_abstract:true`, a lane also brings the articles its labeller
could not see. From the curators' counts, more than half of the 90-day
articles of 19 such lanes have no abstract in OpenAlex, among them eess.electro
(94 %), eess.SP (91 %), eess.telecom (81 %), mech.solid (77 %) and nucl-th
(58 %, most of them closed Physical Review C articles). A sample asked
as these lanes ask would measure them; the sample in the evidence does not.
