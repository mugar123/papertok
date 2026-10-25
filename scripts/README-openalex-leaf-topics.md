# OpenAlex feed topics

`src/utils/area-accent.ts` owns the feed's topic lookup and imports
`src/data/open-alex-leaf-topics.generated.ts`. Generate that file with:

```bash
npm run generate:openalex-topics
npm run generate:openalex-topics -- --check
```

The same command writes the per-leaf coverage report,
`scripts/data/openalex-leaf-topics-coverage.json`, and, for the leaves without
a topic lane, the notable map `src/data/open-alex-notable-leaf-topics.generated.ts`
and its candidates file `scripts/data/openalex-notable-candidates.json` (see
[Notable sample](#notable-sample)); `--check` fails when any of the four
differs from what the inputs produce.

The baseline input preserves the 14 topic lists accepted in
[PR #236](https://github.com/mugar123/papertok/pull/236), including their order
within each leaf. It is inherited evidence, not a new measurement. The catalogue
input is the pinned official topic catalogue described below. The reviews input
holds the 2026-10-23 sample and labels of all 107 proposals (see the last
section). The generator does not call OpenAlex or the production relay.

The Worker's nightly harvest gives every leaf in the generated map its own
`openalex-topics` lane (`categoryLaneJobs()` in `worker/paper-sources.ts`),
which asks for the leaf's admitted topic IDs, sorted as in its sample. Each
lane reads up to 5 pages of 200 a night from the harvest's share of 4,000
OpenAlex units a day (`OPENALEX_HARVEST_DAILY_UNITS` in
`worker/provider-runtime.ts`; a page is one list call, one unit), so every
admitted leaf adds up to 5 units a night. The 39 leaves in the map take at
most 195.

## Propose candidates

`scripts/data/openalex-topic-catalogue.json` is a copy of the 4,516 topics in
OpenAlex's own classifier repository at a pinned commit:

<https://github.com/ourresearch/openalex-topic-classification/blob/98df3b96c36128819075dd86949c9f18411fab40/v2/data/topics/topics.json>

To try another catalogue, supply an OpenAlex topic array, or a `/topics`
response with a `results` array collected by `subfield.id` with `mailto`,
following pagination, and write all four outputs elsewhere, or the run
replaces the checked-in notable candidates too:

```bash
node scripts/generate-openalex-leaf-topics.ts \
  --catalogue /path/topics.json \
  --out /path/proposed-map.ts \
  --report /path/coverage.json \
  --notable-out /path/proposed-notable-map.ts \
  --candidates /path/notable-candidates.json
```

The report includes every leaf in `category-taxonomy.ts`. For each leaf with
neither an inherited list nor a review, the generator restricts candidates to
the existing area's OpenAlex ancestors, then ranks topic names and keywords
against the leaf label. At least 60% of the label's significant words must
match; at most ten topic IDs are proposed. This is candidate selection, not
relevance evidence. Generic labels, synonyms and areas that cross the two
taxonomies can require further selector work.

No candidate enters the runtime map without a complete review. Once a leaf has
a review, its topics are the `primary_topic.id` values its sample query named,
and the generator no longer derives them from the leaf's label or the
catalogue. Renaming the leaf or changing the catalogue therefore keeps the
review. To review a different topic list for the leaf, replace its review with
a new sample.

## Review a recent sample

Ask `https://api.openalex.org/works` directly and anonymously.
Do not use `api.papertok.app` or its key. Send one request per leaf, one at a
time, stop on a quota rejection, and do not retry. On 2026-10-23 an anonymous
list request cost 1 of the IP's 1,000 daily credits (`x-ratelimit-*` headers).

Use the Worker lane's filters: sorted `primary_topic.id` values joined by `|`,
`type:article`, the last 90 UTC days through the capture day,
`is_retracted:false`, and `primary_location.source.is_core:true`, and add
`has_abstract:true`, since the labellers read each article's abstract. The
lane itself takes articles without an abstract too (ENG-129), so the gate's
evidence covers only articles with one: every review's query asks
`has_abstract:true`. How well the articles without one fit their leaf is not
measured yet; measuring it is part of the check after the lanes deploy. Set
`sort=publication_date:desc`, `page=1`, `per-page=15`: the sample is the 15
newest articles. The gate rejects text, field and subfield works queries. The
catalogue may use subfield queries; the feed and its samples may not.

Keep the entire returned page while labelling. Prepare a separate, shuffled
review sheet with only the target leaf, opaque row IDs, titles and decoded
abstracts. Hide topic IDs, query, venue, access and the proposed mapping while
labelling. Record `on-target` or `off-target` for every row, and add
`"uncertain": true` to any call you doubt: the gate counts it as a miss
whatever its label. A doubted call that leans neither way has no label.
Join the labels back to work IDs only after finishing the
blind labels. Blindness is a review procedure: the generator cannot prove that
an annotator did not inspect the hidden data.

The reviews JSON is keyed by leaf ID. Each value contains:

| Key | Contents |
| --- | --- |
| `capturedAt` | UTC capture timestamp |
| `query` | The works URL as sent; a `mailto` may be left out, as it does not change the results. Its sorted `primary_topic.id` values are the reviewed topics |
| `works` | Every returned work, newest first, with only `id`, `type`, `title`, `publication_date` and `primary_topic.id` |
| `labels` | One `{ "workId": "https://openalex.org/W…", "label": "on-target" }` or `off-target` per work, with `"uncertain": true` on a doubted call, which has no `label` when it leans neither way |

The abstracts stay out of the repository: the query's `has_abstract:true`, which
the gate requires, shows that every work had one, and the work IDs lead back to
the full records.

Admission requires a full page of 15 unique recent articles, complete labels,
and at least two thirds (10 of 15) on target without doubt. PR #236 reports
74.1% overall and a lowest accepted profile of 66.0%, but does not state a
formal per-leaf threshold. Two thirds is a conservative rounding of that
observed floor; PAP-99 adopted it as the rule. The original 14 lists retain
their existing acceptance.

A passing leaf's lane asks only for the sampled topics with at least one
article on target without doubt. The leaf's precision says nothing about a
topic the sample never returned, such as a generic catch-all, or returned only
off target. The report's `byTopic` gives each topic's articles on target
without doubt over the articles the sample returned on it, such as `9/12`.
Leaving topics out only removes articles from the sample: at capture time, the
lane's newest articles were the sample's articles on its topics, at the same or
a higher share on target. A topic too rare to appear among the 15 newest
articles cannot enter a lane this way.

Low precision and short samples leave a leaf disabled and are reported as
`rejected` or `insufficient-sample`. Invalid or incomplete evidence aborts
generation before the previous map is overwritten. `not-reviewed`,
`no-candidates` and `no-catalogue` are not failed precision tests.

After review, retain the evidence in `scripts/data/openalex-topic-reviews.json`,
regenerate with the default command and verify `--check`.
Do not hand-edit the generated file or replace unknown access, citation counts
or review status while labelling. A source's explicit
`open_access.is_oa: false` is evidence of subscription access; missing access
is unknown.

The generator tests use synthetic data and run in `npm test`. They verify the
admission mechanics; they do not establish live precision or feed composition.

## Notable sample

Every leaf with a topic lane also has a notable lane (`openalex-notable` in
`worker/paper-sources.ts`): the 100 most-cited core journal articles of each of
the ten completed years before the current one, on the topic lane's topics. The
other leaves, 110 of 149 on 2026-10-25, get a notable lane through a second
gate, with the lane's own population and its own candidates
(`openAlexNotableFilterForLeaf` in `src/utils/area-accent.ts`: the topic lane's
filter when the leaf has one, else the notable map's, else none). A leaf the
notable sample admits gets a notable lane and no topic lane; once a later topic
sample admits it, its notable lane lists the topic lane's topics and the
generator asks for its notable entries to be removed.

**Candidates.** `scripts/data/openalex-notable-subfields.json` names, for each
leaf without a topic lane, the OpenAlex subfield IDs whose catalogue topics
stand for it, and, where OpenAlex files a fitting topic under another subfield
(quantum information under Artificial Intelligence), that topic's ID. It is
hand-written from the catalogue's subfield list; `[]` records that nothing
fits. The candidates are the catalogue topics of those subfields and IDs, not
label matches: on 2026-10-23 the label selector proposed `T14414` for `cs.AI`,
which returned 8 of its 15 articles, none on target. The map must name only
leaves without a topic lane; a leaf it leaves out is reported `not-mapped`.
OpenAlex ORs at most 100 values in one filter, so a proposal of more topics is
reported `too-many-candidates` and must name fewer subfields. The candidates
file records each leaf's status, its proposed topics and, for a proposal, the
sample query to send:

| Parameter | Value |
| --- | --- |
| `filter` | the proposed `primary_topic.id` values sorted and joined by `\|`, `type:article`, `from_publication_date:<year−10>-01-01`, `to_publication_date:<year−1>-12-31`, `has_abstract:true`, `is_retracted:false`, `primary_location.source.is_core:true` |
| `sort` | `cited_by_count:desc` |
| `page`, `per-page` | `1`, `15` |
| `select` | the gate's fields and `cited_by_count` |

The window is the lane's: the ten completed years before the year the file
records (`year`), which generation sets to the current UTC year and `--check`
keeps. Regenerate after 1 January to move the proposals on; a review's own
window comes from its capture date. The sample asks `has_abstract:true`, which
the lane does not, because the labellers read the abstracts; the lane also
lists articles without one.

**Procedure.** As for a recent sample: one anonymous request per leaf, one at a
time, stopping on a quota rejection; a shuffled sheet with opaque row IDs,
titles and decoded abstracts, and nothing else; `on-target`, `off-target` or
`uncertain` for every row, joined back to work IDs afterwards. The label is
`on-target` when a researcher who chose the leaf would recognise the article as
a notable work of their field. Two leaves with the same proposal (`math-ph` and
`math.MP`, `math.ST` and `stat.TH`, `cs.SY` and `eess.SY`) share one request
and one labelled page, recorded under each.

**Evidence and decision.** `scripts/data/openalex-notable-reviews.json` has the
shape of the recent reviews, keyed by leaf, and each work also keeps
`cited_by_count`; the generator checks the query is the most-cited notable
query above for the capture's years, the works are in non-increasing citation
order and dated within the window, and every work is labelled. The rule is the
gate's: a full page of 15, at least 10 on target without doubt. A passing
leaf's lane asks only for the sampled topics with an article on target. The
sample is the 15 most cited of ten years over the proposed topics, so it is
evidence about the head of the lane's population, not about the 100th article
of a year; the check after the lanes deploy covers the rest. The candidates
file reports `passed`, `rejected` or `insufficient-sample` with the sample's
`onTarget` and `byTopic`.

Each batch of admitted leaves changes what every reader of those leaves is
shown and adds ten OpenAlex list calls a week per leaf, inside the category
lanes' 3,000 nightly units; it is authorized under AGENTS.md before it is
committed. A night re-lists at most eight due lanes, or a seventh of all the
notable lanes once there are more than 56, so a batch keeps every lane weekly
and raises the nightly re-listing units and CPU in step (`notableLanesPerNight`
in `worker/paper-sources.ts`; 149 lanes would be 22 a night, 220 units). After a
large batch every lane falls due on the same night and the last of them is
re-listed 13 days after its first listing, one night before its papers would
leave the lane; a failed night at that tail lapses the listing until the next
successful one. A batch's first night also lists and embeds every new lane at
once: about 1,000 papers a lane against the embedding ceiling of the night
(`EMBEDDING_DAILY_TOKEN_LIMIT`, `wrangler.toml`), so size the batch against it.
Leaves are sampled by area, the areas with no notable lane at all first.

### The 2026-10-25 notable sample, batch 1

107 anonymous requests between 16:51 and 16:55 UTC, one per distinct proposal
of the 110 leaves, all answered 200 with 15 articles. Batch 1 is the 38 leaves
of physics (its 24 without a lane), statistics (5), economics (3) and
chemistry (6), the last three the areas with no notable lane at all, and
`math.ST`, whose proposal is `stat.TH`'s. **An agent (Claude Fable 5.1)
labelled this batch, not a person**, following the blind procedure above at
Nicolás's request not to wait for his own labels: the sheets held titles and
decoded abstracts in shuffled rows with opaque ids; doubt was recorded as
`uncertain`; the labels were joined to work ids after each sheet. The agent
reports reading the sheet files only; as the procedure says, that cannot be
proved from the files. Read the evidence as an agent's reading of 15 abstracts
a leaf. New labels for the same sample replace these.

| Decision | Leaves |
| --- | --- |
| `passed` | 17: `cond-mat.supr-con`, `cond-mat.str-el`, `cond-mat.mes-hall`, `cond-mat.soft`, `hep-th`, `hep-ph`, `hep-ex`, `astro-ph.CO`, `astro-ph.GA`, `astro-ph.SR`, `physics.optics`, `physics.atom-ph`, `physics.flu-dyn`, `stat.CO`, `chem.electro`, `chem.inorg`, `chem.phys` |
| `rejected` | 22, among them `physics.plasm-ph`, `chem.anal` and `chem.org` at 9 of 15 and `gr-qc` and `econ.GN` at 8 |

Five pass at exactly 10 of 15 (`cond-mat.str-el`, `hep-th`, `hep-ph`, `hep-ex`,
`chem.inorg`). The 17 lanes ask for 48 topic entries (45 distinct topics;
`T10037`, `T10048` and `T11090` serve two lanes each) and spend 170 units a
week; with 56 notable lanes the nightly share stays at eight. Their first
night lists and embeds about 17,000 papers against the 7.5M-token embedding
ceiling (about 5,000 papers a day), so the first embedding spreads over about
three nights behind the day's new papers. The most-cited articles of a
subfield are often its tools and reference works: `quant-ph` returned
quantum-chemistry codes and `physics.comp-ph` scientific-software papers
(SciPy, NumPy, Astropy beside those codes), the statistics leaves
systematic-review guidelines and R packages, `math-ph` deep-learning inverse
problems, `chem.spectro` proteomics repositories, `astro-ph.EP` Gaia and MESA
papers. Authorized by Nicolás on 2026-10-25 (ENG-138, where the per-leaf
table is).

### Batch 2: computer science and artificial intelligence

The 17 leaves of the two areas without a topic lane (`cs.SY` shares its page
with `eess.SY`), labelled by the same agent under the same procedure. Five
pass: `cs.LG` and `cs.CL` at 14 of 15, `cs.SI` and `cs.NE` at 13, `cs.DS` at
10. Twelve are rejected: `cs.DC` and `cs.HC` at 8, `cs.RO`, `cs.GT` and
`cs.AI` at 7, the rest lower. The five lanes ask for 21 topic entries (20
distinct) and spend 50 units a week; with 61 notable lanes the nightly share
becomes nine (90 units). Again the head of a subfield's citations is often its
tools and surveys rather than its research: `cs.AI`'s proposal (the whole
Artificial Intelligence subfield, 77 topics) returned SciPy, NumPy, seaborn,
Astropy, QuPath and two quantum-computing papers beside its surveys; `cs.CR`
returned federated-learning and blockchain surveys; `cs.IR` returned
language-model papers; `cs.SY` returned machine fault diagnosis. Authorized by
Nicolás on 2026-10-25 (ENG-138).

### Batch 3: mathematics

The 14 leaves of mathematics without a topic lane (`math.MP` shares its page
with `math-ph`, `math.ST` with `stat.TH`), labelled by the same agent under
the same procedure. None passes: `math.NA` at 9 of 15, `math.OC` at 7,
`math.AP` at 6, the rest at 5 or fewer; nothing is admitted, so no reader
sees a change and no authorization applies. The head of each subfield's
citations was mostly other things: optimal-transport papers for `math.DG`,
Bayesian software (Stan, PyMC, dynesty) for `math.PR`, fixed-point theorems
in generalized metric spaces for `math.FA`, two-dimensional QFT symmetry
papers for `math.AG` and `math.GR`, program-verification papers for
`math.LO`, numerical fractional calculus and time-frequency transforms for
`math.CA`.

### Batch 4: medicine

The 11 medicine leaves without a topic lane, labelled by the same agent under
the same procedure. Five pass: `med.endo` at 14 of 15, `med.infect` at 13,
`med.gen` and `med.cardio` at 12, `med.radio` at 11. Six are rejected:
`med.immuno` at 9 (basic-immunology reviews doubted), `med.peds` at 7
(maternal and perinatal epidemiology), `med.tox` at 6 (air-pollution
epidemiology), `med.pharma` at 4 (pain and obesity epidemiology, genome-mining
software), `med.path` and `med.surg` at 2 (multiple-sclerosis neurology;
lipid and coronary guidelines filed under Surgery). The five lanes ask for 22
topics and spend 50 units a week; with 66 notable lanes the nightly share is
ten (100 units). `med.infect`'s page is the COVID-19 literature of 2020 and
`med.gen`'s is nephrology and hepatology; `med.cardio` and `med.endo` are
guidelines and outcome trials. Authorized by Nicolás on 2026-10-25 (ENG-138).

### Batch 5: quantitative finance

The seven finance leaves without a topic lane, labelled by the same agent
under the same procedure. None passes: `q-fin.PM` at 8 of 15, the rest at 6
or fewer, with 4 to 8 doubted calls each; nothing is admitted. The Finance
subfield's most-cited articles of the decade are connectedness and spillover
econometrics, COVID-19 and cryptocurrency market studies and news-based
uncertainty indices, which appear on five to seven of the seven pages; the
leaves' own matter (option pricing, portfolio theory, microstructure) is a
minority on each.

### Batch 6: mechanical, electrical and chemical engineering

The 16 leaves of the three areas without a topic lane (`eess.SY` shares its
page with `cs.SY`), labelled by the same agent under the same procedure.
Nine pass: `mech.solid`, `eess.IV` and `eess.telecom` at 15 of 15,
`chemeng.energy` at 14, `mech.dyn` at 12, `eess.electro`, `chemeng.metal` and
`chemeng.nano` at 11, `mech.thermo` at 10. Seven are rejected: `eess.SP` at
8 (medical-image denoising doubted between signal and image processing),
`chemeng.sep` at 7 (MOF chemistry beside the separations), `mech.acoustics`
and `chemeng.bio` at 6 (cavity magnomechanics and quantum optics; drug
delivery beside wearables and biochar), `mech.auto` at 3 (battery science
and additive manufacturing), `eess.SY` at 2 and `mech.cad` at 0 (neural
rendering and point-cloud learning). The nine lanes ask for 39 topics and
spend 90 units a week; with 75 notable lanes the nightly share is eleven
(110 units). Authorized by Nicolás on 2026-10-25 (ENG-138).

## The 2026-10-23 sample (PAP-99)

107 anonymous requests, one per proposed leaf, between 08:04 and 08:05 UTC, all
answered 200 at 1 credit each. The coverage report records each leaf's
`sampleSize`, `onTarget`, `byTopic` and decision:

| Decision | Leaves |
| --- | --- |
| `passed` (10 or more of 15 on target and not marked uncertain) | 25 |
| `rejected` | 79 |
| `insufficient-sample` | 3: `math.OC` (0 articles), `med.endo` (12), `chemeng.metal` (13) |
| `no-candidates` | 22 |
| `inherited` | 14 |

The six Chemistry leaves (ENG-114) were added after this sample, so the
report has 149 rows: `chem.electro` has no candidates and the other five are
`not-reviewed`.

The 25 passing samples asked for 117 topics. Their lanes ask for the 60 with
an article on target and not marked uncertain. Of the 57 left out, the samples
never returned 47 and returned 10 only off target or marked uncertain. Later
on 2026-10-23, 32 more anonymous requests grouped by `primary_topic.id` the
query of each sample that passed before the relabel described below. For the
25 that pass now, those windows held 19,683 articles; the topics left out held
3,488, 1,476 on the 10 and 2,012 on the 47.

Three labellers each labelled a third of the leaves. The label is `on-target`
when a researcher who chose the leaf would recognise the article as work in
their field. The sheets departed from the procedure above. They kept
OpenAlex's newest-first order and its work IDs rather than shuffled, opaque
rows. Each row showed the venue, the year and OpenAlex's access flag beside the
title and the first 300 characters of the abstract. The labellers report
judging from the title, the abstract and the venue. Topic IDs, the query and
the proposed mapping were hidden.

The labelling instructions asked for a verdict and a short reason per article,
not for doubt. The first labeller added a list of borderline calls anyway,
defined as calls a second labeller could reasonably flip: 122 of their 525.
The reviews record them as `uncertain`. Eight leaves passed only on such calls
and are rejected: `cond-mat.quant-gas`, `physics.optics`, `physics.plasm-ph`,
`math.ST`, `eess.SP`, `civil.trans`, `med.pharma` and `med.surg`.

The second and third labellers had no way to record doubt: whether they
doubted any call is unknown, not zero. Ten of their leaves passed at 10 or 11
of 15, where one or two doubted calls would reject them: `astro-ph.SR`,
`cs.LG`, `cs.SY`, `math.GT`, `q-fin.GN`, `eess.SY`, `eess.power`, `civil.mat`,
`chemeng.process` and `med.tox`. A fourth labeller relabelled those ten on the
same sheets and reports not opening the earlier labels, the reviews or the
coverage report. They called each article on target, off target or uncertain,
where uncertain means a researcher in the leaf could reasonably disagree.
Their labels replace the earlier ones for those ten leaves. An uncertain call
leans neither way, so the reviews record it as doubt without a label. Three
leaves still pass, at 10 of 15 and with the same topics: `q-fin.GN`,
`eess.power` and `chemeng.process`. Seven are rejected: `cs.LG` (3 of 15),
`civil.mat` and `med.tox` (7), `astro-ph.SR`, `math.GT` and `eess.SY` (8) and
`cs.SY` (9).

Each leaf has one labeller. Of the 25 passing leaves, the first labeller's
seven are `astro-ph.HE`, `cs.NI`, `math.CO`, `math.RA`, `mech.mfg`, `bio.bot`
and `bio.marine`, and the fourth labeller's are the three above. The other 15
come from the second and third labellers, so whether they hold a doubted call
is unknown. They have 12 to 15 of 15 on target: three doubted calls would
reject `cs.SD` (12 of 15) and four or more any other. Their lanes hold 40 of
the 60 topics, and one doubted call would remove any of the 11 with a single
article on target.

The first labeller's `math.CO` and `mech.mfg` passed at exactly 10 of 15, as
did the fourth labeller's three. A labeller working blind, as the procedure
above describes, could record doubt on the 15 leaves, confirm the five at 10
of 15 and re-examine the eight rejected for the first labeller's doubts. New
labels for the same sample replace the leaf's labels; a new sample replaces
its whole entry.
