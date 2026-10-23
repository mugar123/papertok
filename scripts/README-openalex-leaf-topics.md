# OpenAlex feed topics

`src/utils/areaAccent.ts` owns the feed's topic lookup and imports
`src/data/openAlexLeafTopics.generated.ts`. Generate that file with:

```bash
npm run generate:openalex-topics
npm run generate:openalex-topics -- --check
```

The same command writes the per-leaf coverage report,
`scripts/data/openalex-leaf-topics-coverage.json`; `--check` fails when either
file differs from what the inputs produce.

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
OpenAlex list calls (`HARVEST_OPENALEX_DAILY_CALLS`), so every admitted leaf
adds up to 5 calls a night. The 39 leaves in the map take at most 195.

## Propose candidates

`scripts/data/openalex-topic-catalogue.json` is a copy of the 4,516 topics in
OpenAlex's own classifier repository at a pinned commit:

<https://github.com/ourresearch/openalex-topic-classification/blob/98df3b96c36128819075dd86949c9f18411fab40/v2/data/topics/topics.json>

To try another catalogue, supply an OpenAlex topic array, or a `/topics`
response with a `results` array collected by `subfield.id` with `mailto`,
following pagination, and write the outputs elsewhere:

```bash
node scripts/generate-openalex-leaf-topics.ts \
  --catalogue /path/topics.json \
  --out /path/proposed-map.ts \
  --report /path/coverage.json
```

The report includes every leaf in `categoryTaxonomy.ts`. For each leaf with
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

Use exactly the Worker lane's filters: sorted `primary_topic.id` values joined
by `|`, `type:article`, the last 90 UTC days through the capture day,
`has_abstract:true`, `is_retracted:false`, and
`primary_location.source.is_core:true`. Set `sort=publication_date:desc`,
`page=1`, `per-page=15`: the sample is the 15 newest articles. The gate rejects
text, field and subfield works queries. The catalogue may use subfield queries;
the feed and its samples may not.

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
