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
| `sources` | Each source ID the samples asked for, with the `name`, `publisher` and `type` (`journal`, `conference`) its curator verified with `/sources/<id>`. Nine computer science sources the curator dropped after sampling (eight with no work since 2024, one re-dated repository copy) have no record; a source without one cannot enter a lane. |
| `leaves` | Per taxonomy leaf: `sample`, the leaf's labelled sample, and optionally `sourceSamples`, samples of one of its sources each |

A sample holds `capturedAt`, the `query` as sent without the sampler's
address, every returned work (`id`, `type`, `title`, `publication_date`,
`source`, and `primary_topic` when the query filtered on topics) and one label
per work: `on-target`, `off-target`, or `uncertain: true` without a label for a
call the labeller doubted, which counts as a miss.

## The gate

A sample is page 1 of 15, newest first, of one OR filter over the leaf's
sources, with `type:article` (`article|conference-paper` where proceedings
count), the 90 days through its capture day (or the day before, for a sample
taken after midnight UTC), `is_retracted:false`, optionally
`has_abstract:true`, and optionally one topic filter and one author-count
filter. Nothing else is accepted.

A leaf passes with a full page of 15 and at least 10 on target without doubt,
the topic lanes' rule (`README-openalex-leaf-topics.md`). Its lane then asks
for the sources with at least one article on target without doubt, or whose
own sample, asked with the leaf's filters, is at least two thirds on target.
The leaf's precision says nothing about a source its 15 newest did not reach,
so such a source stays out, as a topic does in a topic lane. Every source a
lane asks for must be one the review rule calls reviewed
(`openAlexPeerReviewed`): a listed working-paper series cannot enter.

The lane asks with the sample's type and topic or author filter, the live
window and `is_retracted:false`. It does not ask `has_abstract:true`
(Pablo, 2026-10-23: it drops most closed Elsevier, Springer and University of
Chicago Press articles), so a card without an abstract says "No abstract
available". It does not ask `primary_location.source.is_core:true`: the
sources are named, and OpenAlex marks none of the conference sources, nor npj
Soft Matter, as core.

The nightly run harvests the venue lanes before the working-paper series, so
a journal article and its working paper listed the same night merge into the
journal's reviewed row (#198, PAP-85). A working paper stored on an earlier
night keeps its own row, Working paper tag included, when its journal article
arrives and merges into it (`PaperBuilder.merge`).

Each night a lane reads up to 3 pages of 200 and stops after a page that is
not full, or whose newest article is older than the 14 days before its last
run; its first night reads up to 5. A lane with under 200 articles in 90 days
asks once a night. From the
curators' 90-day counts, the 80 lanes ask about 122 list calls a night, 240 at
most, and 152 on their first night, of the 3,000 the category lanes may spend
of the harvest's 4,000 units a day. cs.SY and eess.SY send the same request,
which the relay answers from its store the second time.

## The 2026-10-23 and 2026-10-24 samples

Curators proposed the lists and took the samples with keyless OpenAlex requests:
economics and finance on 2026-10-23 between 19:15 and 19:27 UTC, physics,
mathematics, computer science with statistics and electrical engineering, and
engineering on 2026-10-24 between 02:06 and 02:54 UTC, with the window that
ended on 2026-10-23. Each leaf's sample is the list its curator recommended
before labelling; a list tried before it and dropped is not recorded here.
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
| Economics and finance | econ.EM, econ.TH, q-fin.GN, q-fin.MF, q-fin.RM | econ.GN 9 of 15 (11 of 15 with `has_abstract:true`; two articles without an abstract were doubted), q-fin.PM 4 of 15, q-fin.PR 9 articles in 90 days, q-fin.TR 4 |
| Physics | all 24 sampled | none |
| Mathematics | 12 | math.AG 9 of 15, math.GR 7 of 15 |
| Computer science, statistics, electrical engineering | 25 | cs.DS 13 articles (all on target), cs.GT 11 |
| Engineering | all 14 sampled | none |

q-fin.ST, q-fin.CP and the leaves no curator sampled have no venue lane.
eess.SP passes at exactly 10 of 15 with 5 doubted: OpenAlex lists few IEEE
signal processing articles after about 2026-06, so its lane asks Signal
Processing and Digital Signal Processing alone. Nine physics leaves keep a
topic or author-count filter Pablo approved for them: hep-ph, hep-ex, nucl-ex,
cond-mat.supr-con, cond-mat.quant-gas, cond-mat.mes-hall, astro-ph.GA,
astro-ph.SR and physics.atom-ph. hep-th's sample, the same 15 with and without
`authors_count:<100`, is recorded without it.

The passing leaves' samples asked for 435 sources. Their lanes ask for 245;
the other 190 had no article on target among their leaf's 15 newest, 37 of
them conferences whose proceedings carry one date a year (AAAI, IJCAI, ACL,
NeurIPS, CHI, SIGIR among them). The journals of three source samples entered
on their own: Physics of Fluids (14 of 15), Nonlinear Dynamics (11 of 15) and
the Journal of Financial and Quantitative Analysis (6 of 8). The Journal of the
Acoustical Society of America (9 of 15) did not.

Without `has_abstract:true`, a lane also brings the articles its labeller
could not see. From the curators' counts, more than half of the 90-day
articles of 19 such lanes have no abstract in OpenAlex, among them eess.electro
(94 %), eess.SP (91 %), eess.telecom (81 %), mech.solid (77 %) and nucl-th
(58 %, mostly Physical Review C's closed experimental papers). A sample asked
as these lanes ask would measure them; the sample in the evidence does not.
