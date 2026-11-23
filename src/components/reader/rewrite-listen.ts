import type { RewriteSection } from '../../models/rewrite.ts';
import type { Block } from '../../utils/full-text.ts';
import { fullTextListen } from '../pdf/read-aloud.ts';

export function rewriteListen(sections: RewriteSection[]) {
  const body: Block[] = [];
  const passages: string[] = [];
  for (const [index, section] of sections.entries()) {
    body.push({ t: 'heading', level: 2, label: String(index + 1), children: [{ t: 'text', text: section.heading || section.kind }] });
    passages.push('');
    for (const [paragraph, text] of section.paragraphs.entries()) {
      body.push({ t: 'p', children: [{ t: 'text', text }] });
      passages.push(`${section.id}:${paragraph}`);
    }
  }
  const spoken = fullTextListen({ abstract: [], body }, { withAbstract: false });
  return { ...spoken, queue: spoken.queue.map(item => ({ ...item, passage: passages[Number(item.passage.slice(1))] })) };
}
