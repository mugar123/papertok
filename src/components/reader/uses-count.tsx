/** What is left of a day's allowance: "3/10" to the eye, and a sentence to a screen reader. */
export default function UsesCount({ left, limit, what = 'AI uses' }: { left: number; limit: number; what?: string }) {
  return (
    <>
      <span aria-hidden="true">{`${left}/${limit}`}</span>
      <span className="visually-hidden">{`${left} of ${limit} ${what} left today.`}</span>
    </>
  );
}
