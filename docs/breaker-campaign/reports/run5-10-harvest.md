# Runs #5–10 — harvest report

Six distinct shapes against the shared `0.4.21` build, batched 3+3. **Five returned** (Python FastAPI+pg, 3-service mesh, NestJS/TS, infra, monorepo); **run #6 (bullmq/Redis queue worker) failed to return structured output** (StructuredOutput retry cap — its findings are in the workflow transcript; re-run if needed). Severity tally across the five: **23 HIGH, 15 medium, 7 low (~45 defects)**.

This is the decisive harvest. The individual bugs collapse into a handful of **systemic, often thesis-level** failures.

## The existential findings

1. **The fusion doesn't happen** (CRITICAL). EXTRACTED (static) and OBSERVED (runtime) FileNodes for the *same* file get *different* node ids and never merge → the graph is two disjoint subgraphs, not one fused model. Root: the span→node resolver records the span's **absolute** `code.filepath` with no normalization against the extractor's **repo-relative** FileNode ids ("absolute-path id with leading slash stripped"). NEAT's entire pitch is fusing static + runtime into one model; on real code, it doesn't. **Bounded fix → fix wave (fusion-nodeid).** Seen in runs #7/#8/#10.

2. **The OBSERVED layer can't ingest real telemetry** (CRITICAL). The daemon's hand-rolled OTLP/HTTP protobuf decoder 400s on standard OTel SDK output — even a minimal valid span — on a fixed32/fixed64 wire-type bug. http/protobuf is the OTel Python (and common) default exporter, so no real OTel telemetry lands. Synthetic/hand-crafted protobuf + OTLP/JSON decode fine, which masked it in tests. **Bounded fix → fix wave (otlp-decoder).** Run #5.

3. **blast-radius runs backwards** (HIGH, contract). It walks OUTBOUND (what X depends on) instead of INBOUND (what depends on X), so "what breaks if I change this DB / shared lib / config?" returns **0** for exactly the sink nodes you'd ask about. The contract (ADR-038 / get-blast-radius.md) itself specifies the wrong direction — needs an ADR supersession. Filed **#594**. Seen in runs #7/#9/#10.

## The structural findings

4. **Static extraction is file-level only** (HIGH, architectural, #595). No call / HTTP-call / function / symbol edges for JS/TS; no NestJS `@Controller` routes / `@Injectable` providers / DI edges; cross-package workspace imports dropped. The call graph is largely absent → dead-code detection, sub-service root-cause, and "file-grained" all suffer. Runs #7/#8/#10.
5. **Cross-project span contamination** (HIGH). The global OTLP endpoint merges any `service.name` into the current project's graph + `/incidents`. **Bounded fix → fix wave (ingest-hygiene).** Runs #8/#9.
6. **Python path largely broken** (HIGH). Instrumentation no-ops while reporting `instrumented 1` (+ phantom otel deps in the graph); `from PKG import NAME` resolves to `__init__.py` not the module (corrupts the whole Python graph + blast-radius); no DB modeling so host-mismatch is undetectable. Import fix → fix wave (python-imports); the no-op-instrumentation + DB-modeling parts filed under #589-class / need more work. Run #5.
7. **Infra extraction near-absent** (MEDIUM, #596). Terraform resources are edgeless orphans; Dockerfile yields only `FROM`. Run #9.
8. **Daemon lifecycle** (MEDIUM-HIGH, #597). Crashes unsupervised on ingest (no log, no restart); `daemon.json` not reconciled on exit; IPv6/dual-stack port blindness (builds on #580). Runs #5/#8.

## The hygiene cluster (mostly bounded → fix wave)

- NEAT ingests its **own** generated `.env.neat` as a user ConfigNode (self-pollution).
- Incidents not deduplicated by `(traceId, spanId)` → retried spans multiply counts.
- Handled 4xx recorded as faults; incidents with `errorMessage: "unknown error"`; `/incidents` service filter silently ignored + capped at 50 (buries a service's real incidents).
- Every outbound HTTP call still mints a duplicate `frontier:localhost` edge (#590 confirmed across shapes).

## Verdict

The breaker did its job. NEAT's engine is real and its determinism/provenance story is sound, but **on codebases it wasn't engineered against, the two claims that matter most — "we fuse static + runtime" and "OBSERVED carries the load" — currently fail**, over a small number of fixable root causes (the node-id normalization and the OTLP decoder chief among them) plus genuine architectural gaps (file-level-only extraction, blast-radius direction). Not HN-ready; clearly *fixable*, and now precisely mapped.
