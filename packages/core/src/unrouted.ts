/**
 * Unrouted-span logging (v0.4.1 — refs #339).
 *
 * When the daemon's routing layer can't deliver a span — service.name
 * matches no registered project AND no `default` project exists — we still
 * return 200 on the receiver (OTLP spec), but the dropped event lands here
 * so the next operator can see what happened. The log lives at
 * `<NEAT_HOME>/errors.ndjson` because the unrouted span doesn't belong to
 * any project's neat-out directory.
 *
 * Owner: this module. Daemon imports the appender + warner; no other code
 * writes to the no-project-match log path. Keeping the writes here keeps
 * daemon.ts free of direct `fs.appendFile` calls (asserted by the daemon
 * contract test).
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface UnroutedSpanRecord {
  timestamp: string
  reason: 'no-project-match'
  service_name: string | null
  traceId: string | null
}

export function buildUnroutedSpanRecord(
  serviceName: string | undefined,
  traceId: string | undefined,
  now: Date = new Date(),
): UnroutedSpanRecord {
  return {
    timestamp: now.toISOString(),
    reason: 'no-project-match',
    service_name: serviceName ?? null,
    traceId: traceId ?? null,
  }
}

export async function appendUnroutedSpan(
  neatHome: string,
  record: UnroutedSpanRecord,
): Promise<void> {
  const target = path.join(neatHome, 'errors.ndjson')
  await fs.mkdir(neatHome, { recursive: true })
  await fs.appendFile(target, JSON.stringify(record) + '\n', 'utf8')
}

export function unroutedErrorsPath(neatHome: string): string {
  return path.join(neatHome, 'errors.ndjson')
}
