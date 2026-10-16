export function isTechnicalClassification(value) {
  const label = String(value || '').trim();
  return /^\d{2}\.\d{2}\.[A-Za-z0-9+-]{1,4}$/.test(label);
}
