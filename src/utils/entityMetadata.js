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
