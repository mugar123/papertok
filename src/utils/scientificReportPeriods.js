const DAY_MS = 24 * 60 * 60 * 1000;

export function formatReportDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDate(value) {
  return new Date(`${value}T00:00:00`);
}

export function getDateThresholds(timeframe, currentDate = new Date()) {
  if (typeof timeframe === 'object' && timeframe?.type === 'custom') {
    const fromDate = parseLocalDate(timeframe.from);
    const toDate = parseLocalDate(timeframe.to);
    const difference = Math.floor((toDate - fromDate) / DAY_MS);
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
  const currentFrom = parseLocalDate(current.fromStr);
  const previousTo = new Date(currentFrom);
  previousTo.setDate(currentFrom.getDate() - 1);
  const previousFrom = new Date(previousTo);
  previousFrom.setDate(previousTo.getDate() - (current.days - 1));

  return {
    current,
    previous: {
      fromStr: formatReportDate(previousFrom),
      toStr: formatReportDate(previousTo),
      days: current.days,
    },
  };
}
