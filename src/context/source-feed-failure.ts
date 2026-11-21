/** The source keeps the failed attempt even when its error screen unmounts. */
export function sourceFeedFailure(error: unknown) {
  let pending = true;
  return {
    error,
    takeReport() {
      const owed = pending;
      pending = false;
      return owed;
    },
  };
}
