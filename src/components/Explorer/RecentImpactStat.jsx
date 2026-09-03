const IMPACT_LEVELS_EN = {
  Excepcional: 'Exceptional',
  'Muy alto': 'Very high',
  'Por encima de la media': 'Above average',
  'En la media': 'Average',
  'Por debajo de la media': 'Below average',
  Bajo: 'Low',
};

function unavailableCopy({ error, impact, isEnglish }) {
  if (error === 'rate_limited') {
    return {
      title: isEnglish
        ? 'OpenAlex has temporarily limited requests. The score will return when available.'
        : 'OpenAlex ha limitado temporalmente las consultas. La nota se recuperará cuando vuelva a estar disponible.',
      detail: isEnglish ? 'Temporary limit' : 'Límite temporal',
    };
  }
  if (error === 'timeout') {
    return {
      title: isEnglish
        ? 'OpenAlex did not respond in time. PaperTok will try again later.'
        : 'OpenAlex no respondió a tiempo. PaperTok volverá a intentarlo más tarde.',
      detail: isEnglish ? 'No response' : 'Sin respuesta',
    };
  }
  if (error === 'network_error') {
    return {
      title: isEnglish
        ? 'The recent-impact score cannot be updated while offline.'
        : 'La nota de impacto reciente no puede actualizarse sin conexión.',
      detail: isEnglish ? 'Offline' : 'Sin conexión',
    };
  }
  if (error) {
    return {
      title: isEnglish
        ? 'Recent impact could not be retrieved from OpenAlex.'
        : 'No se pudo consultar el impacto reciente en OpenAlex.',
      detail: isEnglish ? 'Unavailable' : 'No disponible',
    };
  }
  if (impact?.reason === 'unresolved_identity') {
    return {
      title: isEnglish
        ? 'A verified OpenAlex profile is required to calculate this score.'
        : 'Se necesita un perfil verificado de OpenAlex para calcular esta nota.',
      detail: isEnglish ? 'Profile not resolved' : 'Perfil no resuelto',
    };
  }

  const minimum = impact?.minimumSampleSize || 0;
  return {
    title: isEnglish
      ? `The score requires at least ${minimum} recent publications with FWCI data.`
      : `La nota requiere al menos ${minimum} publicaciones recientes con datos FWCI.`,
    detail: isEnglish ? 'Insufficient data' : 'Datos insuficientes',
  };
}

export default function RecentImpactStat({ impact, isLoading, error, isEnglish }) {
  const localizedLevel = isEnglish
    ? IMPACT_LEVELS_EN[impact?.level] || impact?.level
    : impact?.level;
  const unavailable = unavailableCopy({ error, impact, isEnglish });
  const title = impact?.available
    ? (isEnglish
      ? `${impact.stale ? 'Last saved calculation. ' : ''}PaperTok estimate based on ${impact.sampleSize} recent publications with FWCI. Median FWCI: ${impact.medianFwci}; ${Math.round(impact.highImpactShare * 100)}% exceeds twice the expected impact.`
      : `${impact.stale ? 'Último cálculo guardado. ' : ''}Estimación PaperTok basada en ${impact.sampleSize} publicaciones recientes con FWCI. FWCI mediano: ${impact.medianFwci}; ${Math.round(impact.highImpactShare * 100)}% supera 2 veces el impacto esperado.`)
    : unavailable.title;
  const detail = isLoading
    ? (isEnglish ? 'Calculating…' : 'Calculando…')
    : impact?.available
      ? impact.stale
        ? `${isEnglish ? 'Saved' : 'Guardado'} · ${impact.period?.label || ''}`
        : `${localizedLevel} · ${impact.period?.label || ''}`
      : unavailable.detail;

  return (
    <div
      className={`ehc-stat-box ehc-stat-box--impact${impact?.stale ? ' ehc-stat-box--stale' : ''}`}
      title={title}
      aria-label={impact?.available
        ? (isEnglish
          ? `Recent impact ${impact.score} out of 10, ${localizedLevel}`
          : `Impacto reciente ${impact.score} sobre 10, ${localizedLevel}`)
        : (isEnglish ? 'Recent impact unavailable' : 'Impacto reciente no disponible')}
    >
      {/* `is-settled` once the score, or its absence, is known: the value then
          resolves in place from part-way visible (EntityExplorer.css) instead
          of the ellipsis being swapped for a number between two frames. Never
          at mount, where the hero's own crossfade is already running. */}
      <span className={`ehc-stat-value${!isLoading && (impact || error) ? ' is-settled' : ''}`}>
        {isLoading ? '…' : impact?.available ? impact.score.toFixed(1) : '—'}
        <span className="ehc-stat-scale">/ 10</span>
      </span>
      <span className="ehc-stat-label">{isEnglish ? 'Recent impact' : 'Impacto reciente'}</span>
      <span className="ehc-stat-detail">{detail}</span>
    </div>
  );
}
