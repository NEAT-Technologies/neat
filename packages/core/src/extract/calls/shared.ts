import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { EdgeEvidence, ExtractedConfidenceKind } from '@neat.is/types'
import { IGNORED_DIRS, SERVICE_FILE_EXTENSIONS, isPythonVenvDir } from '../shared.js'

export interface SourceFile {
  path: string
  content: string
}

export interface ExternalEndpoint {
  // Stable id of the InfraNode this evidence implies. Format
  // `infra:<kind>:<name>` so the orchestrator can dedupe across services.
  infraId: string
  // Display name on the InfraNode (e.g., "orders" for kafka-topic:orders).
  name: string
  kind: string
  edgeType: 'CALLS' | 'PUBLISHES_TO' | 'CONSUMES_FROM'
  evidence: EdgeEvidence
  // Every distinct call site within this file that produced the endpoint
  // (#396 / ADR-087). Populated only when the same target is called from more
  // than one line; `sites[0]` mirrors `evidence`. Left undefined for the
  // common single-site case so the orchestrator can fall back to `[evidence]`.
  sites?: EdgeEvidence[]
  // Confidence grade per ADR-066 — set by the per-shape detector. The
  // orchestrator (calls/index.ts) writes this onto the EXTRACTED edge and
  // applies the precision floor before adding the edge to the graph.
  confidenceKind: ExtractedConfidenceKind
}

// Append a distinct call site to an endpoint, lazily seeding the `sites` array
// with the primary `evidence` on the first additional site (#396 / ADR-087).
// Distinct means a unique file:line pair, so the same target hit twice on the
// same line collapses to one site. Not named `addX` — that prefix is reserved
// for producer entry points by the static-extraction contract.
export function mergeEndpointSite(ep: ExternalEndpoint, site: EdgeEvidence): void {
  if (!ep.sites) ep.sites = [ep.evidence]
  if (ep.sites.some((s) => s.file === site.file && s.line === site.line)) return
  ep.sites.push(site)
}

export async function walkSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        if (await isPythonVenvDir(full)) continue
        await walk(full)
      } else if (entry.isFile() && SERVICE_FILE_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(full)
      }
    }
  }
  await walk(dir)
  return out
}

export async function loadSourceFiles(dir: string): Promise<SourceFile[]> {
  const paths = await walkSourceFiles(dir)
  const out: SourceFile[] = []
  for (const p of paths) {
    try {
      const content = await fs.readFile(p, 'utf8')
      out.push({ path: p, content })
    } catch {
      // unreadable, skip
    }
  }
  return out
}

// Locate the line of the first occurrence of `needle` in `text`, 1-indexed.
// Falls back to line 1 if the needle isn't found verbatim — better to point at
// the file than to drop the evidence entirely.
export function lineOf(text: string, needle: string): number {
  const idx = text.indexOf(needle)
  if (idx < 0) return 1
  return text.slice(0, idx).split('\n').length
}

// Line (1-indexed) of a known character offset into `text`. Used for the
// second-and-later call sites of a target, where `lineOf`'s first-occurrence
// search would keep pointing back at the first site (#396 / ADR-087).
export function lineAt(text: string, index: number): number {
  if (index < 0) return 1
  return text.slice(0, index).split('\n').length
}

export function snippet(text: string, line: number): string {
  const lines = text.split('\n')
  return (lines[line - 1] ?? '').trim()
}
