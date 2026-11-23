/** What is left of the day's AI uses: "3/10" to the eye, and a sentence to a screen reader. */
export default function UsesCount({ left, limit }: { left: number; limit: number }) {
  return (
    <>
      <span aria-hidden="true">{`${left}/${limit}`}</span>
      <span className="visually-hidden">{`${left} of ${limit} AI uses left today.`}</span>
    </>
  );
}
