import type { Paper } from './paper.ts';

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

export function storedPaperEvidence(paper: Pick<Partial<Paper>, 'studyType' | 'trialRegistration' | 'trialRegistrationSource'>) {
  const studyType = studyTypeFromIds([paper.studyType]);
  const trialRegistration = readTrialRegistration(paper.trialRegistration);
  return {
    ...(studyType && { studyType }),
    ...(trialRegistration && { trialRegistration }),
    ...(trialRegistration && paper.trialRegistrationSource === 'pubmed-secondary-source'
      && { trialRegistrationSource: paper.trialRegistrationSource }),
  };
}

function firstTrialId(first: string | undefined, second: string | undefined) {
  return first && second && first > second ? second : first ?? second;
}

export function withPaperEvidenceOf<T extends Partial<Paper>>(paper: T, other: Partial<Paper> | null | undefined): T {
  const studyType = studyTypeFromIds([paper.studyType, other?.studyType]);
  const first = readTrialRegistration(paper.trialRegistration);
  const second = readTrialRegistration(other?.trialRegistration);
  // An indexed accession can identify the study when the abstract cites other trials.
  const indexed = firstTrialId(
    paper.trialRegistrationSource === 'pubmed-secondary-source' ? first : undefined,
    other?.trialRegistrationSource === 'pubmed-secondary-source' ? second : undefined,
  );
  const trialRegistration = indexed ?? firstTrialId(first, second);
  const trialRegistrationSource = indexed ? 'pubmed-secondary-source' : undefined;
  return studyType === paper.studyType && trialRegistration === paper.trialRegistration
    && trialRegistrationSource === paper.trialRegistrationSource
    ? paper
    : { ...paper, studyType, trialRegistration, trialRegistrationSource };
}
