import { existsSync } from 'node:fs'
import path from 'node:path'
import type { GraphEdge } from '@neat.is/types'
import { Provenance } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'

// Every file an EXTRACTED edge is backed by: the representative `evidence.file`
// plus each call site in `evidence.sites` (ADR-087 / #396). A single-site edge
// carries no `sites`, so this returns just the representative — identical to
// the pre-#396 behaviour. A multi-site edge returns one entry per distinct
// backing file.
function evidenceFiles(edge: GraphEdge): string[] {
  const files: string[] = []
  const push = (f: string | undefined): void => {
    if (f && !files.includes(f)) files.push(f)
  }
  push(edge.evidence?.file)
  for (const site of edge.evidence?.sites ?? []) push(site.file)
  return files
}

// Drop every EXTRACTED edge that is backed by the given path — its
// representative `evidence.file` or any call site in `evidence.sites`. Called
// from watch.ts before re-running an extract phase, so the producer's
// idempotent re-write recreates only the edges that still apply (with their
// surviving call sites). Edges from the deleted code stay deleted. Matching on
// any backing site means a change to one file of a multi-site edge re-derives
// the whole edge rather than leaving a stale site behind. See
// docs/contracts/static-extraction.md §Ghost-edge cleanup. Mutation authority
// lives under extract/* per ADR-030, so the dropEdge call must happen here,
// not in watch.ts.
export function retireEdgesByFile(graph: NeatGraph, file: string): number {
  const normalized = file.split('\\').join('/')
  const toDrop: string[] = []
  graph.forEachEdge((id, attrs) => {
    const edge = attrs as GraphEdge
    if (edge.provenance !== Provenance.EXTRACTED) return
    if (evidenceFiles(edge).includes(normalized)) toDrop.push(id)
  })
  for (const id of toDrop) graph.dropEdge(id)
  return toDrop.length
}

// #140 — full-pass cleanup. Walk every EXTRACTED edge in the graph; if its
// `evidence.file` cannot be resolved on disk against the scan root or any
// discovered service directory, drop it. extractFromDirectory calls this at
// the end of every pass so a daemon bootstrap (or a re-init after the
// operator deleted some source) gets a snapshot consistent with what's
// actually on disk.
//
// Handles the deleted-file half of the ghost-edge bug. The edited-file half
// (file still exists, producer no longer emits the edge) is handled by
// watch.ts's per-file `retireEdgesByFile` on the mtime trigger.
//
// Path resolution is tolerant: producers in this tree are inconsistent about
// whether `evidence.file` is scanPath-relative (configs, databases, infra)
// or service-dir-relative (calls/*). We try every candidate base before
// concluding the file is gone — the cost is one extra `existsSync` per
// service dir per ghost candidate, which is cheap.
export function retireExtractedEdgesByMissingFile(
  graph: NeatGraph,
  scanPath: string,
  serviceDirs: readonly string[] = [],
): number {
  const toDrop: string[] = []
  const bases = [scanPath, ...serviceDirs]
  const resolves = (file: string): boolean => {
    if (path.isAbsolute(file)) return existsSync(file)
    // Tolerant: the file is "present" if any base resolves it.
    return bases.some((base) => existsSync(path.join(base, file)))
  }
  graph.forEachEdge((id, attrs) => {
    const edge = attrs as GraphEdge
    if (edge.provenance !== Provenance.EXTRACTED) return
    const files = evidenceFiles(edge)
    if (files.length === 0) return
    // A multi-site edge survives as long as one backing file is still on
    // disk; only drop when every call site has vanished.
    if (!files.some(resolves)) toDrop.push(id)
  })
  for (const id of toDrop) graph.dropEdge(id)
  return toDrop.length
}
