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

`openalex-venue-reviews.json` has two keys:

| Key | Contents |
| --- | --- |
| `sources` | Each source ID the samples asked for, with the `name`, `publisher` and `type` (`journal`, `conference`) its curator verified with `/sources/<id>`, and `leaves`, the leaves its curator filed it under: the curated lists, kept here only. A source filed under none was sampled but left off the lists: the excluded insurance, derivatives and market microstructure journals of q-fin.RM, q-fin.PR and q-fin.TR, and the optional Journal of Portfolio Management and Financial Analysts Journal of q-fin.PM. Nine computer science sources the curator dropped after sampling (eight with no work since 2024, one re-dated repository copy) have no record; a source without one cannot enter a lane. |
| `leaves` | Per taxonomy leaf: `sample`, the leaf's labelled sample, and optionally `sourceSamples`, samples of one of its sources each |

A sample holds `capturedAt`, the `query` as sent without the sampler's
address (cs.DS's was derived, below), every returned work (`id`, `type`, `title`, `publication_date`,
`source`, and `primary_topic` when the query filtered on topics) and one label
per work: `on-target`, `off-target`, or `uncertain: true` without a label for a
call the labeller doubted, which counts as a miss.

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
journal's reviewed row (#198, PAP-85). A working paper stored on an earlier
night keeps its own row when its journal article arrives and merges into it
(`PaperBuilder.merge`): the row keeps the working paper's DOI, its unreviewed
answer and its Working paper tag, and is filed under the venue leaf too.
Working papers usually appear first, so when both fall within the 90 days this
is the more likely order, and the journal row stays reviewed only when both
are listed the same night.

A venue lane's article reaches its leaf's readers. When its area's lane
(`openalex-areas`) listed it too, `fileAreaPapers` (`worker/leaf-filing.ts`)
takes it out of the area lane, as it does a topic lane's, and the readers of
the area's other leaves, who got it there, no longer see it. That costs most
the leaves of an area with an area lane and no topic or venue lane of their
own: econ.GN loses the econ.EM and econ.TH journals' articles; q-fin.PM,
q-fin.PR, q-fin.RM, q-fin.TR, q-fin.ST and q-fin.CP lose those of the Journal
of Finance, the Journal of Financial Economics, the Review of Financial
Studies and the Review of Finance (q-fin.GN) and of the q-fin.MF journals;
cs.DS, cs.GT, math.AG and math.GR lose their areas' venue journals'.

Each night a lane reads up to 3 pages of 200, newest first, and stops after a
page that is not full; its first night reads up to 5. Unlike a topic lane, it
does not stop at a page older than its last run: OpenAlex dates every Physics
of Fluids article of a month's issue, about 390, by the issue's first day and
lists a tied date oldest record first, so an article indexed late in the month
comes after the rest of its issue. A lane with under 200 articles in 90 days
asks once a night, one with under 400 twice. From the curators' 90-day counts,
the 79 lanes ask about 132 list calls a night, 237 at most, and 151 on their
first night. They spend from the 3,000 of the harvest's 4,000 units a day that
the category lanes share with the weekly notable lanes: with the topic lanes
(195 at most), the area lanes (9) and the working-paper series (4), a night's
category calls are at most 445, and the notable lanes add 39 one night a week.
cs.SY and eess.SY send the same request, which the relay answers from its
store the second time.

## The 2026-10-23 and 2026-10-24 samples

Curators proposed the lists and took the samples with keyless OpenAlex requests:
economics and finance on 2026-10-23 between 19:15 and 19:27 UTC, physics,
mathematics, computer science with statistics and electrical engineering, and
engineering on 2026-10-24 between 02:06 and 02:54 UTC, with the window that
ended on 2026-10-23. A leaf with a curated list is sampled on that list, as
its curator recommended it before labelling; a list tried before it and
dropped is not recorded here. cs.DS's query was derived, not sent: from the 14
works a six-source request returned, its curator removed the one of the older
Symposium on Discrete Algorithms ID (S4306420974), a 2000 paper a repository
re-dated, and the five-source query recorded returns the other 13, since that
request held every work in the window. q-fin.PM, q-fin.PR, q-fin.RM and q-fin.TR have no
curated list: their samples asked for the candidate journals the curator
weighed and did not recommend, and record why those leaves have no lane.
Economics and finance were sampled with and without `has_abstract:true`; their
evidence is the sample asked as the lane asks. Every other sample asked
`has_abstract:true`, so its labeller saw only articles with an abstract; the
report marks those leaves `withAbstractOnly`.

One labeller per group of areas (economics and finance; physics; mathematics;
computer science, statistics and electrical engineering; engineering)
labelled every work, without the curators' readings. The economics and
physics sheets show the title, the venue, OpenAlex's primary topic and the
start of the abstract, in OpenAlex's order; the others were not kept. The
labels are blind to the curators' calls, not to the venue.

| Area | Leaves with a lane | Leaves sampled without one |
| --- | --- | --- |
| Economics and finance | econ.EM, econ.TH, q-fin.GN, q-fin.MF | econ.GN 9 of 15 (11 of 15 with `has_abstract:true`; two articles without an abstract were doubted), q-fin.RM 10 of 15 from the Journal of Risk and Insurance and Insurance: Mathematics and Economics, which its curator excluded as insurance and actuarial journals, q-fin.PM 4 of 15, q-fin.PR 9 articles in 90 days, q-fin.TR 4 |
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

The passing leaves' samples asked for 433 sources. Their lanes ask for 242;
the other 191 had no article on target among their leaf's 15 newest. 37 of
them are conferences. 32 of those had no work in the 90 days, since they
publish their proceedings once a year (AAAI, ACL, NeurIPS, CHI and SIGIR among
them); none can enter a lane before a new sample reaches its proceedings. Four
published many in the window, but none among their leaf's 15 newest, so none
of their articles was labelled: IJCAI (cs.AI, 957 articles), KDD (cs.LG,
1,216), ICIP (eess.IV, 629) and RecSys (cs.IR, 284). The Design Automation
Conference (eess.electro, 307) had one, off target. The lanes ask for three
conferences: ICPP (cs.DC), SPLASH (cs.PL) and PIMRC, eess.telecom's only
source. Two journals entered on a
sample of their own: Physics of Fluids (14 of 15) and Nonlinear Dynamics (11
of 15). The Journal of the Acoustical Society of America (9 of 15) did not.
Nor did the Journal of Financial and Quantitative Analysis, absent from
q-fin.GN's 15 newest: it published 8 articles in the 90 days, too few for a
sample of its own, and the one its curator took (6 of 8 on target) asked
`has_abstract:true` where q-fin.GN's sample did not, so it is not recorded.

Without `has_abstract:true`, a lane also brings the articles its labeller
could not see. From the curators' counts, more than half of the 90-day
articles of 19 such lanes have no abstract in OpenAlex, among them eess.electro
(94 %), eess.SP (91 %), eess.telecom (81 %), mech.solid (77 %) and nucl-th
(58 %, most of them closed Physical Review C articles). A sample asked
as these lanes ask would measure them; the sample in the evidence does not.
