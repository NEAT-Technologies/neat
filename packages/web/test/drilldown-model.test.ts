import { describe, it, expect } from 'vitest'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import {
  buildModel,
  visibleGraph,
  filesOf,
  callsFrom,
  importsFrom,
} from '../app/components/graph-model'

// A small file-first graph (file-awareness.md §1-§3):
//   service:a CONTAINS file:a/x, file:a/y
//   service:b CONTAINS file:b/z
//   file:a/x CALLS file:b/z       (runtime — file-grained, with evidence)
//   file:a/x IMPORTS file:a/y     (static module dependency, ADR-092 §10)
//   file:a/y CONNECTS_TO database:d (declared, not a runtime call)
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
  { id: 'imp1', source: 'file:a:x.ts', target: 'file:a:y.ts', type: 'IMPORTS', provenance: 'EXTRACTED', confidence: 1, evidence: { file: 'src/x.ts', line: 1, snippet: "import { y } from './y'" } } as GraphEdge,
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

  it('ServiceNodes are never shown — only FileNodes and resource nodes (file-awareness §3)', () => {
    // file-awareness §3: service is a namespace, not a canvas entity.
    // Only FileNodes, DatabaseNodes, ConfigNodes, InfraNodes, FrontierNodes appear.
    const vis = visibleGraph(nodes, edges, model, new Set())
    const ids = vis.nodes.map((n) => n.id)
    expect(ids).not.toContain('service:a')
    expect(ids).not.toContain('service:b')
    // files and resource nodes are always visible
    expect(ids).toContain('file:a:x.ts')
    expect(ids).toContain('file:b:z.ts')
    expect(ids).toContain('database:d')
  })

  it('never renders CONTAINS as a graph edge — containment is visibility, not an arrow', () => {
    const vis = visibleGraph(nodes, edges, model, new Set(['service:a', 'service:b']))
    expect(vis.edges.some((e) => e.type === 'CONTAINS')).toBe(false)
  })

  it('edges always use their real file-grained endpoints — no re-anchoring onto service containers (file-awareness §3)', () => {
    // file-awareness §3: file edges are never collapsed into service edges.
    // The edge from file:a:x.ts to file:b:z.ts must keep its real endpoints
    // regardless of any expanded state passed in.
    const vis = visibleGraph(nodes, edges, model, new Set())
    const call = vis.edges.find((e) => e.id === 'call1')
    expect(call).toBeTruthy()
    expect(call!.source).toBe('file:a:x.ts')
    expect(call!.target).toBe('file:b:z.ts')
    expect(call!.type).toBe('CALLS')
    expect(call!.provenance).toBe('OBSERVED')
  })

  it('intra-service file edges are always drawn between the two files (file-awareness §3)', () => {
    // file:a:x → file:a:y is a legitimate file-grained call within service:a.
    // It is never dropped or rolled up — both files are visible, both endpoints are real.
    const intra: GraphEdge[] = [
      ...edges,
      { id: 'call2', source: 'file:a:x.ts', target: 'file:a:y.ts', type: 'CALLS', provenance: 'OBSERVED' } as GraphEdge,
    ]
    const m = buildModel(nodes, intra)
    const vis = visibleGraph(nodes, intra, m, new Set())
    const e = vis.edges.find((x) => x.id === 'call2')
    expect(e).toBeTruthy()
    expect(e!.source).toBe('file:a:x.ts')
    expect(e!.target).toBe('file:a:y.ts')
  })

  it('filesOf returns the files a service CONTAINS (for the Inspector service view)', () => {
    const files = filesOf('service:a', model).map((f) => f.id)
    expect(files).toEqual(['file:a:x.ts', 'file:a:y.ts'])
  })

  it('callsFrom returns only runtime-call edges, never IMPORTS or CONNECTS_TO (file-awareness §10)', () => {
    const calls = callsFrom('file:a:x.ts', edges, model.byId)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      targetId: 'file:b:z.ts',
      provenance: 'OBSERVED',
      confidence: 0.9,
      evidenceFile: 'src/x.ts',
      evidenceLine: 42,
    })
    // The IMPORTS edge from the same file must never surface as a "call" —
    // that's the #456 bug (static module imports mislabeled as runtime calls).
    expect(calls.some((c) => c.targetId === 'file:a:y.ts')).toBe(false)
    // CONNECTS_TO is a declared relationship, not a runtime call — excluded.
    expect(callsFrom('file:a:y.ts', edges, model.byId)).toHaveLength(0)
    // CONTAINS is structural ownership, not a call — excluded.
    expect(callsFrom('service:a', edges, model.byId)).toHaveLength(0)
  })

  it('importsFrom returns file-grained IMPORTS edges with provenance + file:line evidence, never CALLS (file-awareness §10)', () => {
    const imports = importsFrom('file:a:x.ts', edges, model.byId)
    expect(imports).toHaveLength(1)
    expect(imports[0]).toMatchObject({
      targetId: 'file:a:y.ts',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidenceFile: 'src/x.ts',
      evidenceLine: 1,
    })
    // The CALLS edge from the same file must never surface as an "import".
    expect(imports.some((i) => i.targetId === 'file:b:z.ts')).toBe(false)
    // No outbound IMPORTS edge from file:a:y.ts — empty, not absent.
    expect(importsFrom('file:a:y.ts', edges, model.byId)).toHaveLength(0)
  })
})
