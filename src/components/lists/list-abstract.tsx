import type { Paper } from '../../models/paper.ts';
import ScientificText from '../scientific-text.ts';
import ListClampedText from './list-clamped-text.tsx';
import { listAbstractText } from './list-abstract-text.ts';

/**
 * The abstract a list keeps of a paper, clamped under its title. An excerpt
 * cut at its storage cap ends in an ellipsis; the paper itself has the rest.
 */
export default function ListAbstract({ paper }: { paper: Partial<Pick<Paper, 'abstract' | 'summary' | 'language'>> }) {
  const abstract = listAbstractText(paper);
  if (!abstract) return null;
  return (
    <ListClampedText
      text={abstract.text}
      className="lists-paper-abstract"
      textClassName="lists-paper-abstract-text"
      lang={paper.language}
    >
      <ScientificText>{abstract.text}</ScientificText>
      {abstract.cut && '…'}
    </ListClampedText>
  );
}
