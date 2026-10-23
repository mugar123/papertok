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
is empty until new leaves have been sampled and labelled. The generator does
not call OpenAlex or the production relay.

The Worker's nightly harvest gives every leaf in the generated map its own
`openalex-topics` lane (`categoryLaneJobs()` in `worker/paper-sources.ts`). Each
lane asks for up to 5 pages a night from the harvest's OpenAlex share, so every
admitted leaf adds up to 5 OpenAlex calls a night.

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

Ask `https://api.openalex.org/works` directly, anonymously, with `mailto`.
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

Keep the entire returned page. Prepare a separate, shuffled review sheet with
only the target leaf, opaque row IDs, titles and decoded abstracts. Hide topic
IDs, query, venue, access and the proposed mapping while labelling. Record
`on-target` or `off-target` for every row; uncertain results count as misses.
Join the labels back to work IDs only after finishing the blind labels.
Blindness is a review procedure: the generator cannot prove that an annotator
did not inspect the hidden data.

The reviews JSON is keyed by leaf ID. Each value contains:

| Key | Contents |
| --- | --- |
| `candidateHash` | The hash from the candidate report |
| `capturedAt` | UTC capture timestamp |
| `query` | The direct, anonymous works URL, including `mailto` |
| `works` | All returned OpenAlex work records, newest first |
| `labels` | One `{ "workId": "https://openalex.org/W…", "label": "on-target" }` or `off-target` per record |

Admission requires a full page of 15 unique recent articles, complete labels,
and at least two thirds (10 of 15) on target. PR #236 reports 74.1% overall
and a lowest accepted profile of 66.0%, but does not state a formal per-leaf
threshold. Two thirds is a conservative rounding of that observed floor, not a
quoted policy. Confirm that interpretation during independent review before admitting
new leaves. The original 14 lists retain their existing acceptance.

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
