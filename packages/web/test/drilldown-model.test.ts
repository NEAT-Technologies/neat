import { describe, it, expect } from 'vitest'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import {
  buildModel,
  visibleGraph,
  filesOf,
  callsFrom,
} from '../app/components/graph-model'

// A small file-first graph (file-awareness.md §1-§3):
//   service:a CONTAINS file:a/x, file:a/y
//   service:b CONTAINS file:b/z
//   file:a/x CALLS file:b/z   (file-grained, with evidence)
//   file:a/y CONNECTS_TO database:d
const nodes: GraphNode[] = [
  { id: 'service:a', type: 'ServiceNode', name: 'a', language: 'ts' } as GraphNode,
  { id: 'service:b', type: 'ServiceNode', name: 'b', language: 'ts' } as GraphNode,
  { id: 'file:a:x.ts', type: 'FileNode', service: 'a', path: 'src/x.ts' } as GraphNode,
  { id: 'file:a:y.ts', type: 'FileNode', service: 'a', path: 'src/y.ts' } as GraphNode,
  { id: 'file:b:z.ts', type: 'FileNode', service: 'b', path: 'src/z.ts' } as GraphNode,
  { id: 'database:d', type: 'DatabaseNode', name: 'd', engine: 'pg', engineVersion: '15', compatibleDrivers: [] } as GraphNode,
]
const edges: GraphEdge[] = [
  { id: 'c1', source: 'service:a', target: 'file:a:x.ts', type: 'CONTAINS', provenance: 'EXTRACTED' } as GraphEdge,
  { id: 'c2', source: 'service:a', target: 'file:a:y.ts', type: 'CONTAINS', provenance: 'EXTRACTED' } as GraphEdge,
  { id: 'c3', source: 'service:b', target: 'file:b:z.ts', type: 'CONTAINS', provenance: 'EXTRACTED' } as GraphEdge,
  { id: 'call1', source: 'file:a:x.ts', target: 'file:b:z.ts', type: 'CALLS', provenance: 'OBSERVED', confidence: 0.9, evidence: { file: 'src/x.ts', line: 42 } } as GraphEdge,
  { id: 'conn1', source: 'file:a:y.ts', target: 'database:d', type: 'CONNECTS_TO', provenance: 'EXTRACTED', confidence: 0.8, evidence: { file: 'src/y.ts', line: 7 } } as GraphEdge,
]

describe('file-first drill-down model (file-awareness §2/§3)', () => {
  const model = buildModel(nodes, edges)

  it('indexes service↔file containment from CONTAINS edges (§2)', () => {
    expect(model.filesByService.get('service:a')).toEqual(['file:a:x.ts', 'file:a:y.ts'])
    expect(model.filesByService.get('service:b')).toEqual(['file:b:z.ts'])
    expect(model.serviceByFile.get('file:a:x.ts')).toBe('service:a')
    expect(model.serviceByFile.get('file:b:z.ts')).toBe('service:b')
  })

  it('top view (no expansion) hides files and shows services as containers', () => {
    const vis = visibleGraph(nodes, edges, model, new Set())
    const ids = vis.nodes.map((n) => n.id)
    expect(ids).toContain('service:a')
    expect(ids).toContain('service:b')
    expect(ids).toContain('database:d')
    // files are hidden until their service is opened
    expect(ids).not.toContain('file:a:x.ts')
    expect(ids).not.toContain('file:b:z.ts')
  })

  it('never renders CONTAINS as a graph edge — containment is visibility, not an arrow', () => {
    const vis = visibleGraph(nodes, edges, model, new Set(['service:a', 'service:b']))
    expect(vis.edges.some((e) => e.type === 'CONTAINS')).toBe(false)
  })

  it('a hidden file re-anchors its edge onto its collapsed-service container, never a service→service summary', () => {
    // expand only service:a; file:b:z.ts stays hidden under collapsed service:b.
    const vis = visibleGraph(nodes, edges, model, new Set(['service:a']))
    const ids = vis.nodes.map((n) => n.id)
    expect(ids).toContain('file:a:x.ts') // a's files revealed
    expect(ids).not.toContain('file:b:z.ts') // b still collapsed

    // the file:a:x.ts → file:b:z.ts CALLS edge renders file-grained on the
    // source side and re-anchors the hidden target onto service:b — but it is
    // still the same CALLS edge with its provenance, not a new service edge.
    const call = vis.edges.find((e) => e.id === 'call1')
    expect(call).toBeTruthy()
    expect(call!.source).toBe('file:a:x.ts')
    expect(call!.target).toBe('service:b')
    expect(call!.type).toBe('CALLS')
    expect(call!.provenance).toBe('OBSERVED')
    // provenance proof that we didn't fabricate a service→service rollup
    expect(call!._origSource).toBe('file:a:x.ts')
    expect(call!._origTarget).toBe('file:b:z.ts')
  })

  it('drops an edge that would collapse to a self-loop between two files in the same collapsed service (no service→service edge)', () => {
    // an intra-service call: file:a:x → file:a:y, both under service:a.
    const intra: GraphEdge[] = [
      ...edges,
      { id: 'call2', source: 'file:a:x.ts', target: 'file:a:y.ts', type: 'CALLS', provenance: 'OBSERVED' } as GraphEdge,
    ]
    const m = buildModel(nodes, intra)
    // collapsed: both endpoints → service:a → would be a self-loop, dropped.
    const collapsed = visibleGraph(nodes, intra, m, new Set())
    expect(collapsed.edges.some((e) => e.id === 'call2')).toBe(false)
    // expanded: the file-grained edge is drawn between the two files.
    const expanded = visibleGraph(nodes, intra, m, new Set(['service:a']))
    const e = expanded.edges.find((x) => x.id === 'call2')
    expect(e?.source).toBe('file:a:x.ts')
    expect(e?.target).toBe('file:a:y.ts')
  })

  it('filesOf returns the files a service CONTAINS (for the Inspector service view)', () => {
    const files = filesOf('service:a', model).map((f) => f.id)
    expect(files).toEqual(['file:a:x.ts', 'file:a:y.ts'])
  })

  it('callsFrom returns file-grained originating calls with provenance + file:line evidence (§1/§6)', () => {
    const calls = callsFrom('file:a:x.ts', edges, model.byId)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      targetId: 'file:b:z.ts',
      provenance: 'OBSERVED',
      confidence: 0.9,
      evidenceFile: 'src/x.ts',
      evidenceLine: 42,
    })
    // CONTAINS is structural ownership, not a call — excluded.
    const svcCalls = callsFrom('service:a', edges, model.byId)
    expect(svcCalls).toHaveLength(0)
  })
})
