# CLAUDE.md

Agent guide for the NEAT repo. Fresh Claude session or human picking it up cold — read this first.

**Binding rules:** @docs/contracts.md — short list, auto-loaded with this file. Per-topic contracts live under `docs/contracts/` and surface automatically when you edit a file the contract governs (PreToolUse hook at `docs/contracts/_hook.sh`, wired in `.claude/settings.json`). A conflict between the code and a contract is the bug — open an ADR superseding the rule, or change the code.

## What NEAT is

NEAT keeps a live semantic graph of a software system — code, infrastructure, runtime — and exposes it to AI agents over MCP. The graph is fed by two streams: static analysis via tree-sitter, and runtime telemetry via OpenTelemetry. Every edge carries a `provenance` and a graded confidence; where declared intent and observed reality disagree, the divergence query surfaces the gap.

## What success looks like

**MVP success = closing a real PR on an open-source codebase NEAT was not engineered for**, where the OBSERVED layer is load-bearing in finding the bug. ADR-027 records this bar. Static-only finds don't earn NEAT its category — that's table-stakes static analysis. The thesis is the gap between declared intent and observed reality being actionable.

## Where the work happens

- `packages/types/` — Zod schemas, `Provenance` + `EdgeType` enums, identity helpers
- `packages/core/` — extractors, OTel ingest, REST + OTLP daemon, MCP-shaped queries
- `packages/mcp/` — MCP stdio server wrapping the same REST surface
- `packages/web/` — Next.js graph viewer on :6328
- `packages/claude-skill/` — drop-in MCP config for Claude Code
- `packages/neat.is/` — umbrella that installs all three CLIs onto PATH

## Decisions already made

`docs/decisions.md` is the ADR log. Read it before reopening any architectural call. Load-bearing decisions:

- npm workspaces with turbo (ADR-007)
- Native tree-sitter bindings, not web-tree-sitter (ADR-002)
- Dual ESM/CJS via tsup per package (ADR-003)
- Branch-per-issue, manual issue close (ADR-005)
- Plain-English commits and PRs (ADR-008)
- ConfigNodes record file existence, not contents (ADR-016)
- `infra:<kind>:<name>` id format, free-string `kind` (ADR-022)
- Per-edge-type stale thresholds + `stale-events.ndjson` (ADR-024)
- Multi-project routing dual-mounts at `/X` and `/projects/:project/X` (ADR-026)
- MVP success bar (ADR-027)
- Node + edge id helpers in `@neat.is/types/identity` (ADR-028, ADR-029)
- Mutation authority locked to `ingest.ts` + `extract/*` (ADR-030)
- Schema additions are growth; renames/removals are shape changes (ADR-031)
- Static-extraction precision filters + loud-failure mode (ADR-032, ADR-065)
- OTel ingest contract (ADR-033)
- FrontierNode and OBSERVED provenance are orthogonal (ADR-068)
- OBSERVED-led divergence query weighting + graded confidence (ADR-066)
- Token-aware service-name routing (ADR-072)
- Broken project slots recover on ingest and on SIGHUP (ADR-071)
- `neat init --apply` produces executable changes — manifest mutations, otel-init generation, entry-point injection (ADR-069, ADR-070)
- `comms-voice` contract — forward-looking framing on every repo artifact (covered in `docs/contracts/comms-voice.md`)

## Conventions

- One issue → one branch named `<num>-<slug>` → one PR.
- PR body says `Refs #N`, **not** `Closes #N`. The user closes issues by hand after verifying.
- Commits and PRs read like a colleague wrote them — plain English, no release-notes-y bullets (ADR-008).
- Forward-looking framing on every repo-visible artifact (see `docs/contracts/comms-voice.md`).
- Every package emits ESM + CJS + DTS via tsup. Don't ship ESM-only.
- npm publishes go through CI on tag push (`.github/workflows/publish.yml`).
- Sibling PRs from `main`, not stacked. Stacking complicates rebase + merge ordering.

## Don't

- Don't introduce mocks in production paths. Tests can mock; runtime cannot.
- Don't hardcode driver-specific logic outside `compat.json`. The compat checker reads from data.
- Don't add Python (or any other language) to NEAT's own toolchain. Node 20.x + TypeScript. Python *extraction* — reading Python service source — is supported; the extractor itself is TS.
- Don't write snapshot file contents for `.env` files. ConfigNodes record file existence only (ADR-016).
- Don't bypass `@neat.is/types/identity` helpers for node or edge ids (ADR-028, ADR-029).

## Common commands

```bash
npm install                                # one-shot for the whole workspace
npx turbo build                            # build everything
npx turbo test                             # run vitest across packages
npx turbo lint                             # eslint
node packages/core/dist/cli.cjs <verb>     # run the CLI against your local build
node packages/core/dist/neatd.cjs start    # daemon against the local build
node packages/mcp/dist/index.cjs           # MCP stdio server (after build)
```
