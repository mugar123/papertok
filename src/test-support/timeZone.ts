/**
 * Runs `run` with the process clock in `timeZone`, then puts the previous zone
 * back. Node applies a TZ assigned at runtime to every Date made after it, and
 * `node --test` runs each test file in a process of its own.
 */
export async function inTimeZone<T>(timeZone: string, run: () => T | Promise<T>): Promise<T> {
  const previous = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = timeZone;
  try {
    return await run();
  } finally {
    process.env.TZ = previous;
  }
}
