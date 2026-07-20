export function getQuotaCountdown(resetAt, now = Date.now()) {
  const resetMs = Date.parse(resetAt || '');
  if (!Number.isFinite(resetMs)) return null;

  const totalSeconds = Math.max(0, Math.ceil((resetMs - now) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return { totalSeconds, hours, minutes, seconds };
}

export function formatQuotaCountdown(resetAt, now = Date.now()) {
  const countdown = getQuotaCountdown(resetAt, now);
  if (!countdown) return '';
  if (countdown.totalSeconds === 0) return 'menos de un minuto';
  if (countdown.hours > 0) return `${countdown.hours} h ${String(countdown.minutes).padStart(2, '0')} min`;
  if (countdown.minutes > 0) return `${countdown.minutes} min ${String(countdown.seconds).padStart(2, '0')} s`;
  return `${countdown.seconds} s`;
}

export function formatQuotaResetTime(resetAt, locale = 'es-ES') {
  const reset = new Date(resetAt || '');
  if (Number.isNaN(reset.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(reset);
}
