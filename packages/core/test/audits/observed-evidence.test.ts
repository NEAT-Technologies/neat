import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  type GraphEdge,
  type GraphNode,
  NodeType,
  Provenance,
} from '@neat.is/types'
import { handleSpan, type IngestContext } from '../../src/ingest.js'
import type { ParsedSpan } from '../../src/otel.js'
import type { NeatGraph } from '../../src/graph.js'

// ADR-087 / file-awareness §2-§3: ingest reads the `code.*` call-site semconv
// that NEAT's injected instrumentation attaches on CLIENT/PRODUCER spans and
// records it as single-evidence on the OBSERVED edge. Sibling #394 makes the
// instrumentation emit those attributes; this suite injects spans carrying
// `code.*` and asserts ingest's behaviour against the existing EdgeEvidence
// shape. Evidence is never fabricated — a span without `code.*` leaves the edge
// evidence-free.

const CALLS_EDGE = `${EdgeType.CALLS}:OBSERVED:service:service-a->service:service-b`
const DB_EDGE = `${EdgeType.CONNECTS_TO}:OBSERVED:service:service-b->database:payments-db`

function newGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode('service:service-a', {
    id: 'service:service-a',
    type: NodeType.ServiceNode,
    name: 'service-a',
    language: 'javascript',
  })
  g.addNode('service:service-b', {
    id: 'service:service-b',
    type: NodeType.ServiceNode,
    name: 'service-b',
    language: 'javascript',
  })
  g.addNode('database:payments-db', {
    id: 'database:payments-db',
    type: NodeType.DatabaseNode,
    name: 'neatdemo',
    engine: 'postgresql',
    engineVersion: '15',
    compatibleDrivers: [],
  })
  return g
}

// Cross-service HTTP CLIENT span from service-a → service-b. `attributes`
// overrides merge over the base so a case can add or omit `code.*`.
function clientHttpSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
  const { attributes, ...rest } = overrides
  return {
    service: 'service-a',
    traceId: 'trace-1',
    spanId: 'span-a',
    name: 'GET /query',
    kind: 3,
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    durationNanos: 0n,
    env: 'unknown',
    attributes: {
      'http.method': 'GET',
      'server.address': 'service-b',
      'server.port': 3001,
      ...attributes,
    },
    statusCode: 0,
    ...rest,
  }
}

// Database CLIENT span from service-b → payments-db.
function dbSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
  const { attributes, ...rest } = overrides
  return {
    service: 'service-b',
    traceId: 'trace-1',
    spanId: 'span-b',
    name: 'pg.query',
    kind: 3,
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    durationNanos: 0n,
    env: 'unknown',
    attributes: {
      'db.system': 'postgresql',
      'db.name': 'neatdemo',
      'server.address': 'payments-db',
      ...attributes,
    },
    dbSystem: 'postgresql',
    dbName: 'neatdemo',
    statusCode: 0,
    ...rest,
  }
}

const CODE_ATTRS = {
  'code.filepath': 'src/handlers/checkout.ts',
  'code.lineno': 42,
  'code.function': 'submitOrder',
}

describe('OBSERVED edge file evidence (ADR-087)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-observed-evidence-'))
    ctx = { graph: newGraph(), errorsPath: path.join(tmpDir, 'errors.ndjson') }
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('records file+line evidence on a CALLS edge from a code.*-bearing span', async () => {
    await handleSpan(ctx, clientHttpSpan({ attributes: CODE_ATTRS }))
    const edge = ctx.graph.getEdgeAttributes(CALLS_EDGE) as GraphEdge
    expect(edge.evidence).toEqual({ file: 'src/handlers/checkout.ts', line: 42 })
  })

  it('records file+line evidence on a CONNECTS_TO edge from a code.*-bearing db span', async () => {
    await handleSpan(ctx, dbSpan({ attributes: CODE_ATTRS }))
    const edge = ctx.graph.getEdgeAttributes(DB_EDGE) as GraphEdge
    expect(edge.evidence).toEqual({ file: 'src/handlers/checkout.ts', line: 42 })
  })

  it('leaves no evidence when the span carries no code.* attributes', async () => {
    await handleSpan(ctx, clientHttpSpan())
    const edge = ctx.graph.getEdgeAttributes(CALLS_EDGE) as GraphEdge
    expect(edge.evidence).toBeUndefined()
  })

  it('never fabricates a line: code.filepath without code.lineno yields file-only evidence', async () => {
    await handleSpan(
      ctx,
      clientHttpSpan({ attributes: { 'code.filepath': 'src/api/router.ts' } }),
    )
    const edge = ctx.graph.getEdgeAttributes(CALLS_EDGE) as GraphEdge
    expect(edge.evidence).toEqual({ file: 'src/api/router.ts' })
    expect(edge.evidence?.line).toBeUndefined()
  })

  it('never fabricates a file: code.lineno without code.filepath yields no evidence', async () => {
    await handleSpan(ctx, clientHttpSpan({ attributes: { 'code.lineno': 99 } }))
    const edge = ctx.graph.getEdgeAttributes(CALLS_EDGE) as GraphEdge
    expect(edge.evidence).toBeUndefined()
  })

  it('leaves the OBSERVED signal fields untouched — evidence is purely additive', async () => {
    await handleSpan(ctx, clientHttpSpan({ attributes: CODE_ATTRS }))
    const edge = ctx.graph.getEdgeAttributes(CALLS_EDGE) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.callCount).toBe(1)
    expect(edge.signal).toEqual({ spanCount: 1, errorCount: 0, lastObservedAgeMs: 0 })
    expect(edge.lastObserved).toBeTruthy()
  })

  it('refreshes evidence to the latest call site when an updating span carries code.*', async () => {
    await handleSpan(ctx, clientHttpSpan({ attributes: CODE_ATTRS }))
    await handleSpan(
      ctx,
      clientHttpSpan({
        spanId: 'span-a2',
        attributes: { 'code.filepath': 'src/handlers/refund.ts', 'code.lineno': 7 },
      }),
    )
    const edge = ctx.graph.getEdgeAttributes(CALLS_EDGE) as GraphEdge
    expect(edge.evidence).toEqual({ file: 'src/handlers/refund.ts', line: 7 })
    // The update path still accumulated the signal — evidence rode alongside it.
    expect(edge.signal?.spanCount).toBe(2)
  })

  it('preserves prior evidence when a later span on the same edge lacks code.*', async () => {
    await handleSpan(ctx, clientHttpSpan({ attributes: CODE_ATTRS }))
    await handleSpan(ctx, clientHttpSpan({ spanId: 'span-a2' }))
    const edge = ctx.graph.getEdgeAttributes(CALLS_EDGE) as GraphEdge
    // The second span carried no call site; the real evidence from the first
    // span is kept rather than clobbered to undefined.
    expect(edge.evidence).toEqual({ file: 'src/handlers/checkout.ts', line: 42 })
    expect(edge.signal?.spanCount).toBe(2)
  })
})
