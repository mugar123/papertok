// Scores are computed in English now (entityMetadata.js), but impact cached
// before the interface went English-only carries the level in Spanish; this
// reads those old records. It is data, not interface copy.
const LEGACY_IMPACT_LEVELS = {
  Excepcional: 'Exceptional',
  'Muy alto': 'Very high',
  'Por encima de la media': 'Above average',
  'En la media': 'Average',
  'Por debajo de la media': 'Below average',
  Bajo: 'Low',
};

function unavailableCopy({ error, impact }) {
  if (error === 'rate_limited') {
    return {
      title: 'OpenAlex has temporarily limited requests. The score will return when available.',
      detail: 'Temporary limit',
    };
  }
  if (error === 'timeout') {
    return {
      title: 'OpenAlex did not respond in time. PaperTok will try again later.',
      detail: 'No response',
    };
  }
  if (error === 'network_error') {
    return {
      title: 'The recent-impact score cannot be updated while offline.',
      detail: 'Offline',
    };
  }
  if (error) {
    return {
      title: 'Recent impact could not be retrieved from OpenAlex.',
      detail: 'Unavailable',
    };
  }
  if (impact?.reason === 'unresolved_identity') {
    return {
      title: 'A verified OpenAlex profile is required to calculate this score.',
      detail: 'Profile not resolved',
    };
  }

  const minimum = impact?.minimumSampleSize || 0;
  return {
    title: `The score requires at least ${minimum} recent publications with FWCI data.`,
    detail: 'Insufficient data',
  };
}

export default function RecentImpactStat({ impact, isLoading, error }) {
  const localizedLevel = LEGACY_IMPACT_LEVELS[impact?.level] || impact?.level;
  const unavailable = unavailableCopy({ error, impact });
  const title = impact?.available
    ? (`${impact.stale ? 'Last saved calculation. ' : ''}PaperTok estimate based on ${impact.sampleSize} recent publications with FWCI. Median FWCI: ${impact.medianFwci}; ${Math.round(impact.highImpactShare * 100)}% exceeds twice the expected impact.`)
    : unavailable.title;
  const detail = isLoading
    ? ('Calculating…')
    : impact?.available
      ? impact.stale
        ? `${'Saved'} · ${impact.period?.label || ''}`
        : `${localizedLevel} · ${impact.period?.label || ''}`
      : unavailable.detail;

  return (
    <div
      className={`ehc-stat-box ehc-stat-box--impact${impact?.stale ? ' ehc-stat-box--stale' : ''}`}
      title={title}
      aria-label={impact?.available
        ? (`Recent impact ${impact.score} out of 10, ${localizedLevel}`)
        : ('Recent impact unavailable')}
    >
      {/* `is-settled` once the score, or its absence, is known: the value then
          resolves in place from part-way visible (EntityExplorer.css) instead
          of the ellipsis being swapped for a number between two frames. Never
          at mount, where the hero's own crossfade is already running. */}
      <span className={`ehc-stat-value${!isLoading && (impact || error) ? ' is-settled' : ''}`}>
        {isLoading ? '…' : impact?.available ? impact.score.toFixed(1) : '—'}
        <span className="ehc-stat-scale">/ 10</span>
      </span>
      <span className="ehc-stat-label">{'Recent impact'}</span>
      <span className="ehc-stat-detail">{detail}</span>
    </div>
  );
}
