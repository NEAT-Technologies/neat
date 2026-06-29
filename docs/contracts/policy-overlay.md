---
name: policy-overlay
description: The policy overlay (L1) is a graph of constraints over the NEAT graph (L2) — a policy is a stored graph query in L2's own vocabulary, typed by a schema, with a vector index for fuzzy reach. The graph gates (deterministic subgraph match); vectors only resolve bindings upstream and never enforce. Retrieval is two-mode (fuzzy recall + graph worst-case), graph-only at the gate; policies reach agents via blast-radius injection. Local = graphology; hosted = pgvector + recursive CTEs.
governs:
  - "packages/core/src/policy.ts"
  - "packages/core/src/divergences.ts"
adr: [ADR-105, ADR-093, ADR-094, ADR-095, ADR-042, ADR-103, ADR-104]
enforcement: [review]
---

# Policy overlay contract

🟡 **Contract-only — opens with the governance-kernel build.** This is the representation the ADR-093 (gate) / ADR-094 (FRONTIER) / ADR-095 (divergence-as-bundle) contracts are written against, and the machinery of the `policy` enforcement pillar ([`contract-enforcement.md`](./contract-enforcement.md)). It generalizes the policy schema ([`policy-schema.md`](./policy-schema.md), ADR-042); it does not supersede it.

The overlay is **L1** — a layer of constraints *over* the NEAT graph (**L2**). L1 is built with L2's own recipe — graph + schema + vectors — but its content is constraints over L2, not facts about the world.

## 1. Graph is the gate — a policy is a stored graph query

A policy is a pattern in L2's own node/edge vocabulary — a forbidden or required subgraph (e.g. "no `CONNECTS_TO` from `region:frontend` to `type:database` except through `region:api`"). Evaluation is a **subgraph match** against L2: against current state (the flag path) or against the proposed `real ∪ delta` state (the gate path, ADR-093). The match is **deterministic**, composable (multi-hop is free), and the matched subgraph **is** the explanation. `divergences.ts` already evaluates the five divergence types this way; ADR-095 makes user-authored policies the same kind of object.

## 2. Schema is the grammar

A policy's well-formedness — `action` (`log` / `alert` / `block`), severity, scope, provenance — is typed. This generalizes the flat five-type `policy.json` (ADR-042), which is the rigid per-type-dispatch special case; the constraint now lives *in* the policy as a pattern, and one matcher evaluates all of them.

## 3. Vectors are reach — never the gate

The vector index resolves **fuzzy** predicates → concrete L2 ids ("billing data" → node ids), classifies novel / FRONTIER nodes (ADR-094), and powers policy discovery. It runs **strictly upstream** of the gate and its output is **frozen into the policy before evaluation**. A constraint never fires on a similarity threshold. This is the wall: **graph gates, vectors reach** — determinism end to end (NEAT's load-bearing word).

## 4. Retrieval is two-mode, matched to objective

- **Fuzzy search** for recall over the obvious / semantic majority.
- **Graph traversal** for the worst-case structural tail — the far-away, unique, codebase-breaking constraint that similarity ranks low *because* it is unique.
- **Union** for surfacing; **graph-only for the gate.** A guardrail needs worst-case coverage, so the graph is non-negotiable on the tail.

## 5. Policy-blast-radius injection

On an edit or read at node A, traverse the overlay from A's node(s) and inject the relevant policies — including far-away ones reachable through real edges. **Relevance = the policy's declared propagation scope × graph distance** (confidence-decayed): a downstream-breaking invariant surfaces, a local style rule three hops away does not. Injection points: the PreToolUse hook (edit-time) and the MCP read surface (read-time). The far-away constraint surfaces because the graph knew `A → … → X`, not because the agent searched.

## 6. Substrate

Local: graphology + in-process embeddings. Hosted: Postgres — graph patterns as recursive CTEs, vector reach as `pgvector` kNN (ADR-103). Local and hosted evaluate the same way at two scales.

## 7. Boundary

Pure subgraph-existence covers relational / architectural constraints. Constraints that *count* ("≤ 3 services depend on X"), *threshold a signal* ("p99 < 200ms"), or reason over *time* are query-language extensions (aggregation over L2) — still deterministic, still over L2, beyond plain subgraph isomorphism. "Graph pattern" sometimes means "graph query with aggregation."

## Authority

`packages/core/src/policy.ts` (the evaluator generalizes from per-type dispatch to pattern matching), `packages/core/src/divergences.ts` (the working proof + ADR-095 migration path), and the kernel modules opened by ADR-093/094/095. The vector index extends `packages/core/src/search.ts` (local) / `pgvector` (hosted).

## Enforcement

`enforcement: [review]` while contract-only — the kernel is unbuilt, so the active check is review. As the build lands it gains: **breaker** (the gate's propose→evaluate→allow/refuse behavior, driven end to end), **lint** (a `contracts.test.ts` assertion that no vector/similarity op appears in the evaluation path — the wall), and ultimately **policy** (NEAT enforcing this overlay over its own graph). Tagged per ADR-104.

Full rationale: [ADR-105](../decisions.md#adr-105--the-policy-overlay-l1-graph-constraints-over-the-graph-vectors-for-reach-a-deterministic-gate).
