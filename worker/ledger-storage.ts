// Ledgers await reads and ignore write results. The synchronous forms also
// describe the in-memory transaction fixtures used by the Node tests.
export interface LedgerTransaction {
  get<T = unknown>(key: string): T | undefined | Promise<T | undefined>;
  put(key: string, value: unknown): unknown;
  delete(key: string): unknown;
}
export interface ListedLedgerTransaction extends LedgerTransaction {
  list<T = unknown>(options: { prefix: string }): Map<string, T> | Promise<Map<string, T>>;
}
export interface LedgerStorage<Transaction extends LedgerTransaction = LedgerTransaction> {
  transaction<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T>;
}
