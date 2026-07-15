export function applyInstitutionWorksFallback(institution, worksCount) {
  if (!institution || !Number.isFinite(worksCount) || worksCount <= 0 || institution.works_count > 0) {
    return institution;
  }

  return {
    ...institution,
    works_count: worksCount,
    cited_by_count: institution.cited_by_count > 0 ? institution.cited_by_count : null,
    summary_stats: {
      ...institution.summary_stats,
      h_index: institution.summary_stats?.h_index > 0 ? institution.summary_stats.h_index : null,
      '2yr_mean_citedness': institution.summary_stats?.['2yr_mean_citedness'] > 0
        ? institution.summary_stats['2yr_mean_citedness']
        : null,
    },
    metrics_are_partial: true,
  };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function getRecentImpactPeriod(now = new Date()) {
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 0));
  const startDate = new Date(Date.UTC(
    endDate.getUTCFullYear() - 3,
    endDate.getUTCMonth() + 1,
    1,
  ));

  return {
    from: startDate.toISOString().slice(0, 10),
    to: endDate.toISOString().slice(0, 10),
    label: `${startDate.getUTCFullYear()}–${endDate.getUTCFullYear()}`,
  };
}

export function calculateInstitutionRecentImpact(works = [], minimumSampleSize = 50) {
  const fwciValues = works
    .map(work => work?.fwci)
    .filter(value => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  if (fwciValues.length < minimumSampleSize) {
    return {
      available: false,
      sampleSize: fwciValues.length,
      minimumSampleSize,
    };
  }

  const middle = Math.floor(fwciValues.length / 2);
  const medianFwci = fwciValues.length % 2 === 0
    ? (fwciValues[middle - 1] + fwciValues[middle]) / 2
    : fwciValues[middle];
  const highImpactShare = fwciValues.filter(value => value >= 2).length / fwciValues.length;

  // FWCI 1 is the field/age expectation. A 20% share above 2x impact also maps to 5/10.
  const fwciScore = clamp(5 + 2.5 * Math.log2(Math.max(medianFwci, 0.25)), 0, 10);
  const highImpactScore = clamp(2.5 + 12.5 * highImpactShare, 0, 10);
  const score = Math.round((fwciScore * 0.7 + highImpactScore * 0.3) * 10) / 10;

  const level = score >= 8.5
    ? 'Excepcional'
    : score >= 7
      ? 'Muy alto'
      : score >= 5.5
        ? 'Por encima de la media'
        : score >= 4.5
          ? 'En la media'
          : score >= 3
            ? 'Por debajo de la media'
            : 'Bajo';

  return {
    available: true,
    score,
    level,
    sampleSize: fwciValues.length,
    medianFwci: Math.round(medianFwci * 100) / 100,
    highImpactShare: Math.round(highImpactShare * 1000) / 1000,
    minimumSampleSize,
  };
}

export function deduplicateProjectParticipants(participants = []) {
  const uniqueParticipants = new Map();

  for (const participant of participants) {
    const name = participant?.name?.trim();
    if (!name || name.toLowerCase() === 'unknown') continue;

    const key = (participant.searchName?.trim() || name)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const existing = uniqueParticipants.get(key);

    if (existing) {
      const mergedParticipant = {
        ...existing,
        country: existing.country || participant.country || null,
        website: existing.website || participant.website || null,
      };
      const searchName = existing.searchName || participant.searchName;
      if (searchName) mergedParticipant.searchName = searchName;
      uniqueParticipants.set(key, mergedParticipant);
    } else {
      uniqueParticipants.set(key, { ...participant, name });
    }
  }

  return [...uniqueParticipants.values()];
}
