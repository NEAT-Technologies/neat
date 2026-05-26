---
name: file-awareness
description: "NEAT is file-native at the instrumentation source. OBSERVED gets file origin from a call-site span processor in the injected instrumentation (CLIENT/PRODUCER spans → code.* → ingest evidence); EXTRACTED preserves per-call-site file:line instead of collapsing to the service edge. File-node topology + dashboard build on that. Both follow verified service-graph completeness; evidence is never fabricated; service-level legibility is preserved."
governs:
  - "packages/core/src/installers/javascript.ts"
  - "packages/core/src/ingest.ts"
  - "packages/core/src/extract/calls/**"
  - "packages/types/src/results.ts"
  - "packages/core/src/graph/file-nodes.ts"
adr: [ADR-087]
---

# File-awareness contract

An agent consuming NEAT gets a deterministic answer when the result names *where in the code* a relationship originates. NEAT reaches that by fixing the grain where the data is born, then building the model on it. The order is binding.

## 1. Service-graph completeness precedes file-awareness

Nothing here begins until multi-service attribution is verified working end-to-end on a real codebase. Services remain the aggregation layer — a file belongs to a service — so attribution correctness is a prerequisite, not throwaway.

## 2. File-native at the source (both layers)

The file-grained data must exist at the source, not be reconstructed at the query layer.

- **OBSERVED.** NEAT's injected instrumentation carries a call-site `SpanProcessor` that, on CLIENT/PRODUCER spans, captures the first user-code frame (skipping `node_modules` + `@opentelemetry/*`) and attaches `code.filepath` / `code.lineno` / `code.function`. Ingest parses those into file-grained `evidence` on the OBSERVED edge. SERVER spans carry no call site and get none.
- **EXTRACTED.** The call extractors preserve per-call-site `file:line` rather than collapsing to one evidence location per service edge. Config/infra extractors stay file-only.

The injected instrumentation template is version-stamped so a re-run upgrades an existing install onto the current template (defeating `skipIfExists` for NEAT-owned generated files); this is the single migration mechanism every future template change rides.

## 3. Evidence is never fabricated

Evidence is populated only from real origin — a parsed `code.*` attribute or a matched extractor call site. OBSERVED edges from spans without `code.*`, and config/infra edges without a line, carry partial or absent evidence honestly. No synthesized file paths or line numbers.

## 4. File-native model + dashboard build on the source grain

`FileNode`/function nodes + `CONTAINS` edges; services become aggregation views; the divergence query compares at whichever grain both sides share. Traversal + MCP results carry file grain **natively** — there is no separate "surface existing evidence" step, because once both layers emit file grain at the source the model carries it rather than annotating a service-grained edge.

## 5. Service-level legibility is preserved

File detail surfaces via per-service drill-down or level-of-detail rendering, never as a flat file-level hairball that replaces the legible service view. The top-level graph stays service-shaped.
