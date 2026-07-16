const MIN_CURRENT_COUNT = 5;
const SMOOTHING_COUNT = 2;
const SMOOTHING_TOTAL = 20;

function normalizeGroup(group) {
  return {
    id: String(group?.key || group?.id || ''),
    label: String(group?.key_display_name || group?.label || '').trim(),
    count: Math.max(0, Number(group?.count) || 0),
  };
}

function confidenceForVolume(volume) {
  if (volume >= 40) return 'high';
  if (volume >= 15) return 'medium';
  return 'low';
}

export function computeScientificTrends(currentData, previousData, options = {}) {
  const currentTotal = Math.max(0, Number(currentData?.total) || 0);
  const previousTotal = Math.max(0, Number(previousData?.total) || 0);
  const limit = Math.max(1, options.limit || 5);

  const periodData = {
    current: options.currentPeriod || null,
    previous: options.previousPeriod || null,
  };

  if (currentTotal === 0 || previousTotal === 0) {
    return {
      status: 'insufficient',
      source: 'openalex',
      provisional: Boolean(options.provisional),
      periods: periodData,
      items: [],
    };
  }

  const previousGroups = new Map(
    (previousData?.groups || [])
      .map(normalizeGroup)
      .filter(group => group.id)
      .map(group => [group.id, group]),
  );

  const items = (currentData?.groups || [])
    .map(normalizeGroup)
    .filter(group => group.id && group.label && group.count >= MIN_CURRENT_COUNT)
    .map(group => {
      const previous = previousGroups.get(group.id);
      if (!previous || previous.count < 3) return null;
      const currentShare = (group.count + SMOOTHING_COUNT) / (currentTotal + SMOOTHING_TOTAL);
      const previousShare = (previous.count + SMOOTHING_COUNT) / (previousTotal + SMOOTHING_TOTAL);
      const shareRatio = currentShare / previousShare;
      const changeRatio = shareRatio - 1;
      const score = Math.log2(Math.max(shareRatio, 0.01)) * Math.log1p(group.count);

      return {
        id: group.id,
        label: group.label,
        currentCount: group.count,
        previousCount: previous.count,
        currentShare,
        previousShare,
        changePercent: Math.round(changeRatio * 100),
        state: 'rising',
        confidence: confidenceForVolume(group.count + previous.count),
        score,
      };
    })
    .filter(item => item && item.changePercent >= 10 && item.score > 0)
    .sort((a, b) => b.score - a.score || b.currentCount - a.currentCount)
    .slice(0, limit)
    .map(item => {
      const publicItem = { ...item };
      delete publicItem.score;
      return publicItem;
    });

  return {
    status: items.length > 0 ? 'active' : 'insufficient',
    source: 'openalex',
    provisional: Boolean(options.provisional),
    periods: periodData,
    items,
  };
}

export function buildTrendMomentumLookup(trends) {
  const lookup = new Map();
  (trends?.items || []).forEach((trend, index, items) => {
    const rankWeight = items.length <= 1 ? 1 : 1 - (index / items.length) * 0.45;
    lookup.set(String(trend.id).toLowerCase(), rankWeight);
    lookup.set(String(trend.label).toLowerCase(), rankWeight);
  });
  return lookup;
}
