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
which asks for the leaf's topic IDs in sorted order, as the sample did. Each
lane reads up to 5 pages of 200 a night from the harvest's share of 4,000
OpenAlex list calls (`HARVEST_OPENALEX_DAILY_CALLS`), so every admitted leaf adds
up to 5 calls a night. The 54 leaves in the map take at most 270.

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

The report includes every leaf in `categoryTaxonomy.ts`. For each new leaf,
the generator restricts candidates to the existing area's OpenAlex ancestors,
then ranks topic names and keywords against the leaf label. At least 60% of the
label's significant words must match; at most ten topic IDs are proposed. This
is candidate selection, not relevance evidence. Generic labels, synonyms and
areas that cross the two taxonomies can require further selector work.

The report's `candidateHash` binds a review to that leaf's generated topic IDs.
No candidate enters the runtime map without a complete review.

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
labelling. Record `on-target` or `off-target` for every row; uncertain results
count as misses. Join the labels back to work IDs only after finishing the
blind labels. Blindness is a review procedure: the generator cannot prove that
an annotator did not inspect the hidden data.

The reviews JSON is keyed by leaf ID. Each value contains:

| Key | Contents |
| --- | --- |
| `candidateHash` | The hash from the candidate report |
| `capturedAt` | UTC capture timestamp |
| `query` | The works URL as sent; a `mailto` may be left out, as it does not change the results |
| `works` | Every returned work, newest first, with only `id`, `type`, `title`, `publication_date` and `primary_topic.id` |
| `labels` | One `{ "workId": "https://openalex.org/W…", "label": "on-target" }` or `off-target` per work |

The abstracts stay out of the repository: the query's `has_abstract:true`, which
the gate requires, shows that every work had one, and the work IDs lead back to
the full records.

Admission requires a full page of 15 unique recent articles, complete labels,
and at least two thirds (10 of 15) on target. PR #236 reports 74.1% overall
and a lowest accepted profile of 66.0%, but does not state a formal per-leaf
threshold. Two thirds is a conservative rounding of that observed floor; PAP-99
adopted it as the rule. The original 14 lists retain their existing acceptance.

Low precision and short samples leave a leaf disabled and are reported as
`rejected` or `insufficient-sample`. Invalid, stale or incomplete evidence
aborts generation before the previous map is overwritten. `not-reviewed`,
`no-candidates` and `no-catalogue` are not failed precision tests.

After review, retain the evidence in `scripts/data/openalex-topic-reviews.json`
and keep the catalogue unchanged, since a different catalogue changes the
candidate hashes. Regenerate with the default command and verify `--check`.
Do not hand-edit the generated file or replace unknown access, citation counts
or review status while labelling. A source's explicit
`open_access.is_oa: false` is evidence of subscription access; missing access
is unknown.

The generator tests use synthetic data and run in `npm test`. They verify the
admission mechanics; they do not establish live precision or feed composition.

## The 2026-10-23 sample (PAP-99)

107 anonymous requests, one per proposed leaf, between 08:04 and 08:05 UTC, all
answered 200 at 1 credit each. The coverage report records each leaf's
`sampleSize`, `onTarget` and decision:

| Decision | Leaves |
| --- | --- |
| `passed` (10 or more of 15 on target) | 40 |
| `rejected` | 64 |
| `insufficient-sample` | 3: `math.OC` (0 articles), `med.endo` (12), `chemeng.metal` (13) |
| `no-candidates` | 22 |
| `inherited` | 14 |

Three labellers each labelled a third of the leaves; every leaf has one
labeller. The label is `on-target` when a researcher who chose the leaf would
recognise the article as work in their field. The sheets departed from the
procedure above. They kept OpenAlex's newest-first order and its work IDs
rather than shuffled, opaque rows. Each row showed the venue, the year and
OpenAlex's access flag beside the title and the first 300 characters of the
abstract. The labellers report judging from the title, the abstract and the
venue. Topic IDs, the query and the proposed mapping were hidden.
