import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// The part of D1's binding the paper store uses, over an in-memory SQLite with
// the store's migrations applied: what D1 itself runs, so the store's SQL is
// tested as written. Test-only.

type Value = string | number | bigint | null | Uint8Array;

function bindable(value: unknown): Value {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return (value ?? null) as Value;
}

// What one D1 call may carry, as D1 refuses it.
const CALL_LIMIT_BYTES = 32 * 1024 * 1024;

function withinCallLimit(statements: Statement[]) {
  const bytes = statements.reduce<number>((sum, statement) => sum + statement.params
    .reduce<number>((size, param) => size + (typeof param === 'string' ? Buffer.byteLength(param) : param instanceof Uint8Array ? param.byteLength : 8), 0), 0);
  if (bytes > CALL_LIMIT_BYTES) {
    throw new Error(`D1_ERROR: Serialized RPC arguments or return values are limited to 32MiB, but the size of this value was: ${bytes} bytes.`);
  }
}

class Statement {
  db: DatabaseSync;
  sql: string;
  params: Value[] = [];
  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...params: unknown[]) {
    const bound = new Statement(this.db, this.sql);
    bound.params = params.map(bindable);
    return bound;
  }

  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true, meta: {} };
  }

  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }

  async run() {
    return { success: true, meta: { changes: Number(this.runNow().changes) } };
  }

  runNow() {
    return this.db.prepare(this.sql).run(...this.params);
  }
}

export function testD1() {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  const binding = {
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      withinCallLimit(statements);
      db.exec('BEGIN');
      try {
        // A read in a batch answers its rows, as D1's does.
        const results = statements.map(statement => (/^\s*SELECT/i.test(statement.sql)
          ? { success: true, results: statement.db.prepare(statement.sql).all(...statement.params), meta: {} }
          : { success: true, meta: { changes: Number(statement.runNow().changes) } }));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { binding: binding as unknown as D1Database, db };
}
