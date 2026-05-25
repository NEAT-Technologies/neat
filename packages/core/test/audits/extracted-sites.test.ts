/**
 * #396 / ADR-087 — EXTRACTED edges keep every distinct call site.
 *
 * Before this, the call extractors collapsed a multi-call-site relationship to
 * the first site per target (`http.ts` `seenTargets`, the per-file `seen` sets
 * in kafka/redis/aws/grpc, the cross-file `seenEdges` in calls/index.ts, and
 * the host merge in databases/index.ts all dropped later sites). Now each edge
 * keeps a `sites` array of every distinct site, with `evidence` (and
 * `sites[0]`) staying the first/primary site so single-evidence consumers and
 * retire.ts are unaffected.
 *
 * The contract: a multi-call-site edge retains all sites; a single-site edge
 * carries no `sites` key (byte-identical to the prior shape); identity and
 * retirement still key on `evidence.file`.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import { extractedEdgeId } from '@neat.is/types'
import type { NeatGraph } from '../../src/graph.js'
import { extractFromDirectory } from '../../src/extract.js'
import { kafkaEndpointsFromFile } from '../../src/extract/calls/kafka.js'
import { redisEndpointsFromFile } from '../../src/extract/calls/redis.js'
import { awsEndpointsFromFile } from '../../src/extract/calls/aws.js'
import { grpcEndpointsFromFile } from '../../src/extract/calls/grpc.js'
import type { SourceFile } from '../../src/extract/calls/shared.js'

const SVC = '/svc'
const file = (content: string): SourceFile => ({ path: path.join(SVC, 'index.js'), content })

describe('#396 — per-file extractors keep distinct call sites', () => {
  it('kafka: the same topic published twice keeps both sites', () => {
    const eps = kafkaEndpointsFromFile(
      file(
        [
          "const producer = kafka.producer()",
          "producer.send({ topic: 'orders', messages: [] })",
          "// later, somewhere else in the file",
          "producer.send({ topic: 'orders', messages: [] })",
        ].join('\n'),
      ),
      SVC,
    )
    expect(eps).toHaveLength(1)
    const ep = eps[0]!
    expect(ep.infraId).toBe('infra:kafka-topic:orders')
    expect(ep.sites).toBeDefined()
    expect(ep.sites).toHaveLength(2)
    // sites[0] mirrors the primary evidence.
    expect(ep.sites![0]).toEqual(ep.evidence)
    // Two distinct lines, both pointing at the same file.
    expect(ep.sites![0]!.line).not.toBe(ep.sites![1]!.line)
    expect(ep.sites!.every((s) => s.file === 'index.js')).toBe(true)
  })

  it('kafka: a single publish carries no sites array', () => {
    const eps = kafkaEndpointsFromFile(
      file("const producer = kafka.producer()\nproducer.send({ topic: 'orders' })"),
      SVC,
    )
    expect(eps).toHaveLength(1)
    expect(eps[0]!.sites).toBeUndefined()
    expect(eps[0]!.evidence.file).toBe('index.js')
  })

  it('redis: two redis:// literals for one host keep both sites', () => {
    const eps = redisEndpointsFromFile(
      file(
        [
          "const a = createClient({ url: 'redis://cache.internal:6379' })",
          "const b = createClient({ url: 'redis://cache.internal:6379' })",
        ].join('\n'),
      ),
      SVC,
    )
    expect(eps).toHaveLength(1)
    expect(eps[0]!.infraId).toBe('infra:redis:cache.internal')
    expect(eps[0]!.sites).toHaveLength(2)
    expect(eps[0]!.sites![0]).toEqual(eps[0]!.evidence)
    expect(eps[0]!.sites![0]!.line).not.toBe(eps[0]!.sites![1]!.line)
  })

  it('aws: one bucket referenced twice keeps both sites', () => {
    const eps = awsEndpointsFromFile(
      file(
        [
          "const s3 = new S3Client({})",
          "await s3.send(new PutObjectCommand({ Bucket: 'invoices', Key: 'a' }))",
          "await s3.send(new GetObjectCommand({ Bucket: 'invoices', Key: 'b' }))",
        ].join('\n'),
      ),
      SVC,
    )
    const bucket = eps.find((e) => e.infraId === 'infra:s3-bucket:invoices')
    expect(bucket).toBeDefined()
    expect(bucket!.sites).toHaveLength(2)
    expect(bucket!.sites![0]).toEqual(bucket!.evidence)
  })

  it('grpc: one client constructed twice keeps both sites', () => {
    const eps = grpcEndpointsFromFile(
      file(
        [
          "const grpc = require('@grpc/grpc-js')",
          "const a = new OrderServiceClient('orders.internal:50051')",
          "const b = new OrderServiceClient('orders.internal:50051')",
        ].join('\n'),
      ),
      SVC,
    )
    expect(eps).toHaveLength(1)
    expect(eps[0]!.kind).toBe('grpc-service')
    expect(eps[0]!.sites).toHaveLength(2)
    expect(eps[0]!.sites![0]).toEqual(eps[0]!.evidence)
  })
})

function newGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}

async function writeFile(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
}

describe('#396 — extraction aggregates distinct sites across files', () => {
  let tmp: string
  // hostname-shape (http) and url-with-structural-support (redis) edges sit
  // below the default precision floor; drop it so this test exercises full
  // recall, matching calls.test.ts.
  let prevFloor: string | undefined

  beforeAll(() => {
    prevFloor = process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    process.env.NEAT_EXTRACTED_PRECISION_FLOOR = '0'
  })
  afterAll(() => {
    if (prevFloor === undefined) delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    else process.env.NEAT_EXTRACTED_PRECISION_FLOOR = prevFloor
  })

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-sites-'))
  })
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('http: a target called from two files keeps a site per file', async () => {
    await writeFile(tmp, 'alpha/package.json', JSON.stringify({ name: 'fixture-alpha-sites' }))
    await writeFile(tmp, 'alpha/a.js', "fetch('http://beta/orders')\n")
    await writeFile(tmp, 'alpha/b.js', "fetch('http://beta/refunds')\n")
    await writeFile(tmp, 'beta/package.json', JSON.stringify({ name: 'fixture-beta-sites' }))
    await writeFile(tmp, 'beta/index.js', 'module.exports = {}\n')

    const graph = newGraph()
    await extractFromDirectory(graph, tmp)

    const edgeId = extractedEdgeId('service:fixture-alpha-sites', 'service:fixture-beta-sites', 'CALLS')
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.sites).toBeDefined()
    expect(edge.sites!.map((s) => s.file).sort()).toEqual(['a.js', 'b.js'])
    // Primary evidence stays the first site.
    expect(edge.sites![0]).toEqual(edge.evidence)
  })

  it('kafka: a topic published from two files aggregates into one edge with both sites', async () => {
    await writeFile(tmp, 'pkg/package.json', JSON.stringify({ name: 'fixture-kafka-sites' }))
    await writeFile(
      tmp,
      'pkg/publish-a.js',
      "const producer = kafka.producer()\nproducer.send({ topic: 'orders' })\n",
    )
    await writeFile(
      tmp,
      'pkg/publish-b.js',
      "const producer = kafka.producer()\nproducer.send({ topic: 'orders' })\n",
    )

    const graph = newGraph()
    await extractFromDirectory(graph, tmp)

    const edgeId = extractedEdgeId(
      'service:fixture-kafka-sites',
      'infra:kafka-topic:orders',
      'PUBLISHES_TO',
    )
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.sites).toBeDefined()
    expect(edge.sites!.map((s) => s.file).sort()).toEqual(['publish-a.js', 'publish-b.js'])
    expect(edge.sites![0]).toEqual(edge.evidence)
  })

  it('db: a host declared in two config files keeps a CONNECTS_TO site per file', async () => {
    await writeFile(tmp, 'pkg/package.json', JSON.stringify({ name: 'fixture-db-sites' }))
    await writeFile(tmp, 'pkg/.env', 'DATABASE_URL=postgres://pgdb:5432/app\n')
    await writeFile(
      tmp,
      'pkg/ormconfig.json',
      JSON.stringify({ type: 'postgres', host: 'pgdb', database: 'app' }),
    )

    const graph = newGraph()
    await extractFromDirectory(graph, tmp)

    const edgeId = extractedEdgeId('service:fixture-db-sites', 'database:pgdb', 'CONNECTS_TO')
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.sites).toBeDefined()
    expect(edge.sites!.map((s) => s.file).sort()).toEqual(['pkg/.env', 'pkg/ormconfig.json'])
    // Identity / retirement still key on evidence.file, which mirrors sites[0].
    expect(edge.sites![0]).toEqual(edge.evidence)
    expect(edge.evidence!.file).toBe('pkg/.env')
  })

  it('single-site edge carries no sites key (back-compat with single-evidence consumers)', async () => {
    await writeFile(tmp, 'pkg/package.json', JSON.stringify({ name: 'fixture-single-site' }))
    await writeFile(
      tmp,
      'pkg/index.js',
      "const producer = kafka.producer()\nproducer.send({ topic: 'orders' })\n",
    )

    const graph = newGraph()
    await extractFromDirectory(graph, tmp)

    const edgeId = extractedEdgeId(
      'service:fixture-single-site',
      'infra:kafka-topic:orders',
      'PUBLISHES_TO',
    )
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.sites).toBeUndefined()
    expect(edge.evidence?.file).toBe('index.js')
  })
})
