# NEAT

> Live semantic graph of your code, your infrastructure, and what's happening in production. Queryable from agents over MCP.

[![CI](https://github.com/NEAT-Technologies/Neat/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/NEAT-Technologies/Neat/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/NEAT-Technologies/Neat)](BSL)
[![Release](https://img.shields.io/github/v/release/NEAT-Technologies/Neat)](https://github.com/NEAT-Technologies/Neat/releases)
[![Website](https://img.shields.io/badge/website-neat.is-black)](https://neat.is)

NEAT keeps a working model of your system up to date from two streams at once:

- **Static analysis** of source files, `package.json`, and infrastructure config
- **Runtime telemetry** from OpenTelemetry spans

Every edge carries a `provenance` (`OBSERVED`, `INFERRED`, `EXTRACTED`, `STALE`) and a graded confidence. Where declared intent and observed reality disagree, that gap is the signal — the divergence query surfaces it for agents to act on.

---

## Install

```bash
npm install -g neat.is
```

Installs three CLIs onto your PATH: `neat`, `neatd`, `neat-mcp`.

> Container image at `ghcr.io/neat-technologies/neat` for VPS / Kubernetes deployment lands in the next patch.

---

## Quickstart

```bash
# 1. Register your project (static extraction + SDK install plan)
neat init /path/to/your/repo --project myapp --apply

# 2. Materialize the OTel dependencies NEAT added to your manifests
cd /path/to/your/repo && npm install      # or yarn / pnpm / bun

# 3. Start the NEAT daemon — REST :8080, OTLP :4318, web UI :6328
neatd start

# 4. Boot your app with OTel pointed at NEAT (env loaded from .env.neat by default)
npm run dev

# 5. Open the live graph
open http://localhost:6328/?project=myapp
```

As your app handles traffic, OBSERVED edges populate the graph. The divergence query surfaces gaps between what your code declares and what your runtime actually does.

---

## Concepts

**Provenance.** Every edge knows where it came from.

- `OBSERVED` — from real OTel spans. Carries `lastObserved`, `callCount`, and a `signal` block.
- `EXTRACTED` — from static AST + manifests + infra config. No timestamp; refreshed on re-extract.
- `INFERRED` — derived by the trace stitcher to bridge gaps in observed coverage. Confidence ≤ 0.7.
- `STALE` — was `OBSERVED`, hasn't been seen within the per-edge-type threshold.

`PROV_RANK` orders them. Traversal prefers higher-trust edges.

**Graded confidence.** Within each tier, edges grade by signal strength. `OBSERVED` by span volume + error rate + recency. `EXTRACTED` by call-site verification vs heuristic match. The precision floor drops sub-threshold candidates at emit time so the rendered graph isn't a wall of low-confidence noise.

**Divergence.** Where `EXTRACTED` and `OBSERVED` disagree. Five types: `missing-extracted` (runtime did something the code doesn't describe), `missing-observed`, `version-mismatch`, `host-mismatch`, `compat-violation`. This is the surface that finds bugs only runtime can show you.

---

## CLI

```
neat init <path>                       Register a project + plan SDK install
neat watch <path>                      Watch + re-extract on file changes
neatd start | stop | reload | status   Daemon control

neat root-cause <node-id>              Walk inbound edges — what broke first
neat blast-radius <node-id>            BFS outbound — what dies if this goes down
neat dependencies <node-id>            Transitive outbound deps
neat observed-dependencies <node-id>   Runtime-only outbound
neat incidents [<node-id>]             Recent error events
neat search <query>                    Semantic node lookup
neat diff --against <snapshot>         Compare live graph to a saved state
neat stale-edges                       Recent OBSERVED → STALE transitions
neat policies                          Current policy violations
neat divergences                       Where code and runtime disagree
```

Add `--json` to any query verb for machine-readable output. Add `--project <name>` to target a specific registered project.

---

## MCP

Drop NEAT into Claude Code, Cursor, or any MCP client:

```bash
neat skill --apply
```

Merges `mcpServers.neat` into `~/.claude.json`. The ten CLI verbs become MCP tools. Restart the host to pick up the new server.

---

## Contributing

- [`docs/contracts.md`](./docs/contracts.md) — binding rules + index of per-topic contracts. Auto-loaded by Claude Code sessions; the PreToolUse hook surfaces the relevant contract at edit time.
- [`docs/decisions.md`](./docs/decisions.md) — ADR log.
- [`docs/internal/`](./docs/internal/) — engineering notes, plans, audits.

---

## License

BSL 1.1 — see [`LICENSE`](./LICENSE).
