import { z } from 'zod'
import { EdgeType, Provenance } from './constants.js'

export const ProvenanceSchema = z.enum([
  Provenance.EXTRACTED,
  Provenance.INFERRED,
  Provenance.OBSERVED,
  Provenance.STALE,
])

export const EdgeTypeSchema = z.enum([
  EdgeType.CALLS,
  EdgeType.DEPENDS_ON,
  EdgeType.CONNECTS_TO,
  EdgeType.CONFIGURED_BY,
  EdgeType.PUBLISHES_TO,
  EdgeType.CONSUMES_FROM,
  EdgeType.RUNS_ON,
])

// One call-site origin for an EXTRACTED edge: file, plus optional line and
// source snippet. Same shape as the representative evidence fields below —
// `EdgeEvidence.sites` carries the full set when an edge is backed by more
// than one call site (ADR-087 / #396).
export const CallSiteSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative().optional(),
  snippet: z.string().optional(),
})
export type CallSite = z.infer<typeof CallSiteSchema>

// Static-extraction evidence for an EXTRACTED edge (ADR-029, contract #5).
// `file` is required — retire.ts keys ghost-edge cleanup off it. `line` and
// `snippet` are optional because the existing extractors (configs.ts,
// docker-compose.ts) record file-level evidence only; loosening lets those
// edges through ADR-061's response-shape validation without forcing the
// extractors to fabricate line numbers.
//
// ADR-087 / #396 — file-grain. A single EXTRACTED edge can be born from more
// than one call site (the same target called from several files, or several
// lines in one file). The CALLS-family producers used to keep the first site
// and drop the rest; `sites` now carries every distinct origin.
// `file`/`line`/`snippet` stay as the representative (first) site so
// single-evidence consumers keep working: retire.ts keys ghost-edge cleanup
// on `evidence.file`, and #395's single-evidence OBSERVED writes simply leave
// `sites` unset. The field is optional and additive — an edge backed by
// exactly one site may omit it. #393 (the file-native model) consumes `sites`.
export const EdgeEvidenceSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative().optional(),
  snippet: z.string().optional(),
  sites: z.array(CallSiteSchema).optional(),
})
export type EdgeEvidence = z.infer<typeof EdgeEvidenceSchema>

// Runtime signal for per-edge confidence (γ #76). Populated by ingest. Three
// continuous numbers stand in for the previous coarse 0.3/0.5/0.7/1.0 ladder:
// how much traffic, how clean, and how recent.
export const EdgeSignalSchema = z.object({
  spanCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  lastObservedAgeMs: z.number().nonnegative().optional(),
})
export type EdgeSignal = z.infer<typeof EdgeSignalSchema>

// `confidence` is in [0, 1] and graded per provenance tier (ADR-066). Producers
// write it on every EXTRACTED and OBSERVED edge via the helpers in
// confidence.ts; flat coarse values (the old `0.5` / `1.0` shape) are a
// contract violation. The field stays `.optional()` for snapshot back-compat —
// older snapshots may carry edges without confidence and persist.ts loads them
// on the documented growth path (ADR-031).
export const GraphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  type: EdgeTypeSchema,
  provenance: ProvenanceSchema,
  confidence: z.number().min(0).max(1).optional(),
  lastObserved: z.string().datetime().optional(),
  callCount: z.number().int().nonnegative().optional(),
  evidence: EdgeEvidenceSchema.optional(),
  signal: EdgeSignalSchema.optional(),
})
export type GraphEdge = z.infer<typeof GraphEdgeSchema>
