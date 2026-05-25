import path from 'node:path'
import { infraId } from '@neat.is/types'
import {
  lineAt,
  lineOf,
  mergeEndpointSite,
  snippet,
  type ExternalEndpoint,
  type SourceFile,
} from './shared.js'

// Redis URLs in source — `redis://host[:port]` or `rediss://...`. We only
// catch literal strings; env-driven URLs go through the database parsers
// (.env, ormconfig, etc.) and don't need a CALLS edge.
const REDIS_URL_RE = /redis(?:s)?:\/\/(?:[^@'"`\s]+@)?([^:/'"`\s]+)(?::(\d+))?/g

export function redisEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  const byHost = new Map<string, ExternalEndpoint>()
  const rel = path.relative(serviceDir, file.path)
  REDIS_URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = REDIS_URL_RE.exec(file.content)) !== null) {
    const host = m[1]!
    const existing = byHost.get(host)
    if (existing) {
      // Another `redis://host` literal for the same host — keep it as a
      // distinct call site rather than dropping it (#396 / ADR-087). Line
      // comes from this match's offset, not a first-occurrence search.
      const line = lineAt(file.content, m.index)
      mergeEndpointSite(existing, { file: rel, line, snippet: snippet(file.content, line) })
      continue
    }
    // Primary evidence keeps `lineOf` so existing single-site emissions stay
    // byte-identical.
    const line = lineOf(file.content, host)
    byHost.set(host, {
      infraId: infraId('redis', host),
      name: host,
      kind: 'redis',
      edgeType: 'CALLS',
      // `redis://host` URL literal — the scheme is structural support, but no
      // call expression is verified to wire it through. URL-with-structural-
      // support tier (ADR-066).
      confidenceKind: 'url-with-structural-support',
      evidence: {
        file: rel,
        line,
        snippet: snippet(file.content, line),
      },
    })
  }
  return [...byHost.values()]
}
