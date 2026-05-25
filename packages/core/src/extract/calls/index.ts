import type { EdgeEvidence, GraphEdge, InfraNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  passesExtractedFloor,
} from '@neat.is/types'
import { noteExtractedDropped } from '../errors.js'
import type { NeatGraph } from '../../graph.js'
import {
  isTestPath,
  makeEdgeId,
  maskCommentsInSource,
  type DiscoveredService,
} from '../shared.js'
import { addHttpCallEdges } from './http.js'
import { loadSourceFiles, type ExternalEndpoint } from './shared.js'
import { kafkaEndpointsFromFile } from './kafka.js'
import { redisEndpointsFromFile } from './redis.js'
import { awsEndpointsFromFile } from './aws.js'
import { grpcEndpointsFromFile } from './grpc.js'

export interface CallExtractResult {
  nodesAdded: number
  edgesAdded: number
}

function edgeTypeFromEndpoint(ep: ExternalEndpoint): (typeof EdgeType)[keyof typeof EdgeType] {
  switch (ep.edgeType) {
    case 'PUBLISHES_TO':
      return EdgeType.PUBLISHES_TO
    case 'CONSUMES_FROM':
      return EdgeType.CONSUMES_FROM
    default:
      return EdgeType.CALLS
  }
}

function isAwsKind(kind: string): boolean {
  return (
    kind.startsWith('aws-') ||
    kind.startsWith('s3') ||
    kind.startsWith('dynamodb')
  )
}

async function addExternalEndpointEdges(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<CallExtractResult> {
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    const files = await loadSourceFiles(service.dir)
    const endpoints: ExternalEndpoint[] = []
    for (const file of files) {
      // ADR-065 #1 — test-scope exclusion. Tests stay registered as
      // service-internal (via the file walk earlier); only outbound
      // endpoint inference from them is filtered.
      if (isTestPath(file.path)) continue
      // ADR-065 #2 — comment-body exclusion. The regex-based extractors
      // (redis / kafka / aws / grpc) scan raw file.content; URLs inside
      // JSDoc / line / block comments leaked through to the graph in the
      // v0.3.0 medusa run. Mask comments while preserving line/column for
      // evidence line-mapping.
      const masked = maskCommentsInSource(file.content)
      const maskedFile = { path: file.path, content: masked }
      endpoints.push(...kafkaEndpointsFromFile(maskedFile, service.dir))
      endpoints.push(...redisEndpointsFromFile(maskedFile, service.dir))
      endpoints.push(...awsEndpointsFromFile(maskedFile, service.dir))
      endpoints.push(...grpcEndpointsFromFile(maskedFile, service.dir))
    }
    if (endpoints.length === 0) continue

    // Group every endpoint by the edge it implies, keeping each distinct
    // (file, line) call site instead of the first-write-wins collapse that
    // used to drop the rest (ADR-087 / #396). The same target called from
    // several files produces several endpoints; they all belong to one edge
    // and each contributes a call site. `rep` is the first site seen, which
    // keeps the representative `evidence.file`/`line` byte-identical to the
    // pre-#396 behaviour (retire.ts keys ghost-edge cleanup on it).
    interface EdgeAgg {
      ep: ExternalEndpoint
      edgeType: (typeof EdgeType)[keyof typeof EdgeType]
      sites: EdgeEvidence[]
      siteKeys: Set<string>
    }
    const byEdge = new Map<string, EdgeAgg>()
    for (const ep of endpoints) {
      if (!graph.hasNode(ep.infraId)) {
        const node: InfraNode = {
          id: ep.infraId,
          type: NodeType.InfraNode,
          name: ep.name,
          // #238 — `aws-*` covers AWS-SDK client kinds (aws-s3, aws-dynamodb,
          // aws-cognito-identity-provider, …); `s3-` / `dynamodb-` cover the
          // bucket / table kinds from aws.ts.
          provider: isAwsKind(ep.kind) ? 'aws' : 'self',
          kind: ep.kind,
        }
        graph.addNode(node.id, node)
        nodesAdded++
      }

      const edgeType = edgeTypeFromEndpoint(ep)
      const edgeId = makeEdgeId(service.node.id, ep.infraId, edgeType)
      let agg = byEdge.get(edgeId)
      if (!agg) {
        agg = { ep, edgeType, sites: [], siteKeys: new Set() }
        byEdge.set(edgeId, agg)
      }
      const key = `${ep.evidence.file}|${ep.evidence.line ?? ''}`
      if (!agg.siteKeys.has(key)) {
        agg.siteKeys.add(key)
        agg.sites.push(ep.evidence)
      }
    }

    for (const [edgeId, agg] of byEdge) {
      const confidence = confidenceForExtracted(agg.ep.confidenceKind)
      const rep = agg.sites[0]!
      // Precision floor (ADR-066 §3). Sub-threshold candidates are computed
      // but never added to the graph; the banner reports the drop count.
      if (!passesExtractedFloor(confidence)) {
        noteExtractedDropped({
          source: service.node.id,
          target: agg.ep.infraId,
          type: agg.edgeType,
          confidence,
          confidenceKind: agg.ep.confidenceKind,
          evidence: rep,
        })
        continue
      }
      if (!graph.hasEdge(edgeId)) {
        // `sites` only when more than one origin backs the edge — a
        // single-site edge stays exactly as it was before #396 (no `sites`
        // field), so existing snapshots and #395's writes are unaffected.
        const evidence: EdgeEvidence =
          agg.sites.length > 1 ? { ...rep, sites: agg.sites } : rep
        const edge: GraphEdge = {
          id: edgeId,
          source: service.node.id,
          target: agg.ep.infraId,
          type: agg.edgeType,
          provenance: Provenance.EXTRACTED,
          confidence,
          evidence,
        }
        graph.addEdgeWithKey(edgeId, edge.source, edge.target, edge)
        edgesAdded++
      }
    }
  }
  return { nodesAdded, edgesAdded }
}

export async function addCallEdges(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<CallExtractResult> {
  const httpEdges = await addHttpCallEdges(graph, services)
  const ext = await addExternalEndpointEdges(graph, services)
  return {
    nodesAdded: ext.nodesAdded,
    edgesAdded: httpEdges + ext.edgesAdded,
  }
}
