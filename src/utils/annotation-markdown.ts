export function annotationMarkdown({ quote, note }: { quote?: string | null; note?: string | null }) {
  const passage = (quote ?? '').trim();
  const body = (note ?? '').trim();
  const quoted = passage
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => `> *${line.replace(/([*_])/g, '\\$1')}*`)
    .join('\n>\n');
  return [quoted, body].filter(Boolean).join('\n\n');
}
