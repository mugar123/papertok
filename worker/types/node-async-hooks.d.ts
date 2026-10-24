// `nodejs_compat` (wrangler.toml) provides this module at runtime, but the
// Worker's TypeScript program has Workers types only, not Node's.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<Store> {
    getStore(): Store | undefined;
    run<Result>(store: Store, callback: () => Result): Result;
  }
}
