import type { PaperAuthor } from '../../models/paper.ts';

export default function AuthorDots({ authors, max = 3 }: { authors: Array<PaperAuthor | string>; max?: number }) {
  return (
    <>
      {authors.slice(0, max).map((author, i) => (
        <span key={i} className="pc-author-avatar" style={{ '--i': i }} aria-hidden="true">
          {(typeof author === 'string' ? author : author.name).charAt(0).toUpperCase()}
        </span>
      ))}
      {authors.length > max && (
        <span className="pc-author-avatar" style={{ '--i': max }} aria-hidden="true">
          {`+${authors.length - max}`}
        </span>
      )}
    </>
  );
}
