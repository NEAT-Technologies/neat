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

// AWS SDK v3 calls. We catch S3 (`Bucket: "x"` near a `S3Client`-using
// PutObjectCommand / GetObjectCommand / DeleteObjectCommand) and DynamoDB
// (`TableName: "x"` near GetCommand / PutCommand / DynamoDBClient). The
// pattern is intentionally permissive: a literal Bucket/TableName near an
// SDK constant is good enough evidence; misses are fine because non-static
// resources can't be catalogued anyway.
const S3_BUCKET_RE = /Bucket\s*:\s*['"`]([^'"`]+)['"`]/g
const DYNAMO_TABLE_RE = /TableName\s*:\s*['"`]([^'"`]+)['"`]/g

function hasMarker(text: string, markers: string[]): boolean {
  return markers.some((m) => text.includes(m))
}

function findAll(re: RegExp, text: string): { name: string; index: number }[] {
  re.lastIndex = 0
  const out: { name: string; index: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ name: m[1]!, index: m.index })
  }
  return out
}

export function awsEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  const byKey = new Map<string, ExternalEndpoint>()
  const rel = path.relative(serviceDir, file.path)
  const make = (kind: string, name: string, index: number): void => {
    const key = `${kind}|${name}`
    const existing = byKey.get(key)
    if (existing) {
      // Same bucket/table referenced again — keep it as a distinct call site
      // (#396 / ADR-087). Line comes from this match's offset.
      const line = lineAt(file.content, index)
      mergeEndpointSite(existing, { file: rel, line, snippet: snippet(file.content, line) })
      return
    }
    // Primary evidence keeps `lineOf` so single-site emissions stay identical.
    const line = lineOf(file.content, name)
    byKey.set(key, {
      infraId: infraId(kind, name),
      name,
      kind,
      edgeType: 'CALLS',
      // SDK marker (S3Client, GetCommand, etc.) plus a Bucket/TableName
      // literal — framework-aware recognizer, verified-call-site tier
      // (ADR-066).
      confidenceKind: 'verified-call-site',
      evidence: {
        file: rel,
        line,
        snippet: snippet(file.content, line),
      },
    })
  }

  if (hasMarker(file.content, ['S3Client', 'PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand'])) {
    for (const { name, index } of findAll(S3_BUCKET_RE, file.content)) make('s3-bucket', name, index)
  }
  if (
    hasMarker(file.content, [
      'DynamoDBClient',
      'DynamoDBDocumentClient',
      'GetCommand',
      'PutCommand',
      'QueryCommand',
      'UpdateCommand',
      'DeleteCommand',
    ])
  ) {
    for (const { name, index } of findAll(DYNAMO_TABLE_RE, file.content)) make('dynamodb-table', name, index)
  }
  return [...byKey.values()]
}
