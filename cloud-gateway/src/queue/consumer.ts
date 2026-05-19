import type { RequestLog } from '../types.js'

export class InMemoryLogQueue {
  readonly logs: RequestLog[] = []

  enqueue(log: RequestLog): void {
    this.logs.push(log)
  }
}
