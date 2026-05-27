// File-first graph model for the dashboard's level-of-detail drill-down.
//
// The graph is file-first (file-awareness.md §1-§3): FileNodes are primary,
// CALLS edges originate from files, and `service ──CONTAINS──▶ file` is the
// only place a service appears in relation to its files. Drill-down navigates
// *by the grouping* — it never rolls file edges up into service edges and
// never shows a service-level edge view (§3). A service is a container you
// open, not an aggregation.
//
// Level-of-detail:
//   - collapsed (default): each service shows as one collapsed container;
//     its files are hidden so the canvas isn't a flat file hairball.
//   - expanded (drilled): the focused service's FileNodes are revealed via
//     its CONTAINS edges; files outside the focus stay collapsed under their
//     own service container.
//
// Rendered edges are always file-grained. When a file is hidden inside a
// collapsed service, an edge that originates from (or lands on) that file is
// re-anchored onto the visible service *container* so the relationship still
// reads — but it stays the same file-grained edge with its own provenance and
// evidence; we never synthesize a service→service summary edge.

import type { GraphNode, GraphEdge } from '@neat.is/types'

export const CONTAINS = 'CONTAINS'

export interface FileFirstModel {
  /** every node by id */
  byId: Map<string, GraphNode>
  /** service id → file node ids it CONTAINS */
  filesByService: Map<string, string[]>
  /** file id → owning service id (from the inbound CONTAINS edge) */
  serviceByFile: Map<string, string>
  /** service ids present in the graph */
  serviceIds: string[]
  /** file ids present in the graph */
  fileIds: string[]
}

export function isFileNode(node: GraphNode | undefined): boolean {
  return node?.type === 'FileNode'
}

export function isServiceNode(node: GraphNode | undefined): boolean {
  return node?.type === 'ServiceNode'
}

// Build the service↔file containment index from CONTAINS edges. CONTAINS is
// the structural ownership edge (service → file); we read it rather than the
// FileNode.service string so the model matches the graph the daemon actually
// shipped.
export function buildModel(nodes: GraphNode[], edges: GraphEdge[]): FileFirstModel {
  const byId = new Map<string, GraphNode>()
  for (const n of nodes) byId.set(n.id, n)

  const filesByService = new Map<string, string[]>()
  const serviceByFile = new Map<string, string>()

  for (const e of edges) {
    if (e.type !== CONTAINS) continue
    const svc = byId.get(e.source)
    const file = byId.get(e.target)
    if (!isServiceNode(svc) || !isFileNode(file)) continue
    const list = filesByService.get(e.source) ?? []
    list.push(e.target)
    filesByService.set(e.source, list)
    serviceByFile.set(e.target, e.source)
  }

  const serviceIds: string[] = []
  const fileIds: string[] = []
  for (const n of nodes) {
    if (n.type === 'ServiceNode') serviceIds.push(n.id)
    else if (n.type === 'FileNode') fileIds.push(n.id)
  }

  return { byId, filesByService, serviceByFile, serviceIds, fileIds }
}

export interface VisibleGraph {
  nodes: GraphNode[]
  // edges re-anchored onto whatever node currently represents each endpoint,
  // carrying the original edge id so selection + evidence still resolve.
  edges: (GraphEdge & { _origSource: string; _origTarget: string })[]
}

// Given the model and the set of *expanded* service ids, resolve which node id
// currently represents a given node: a file inside a collapsed service is
// represented by that service container; everything else is itself.
function representativeOf(id: string, model: FileFirstModel, expanded: Set<string>): string {
  const svc = model.serviceByFile.get(id)
  if (svc && !expanded.has(svc)) return svc
  return id
}

// Compute the visible node + edge set for the current drill state.
//
//   expanded — service ids the user has drilled into. Empty = top view
//   (all services collapsed). A service container is always shown; its files
//   appear only when it's expanded.
//
// CONTAINS edges are never rendered as graph edges — containment is expressed
// by visibility (open the container to see its files), not by an arrow.
export function visibleGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  model: FileFirstModel,
  expanded: Set<string>,
): VisibleGraph {
  const visibleNodes: GraphNode[] = []
  const shown = new Set<string>()

  for (const n of nodes) {
    if (n.type === 'FileNode') {
      // file is visible only inside an expanded service
      const svc = model.serviceByFile.get(n.id)
      if (svc && !expanded.has(svc)) continue
      // an orphan file (no CONTAINS) is always shown — honest fallback
    }
    visibleNodes.push(n)
    shown.add(n.id)
  }

  const out: VisibleGraph['edges'] = []
  const seen = new Set<string>()

  for (const e of edges) {
    if (e.type === CONTAINS) continue // containment is visibility, not an arrow

    const src = representativeOf(e.source, model, expanded)
    const tgt = representativeOf(e.target, model, expanded)

    // both endpoints must resolve to a currently-visible node
    if (!shown.has(src) || !shown.has(tgt)) continue
    // drop self-loops produced when both endpoints collapse to the same
    // service container — that would read as a service→service edge, which
    // §3 forbids. The relationship stays a file-grained edge; it's simply not
    // drawn while both its files are hidden in the same container.
    if (src === tgt) continue

    // de-dup edges that re-anchor onto the same visible pair (multiple files
    // in one collapsed service calling the same target). Keep the first;
    // the file-grained detail stays available in the Inspector.
    const key = `${e.type}:${src}->${tgt}:${e.provenance}`
    if (seen.has(key)) continue
    seen.add(key)

    out.push({ ...e, source: src, target: tgt, _origSource: e.source, _origTarget: e.target })
  }

  return { nodes: visibleNodes, edges: out }
}

// Files a service CONTAINS, resolved to nodes (for the Inspector's service view).
export function filesOf(serviceId: string, model: FileFirstModel): GraphNode[] {
  const ids = model.filesByService.get(serviceId) ?? []
  return ids.map((id) => model.byId.get(id)).filter((n): n is GraphNode => !!n)
}

// The calls originating from a file (file-grained CALLS edges), with evidence.
export interface OriginatingCall {
  edgeId: string
  targetId: string
  targetName: string
  provenance: string
  confidence?: number
  evidenceFile?: string
  evidenceLine?: number
}

export function callsFrom(fileId: string, edges: GraphEdge[], byId: Map<string, GraphNode>): OriginatingCall[] {
  const calls: OriginatingCall[] = []
  for (const e of edges) {
    if (e.source !== fileId) continue
    if (e.type === CONTAINS) continue
    const target = byId.get(e.target)
    const name = target ? ((target as { name?: string; path?: string }).name ?? (target as { path?: string }).path ?? e.target) : e.target
    calls.push({
      edgeId: e.id,
      targetId: e.target,
      targetName: name,
      provenance: e.provenance,
      confidence: e.confidence,
      evidenceFile: e.evidence?.file,
      evidenceLine: e.evidence?.line,
    })
  }
  return calls
}
