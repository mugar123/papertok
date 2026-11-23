import type { ConferenceMark, Paper } from './paper.ts';

// Prefer the narrower label when a record carries both review types.
const STUDY_TYPES = ['practice-guideline', 'meta-analysis', 'systematic-review', 'randomized-controlled-trial'] as const;
export type StudyType = typeof STUDY_TYPES[number];

export function studyTypeFromIds(ids: readonly unknown[]) {
  return STUDY_TYPES.find(type => ids.includes(type));
}

export function readTrialRegistration(value: unknown) {
  return typeof value === 'string' && value.length === 11 && /^NCT[0-9]{8}$/.test(value) ? value : undefined;
}

export function trialRegistrationFromAbstract(abstract: unknown) {
  return typeof abstract === 'string' ? abstract.match(/\bNCT[0-9]{8}\b/i)?.[0].toUpperCase() : undefined;
}

export function trialRegistrationUrl(value: unknown) {
  const id = readTrialRegistration(value);
  return id ? `https://clinicaltrials.gov/study/${id}` : undefined;
}

export function readStoredStudyType(copy: { studyType?: unknown; studyTypes?: unknown }) {
  const observed = copy.studyTypes;
  const labels = observed && typeof observed === 'object'
    ? Object.entries(observed).filter(([, present]) => present === true).map(([type]) => type)
    : [];
  return studyTypeFromIds([copy.studyType, ...labels]);
}

export function storedPaperEvidence(paper: Pick<Partial<Paper>, 'studyType' | 'trialRegistration' | 'trialRegistrationSource' | 'acceptedConference' | 'corpusUpdatedAt'>) {
  const studyType = readStoredStudyType(paper);
  const { corpusUpdatedAt } = paper;
  const trialRegistration = readTrialRegistration(paper.trialRegistration);
  return {
    ...(studyType && { studyType }),
    ...(corpusUpdatedAt !== undefined && { corpusUpdatedAt }),
    ...(paper.acceptedConference && { acceptedConference: paper.acceptedConference }),
    ...(trialRegistration && { trialRegistration }),
    ...(trialRegistration && paper.trialRegistrationSource === 'pubmed-secondary-source'
      && { trialRegistrationSource: paper.trialRegistrationSource }),
  };
}

function firstTrialId(first: string | undefined, second: string | undefined) {
  return first && second && first > second ? second : first ?? second;
}

export function mergeConferenceMarks(first?: ConferenceMark, second?: ConferenceMark, openReviewVenueId?: string): ConferenceMark | undefined {
  if (!first || !second) return first ?? second;
  const preferred = second.evidence === 'openreview' ? second : first;
  if (first.id !== second.id) return first.evidence === second.evidence ? undefined : preferred;
  let year = first.year ?? second.year;
  if (first.year && second.year && first.year !== second.year) year = undefined;
  // After a year conflict the stored mark is undated. The original OpenReview
  // venue ID still distinguishes its edition when arXiv repeats its comment.
  if (year && preferred.evidence === 'openreview' && openReviewVenueId && openReviewVenueId.split('/')[1] !== String(year)) year = undefined;
  return { id: preferred.id, label: preferred.label, evidence: preferred.evidence, ...(year && { year }) };
}

function sameConference(first?: ConferenceMark, second?: ConferenceMark) {
  return first === second || (!!first && !!second && first.id === second.id && first.label === second.label
    && first.year === second.year && first.evidence === second.evidence);
}

export function mergedPaperEvidence(paper: Partial<Paper>, other: Partial<Paper> | null | undefined) {
  const studyType = studyTypeFromIds([paper.studyType, other?.studyType]);
  const first = readTrialRegistration(paper.trialRegistration);
  const second = readTrialRegistration(other?.trialRegistration);
  // An indexed accession can identify the study when the abstract cites other trials.
  const indexed = firstTrialId(
    paper.trialRegistrationSource === 'pubmed-secondary-source' ? first : undefined,
    other?.trialRegistrationSource === 'pubmed-secondary-source' ? second : undefined,
  );
  const trialRegistration = indexed ?? firstTrialId(first, second);
  const trialRegistrationSource = indexed ? 'pubmed-secondary-source' as const : undefined;
  const stamp = paper.corpusUpdatedAt ?? -1;
  const otherStamp = other?.corpusUpdatedAt ?? -1;
  const corpusUpdatedAt = Math.max(stamp, otherStamp);
  let acceptedConference = paper.acceptedConference;
  if (otherStamp > stamp) acceptedConference = other?.acceptedConference;
  else if (stamp === otherStamp && other) {
    if (stamp < 0) acceptedConference = mergeConferenceMarks(acceptedConference, other.acceptedConference, other.openReviewVenueId ?? paper.openReviewVenueId);
    else if (!sameConference(acceptedConference, other.acceptedConference)) acceptedConference = undefined;
  }
  return { studyType, trialRegistration, trialRegistrationSource, acceptedConference,
    ...(corpusUpdatedAt >= 0 && { corpusUpdatedAt }) };
}

export function withPaperEvidenceOf<T extends Partial<Paper>>(paper: T, other: Partial<Paper> | null | undefined): T {
  const evidence = mergedPaperEvidence(paper, other);
  const { studyType, trialRegistration, trialRegistrationSource, acceptedConference, corpusUpdatedAt } = evidence;
  if (studyType === paper.studyType && trialRegistration === paper.trialRegistration
    && trialRegistrationSource === paper.trialRegistrationSource && sameConference(acceptedConference, paper.acceptedConference)
    && corpusUpdatedAt === paper.corpusUpdatedAt) return paper;
  const merged = { ...paper, ...evidence };
  if (!acceptedConference) delete merged.acceptedConference;
  return merged;
}

/** Keep evidence from later batches even when their duplicate cards are dropped. */
export function mergeFeedEvidence(shown: Paper[], incoming: Paper[]) {
  if (!shown.length || !incoming.length) return shown;
  const records = new Map<string, Paper>();
  for (const paper of incoming) {
    if (!paper.studyType && !paper.trialRegistration && !paper.acceptedConference && paper.corpusUpdatedAt === undefined) continue;
    const other = records.get(paper.id);
    records.set(paper.id, other ? withPaperEvidenceOf(paper, other) : paper);
  }
  let merged = shown;
  for (const [index, paper] of shown.entries()) {
    const record = records.get(paper.id);
    if (!record) continue;
    const next = withPaperEvidenceOf(paper, record);
    if (next === paper) continue;
    if (merged === shown) merged = shown.slice();
    merged[index] = next;
  }
  return merged;
}
