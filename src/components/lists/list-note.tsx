import { Note } from '@phosphor-icons/react';
import ListClampedText from './list-clamped-text.tsx';

/**
 * What the reader added to a saved paper: their note and their tags, in one
 * well under the paper's own text so the two are never read as one voice.
 */
export default function ListNote({ note, tags }: { note?: string; tags?: string[] }) {
  // `role="list"`: Safari drops the list role from a `ul` without bullets.
  const tagList = tags?.length ? (
    <ul className="lists-paper-tags" role="list" aria-label="Your tags">
      {tags.map((tag) => <li key={tag}>{tag}</li>)}
    </ul>
  ) : null;
  if (!note) {
    return tagList && (
      <div className="lists-paper-note">
        <div className="lists-paper-note-head">
          <span className="lists-paper-note-label" aria-hidden="true">{'Your tags'}</span>
          {tagList}
        </div>
      </div>
    );
  }
  return (
    <ListClampedText
      text={note}
      className="lists-paper-note"
      textClassName="lists-paper-note-text"
      header={(
        <div className="lists-paper-note-head">
          <span className="lists-paper-note-label">
            <Note size={13} aria-hidden="true" />
            {'Your note'}
          </span>
          {tagList}
        </div>
      )}
    />
  );
}
