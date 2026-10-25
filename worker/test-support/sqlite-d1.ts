import type { DatabaseSyncOptions } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// The part of D1's binding the paper store uses, over an in-memory SQLite with
// the store's migrations applied: what D1 itself runs, so the store's SQL is
// tested as written. Test-only.

type Value = string | number | bigint | null | Uint8Array;

// D1's SQLite limits, each one past it refused by local D1 (2026-10-23). Node
// applies `limits` from version 24; Node 22, which CI runs, ignores the option
// (and @types/node 22 does not declare it), so the two the store's SQL comes
// near, compound terms and bound parameters, are also checked below.
const D1_LIMITS = { compoundSelect: 5, variableNumber: 100, exprDepth: 100, likePatternLength: 50 };

// The most terms of any one compound SELECT in the statement: compound
// operators are counted per parenthesis level, outside literals, quoted names
// and comments.
function compoundTerms(sql: string) {
  const code = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  const levels = [1];
  let most = 1;
  for (const [token] of code.matchAll(/[()]|\b(?:UNION|INTERSECT|EXCEPT)\b/gi)) {
    if (token === '(') levels.push(1);
    else if (token === ')') levels.pop();
    else most = Math.max(most, (levels[levels.length - 1] += 1));
  }
  return most;
}

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

  // SQLite's own messages, which D1 relays.
  prepared() {
    if (this.params.length > D1_LIMITS.variableNumber) throw new Error('too many SQL variables');
    if (compoundTerms(this.sql) > D1_LIMITS.compoundSelect) throw new Error('too many terms in compound SELECT');
    return this.db.prepare(this.sql);
  }

  async all<T>() {
    return { results: this.prepared().all(...this.params) as T[], success: true, meta: {} };
  }

  async first<T>() {
    return (this.prepared().get(...this.params) as T | undefined) ?? null;
  }

  async run() {
    return { success: true, meta: { changes: Number(this.runNow().changes) } };
  }

  runNow() {
    return this.prepared().run(...this.params);
  }
}

export function testD1() {
  const options: DatabaseSyncOptions & { limits: typeof D1_LIMITS } = { limits: D1_LIMITS };
  const db = new DatabaseSync(':memory:', options);
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
          ? { success: true, results: statement.prepared().all(...statement.params), meta: {} }
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
