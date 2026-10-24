import type { ReaderCopy } from './paper-reader.tsx';

export default function UsesCount({ left, limit, copy }: { left: number; limit: number; copy: ReaderCopy }) {
  return (
    <>
      <span aria-hidden="true">{`${left}/${limit}`}</span>
      <span className="visually-hidden">{copy.usesLeftLine(left, limit)}</span>
    </>
  );
}
