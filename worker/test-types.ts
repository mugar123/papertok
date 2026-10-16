export interface TestNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): Pick<DurableObjectStub, 'fetch'>;
}

export interface TestCache {
  match(request: RequestInfo | URL): Promise<Response | null | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<unknown>;
}
export type TestGlobals = typeof globalThis & { caches?: { default: TestCache } };
