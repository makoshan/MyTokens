// Minimal subset of Cloudflare Workers runtime types we depend on.
//
// We deliberately avoid `@cloudflare/workers-types` in the global types list
// because that package re-declares Response / Request / json() with types
// that conflict with node 20's lib.dom globals and break the Node-based test
// runner. The DO class only needs DurableObjectState's storage handle —
// declared here just enough for tsc and forwarded by wrangler at runtime.

export interface DurableObjectStorageGet {
  <T = unknown>(key: string): Promise<T | undefined>
}

export interface DurableObjectStorage {
  get: DurableObjectStorageGet
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}

export interface DurableObjectState {
  readonly id: { toString(): string }
  readonly storage: DurableObjectStorage
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}
