const DAY_MS = 24 * 60 * 60 * 1000;

export function formatReportDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function toUtcDay(value) {
  const parts = parseDateParts(value);
  if (!parts) return NaN;
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function parseUtcDate(value) {
  const timestamp = toUtcDay(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : new Date(NaN);
}

function formatUtcDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function getDateThresholds(timeframe, currentDate = new Date()) {
  if (typeof timeframe === 'object' && timeframe?.type === 'custom') {
    const difference = Math.floor((toUtcDay(timeframe.to) - toUtcDay(timeframe.from)) / DAY_MS);
    return {
      fromStr: timeframe.from,
      toStr: timeframe.to,
      days: Number.isFinite(difference) ? Math.max(1, difference + 1) : 1,
    };
  }

  const today = currentDate instanceof Date ? new Date(currentDate) : new Date(currentDate);
  const inclusiveDays = {
    '24h': 2,
    '7d': 7,
    '30d': 30,
    '1y': 365,
    '10y': 3650,
  }[timeframe] || 7;
  const fromDate = new Date(today);
  fromDate.setDate(today.getDate() - (inclusiveDays - 1));

  return {
    fromStr: formatReportDate(fromDate),
    toStr: formatReportDate(today),
    days: inclusiveDays,
  };
}

export function getComparisonPeriods(timeframe, currentDate = new Date()) {
  const current = getDateThresholds(timeframe, currentDate);
  const currentFrom = parseUtcDate(current.fromStr);
  const previousTo = new Date(currentFrom);
  previousTo.setUTCDate(currentFrom.getUTCDate() - 1);
  const previousFrom = new Date(previousTo);
  previousFrom.setUTCDate(previousTo.getUTCDate() - (current.days - 1));

  return {
    current,
    previous: {
      fromStr: formatUtcDate(previousFrom),
      toStr: formatUtcDate(previousTo),
      days: current.days,
    },
  };
}
