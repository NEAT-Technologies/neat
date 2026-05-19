# CLAUDE.md

Agent guide for the NEAT repo. Read this first if you're a fresh Claude session or a human picking this up cold.

## Binding rules

`@docs/contracts.md` is the index, auto-loaded with this file. Per-topic contracts live under `docs/contracts/` and are surfaced automatically when you edit a governed file (PreToolUse hook at `docs/contracts/_hook.sh`, wired in `.claude/settings.json`). If you write code that conflicts with a contract, stop. The conflict is the bug.

## What NEAT is

NEAT keeps a live semantic graph of a software system. Code, infrastructure, and runtime behavior land in one model, queryable over MCP and a REST API. The graph carries provenance on every edge: `EXTRACTED` from source, `OBSERVED` from OpenTelemetry, `INFERRED` where the trace stitcher bridges gaps, `STALE` when runtime stops speaking. Divergence between declared intent and observed reality is the load-bearing finding NEAT surfaces.

The extraction pipeline reads static code via tree-sitter (JavaScript, TypeScript, Python) and ingests live OTel spans to build and maintain the graph.

## What success looks like

NEAT earns its keep when it finds a real bug in a real codebase it was not engineered against. The `OBSERVED` layer carries the load. Static analysis alone is what other tools already do.

## Conventions

- One issue, one branch named `<num>-<slug>`, one PR.
- PR body says `Refs #N`, never `Closes #N`. The user closes issues by hand after verifying.
- Commits and PRs read like a colleague wrote them. No "this commit introduces" framing, no release-notes-y bullets. Plain English.
- Sibling PRs branch from `main`, never from each other. Stacking complicates rebase and merge ordering.
- Every package emits ESM, CJS, and DTS via tsup. No ESM-only ships.
- npm publishes go through CI on tag push (`.github/workflows/publish.yml`). Process and troubleshooting in [`docs/runbook-publish.md`](docs/runbook-publish.md).

## Don't do

- Don't hardcode driver-specific logic outside `compat.json`. `compat.ts` reads from data.
- Don't introduce mocks in production paths. Tests can mock. Runtime cannot.
- Don't add new languages to the NEAT toolchain. Node 20.x and TypeScript only. Polyglot extraction reads source written in other languages, but the extractor itself stays TypeScript.
- Don't write `.env` file contents into the snapshot. ConfigNodes record file existence only.
- Don't ship cleanup work against an unlocked contract. Contract first, code second.

## Common commands

```bash
npm install                                       # one-shot for the whole workspace
npx turbo build                                   # build everything
npx turbo test                                    # run vitest across packages
npx turbo lint                                    # eslint
npm run build --workspace @neat.is/core           # one package
NEAT_SCAN_PATH=./demo \
  npm run dev --workspace @neat.is/core           # core dev server
node packages/core/dist/cli.cjs <path>            # bare-neat orchestrator
node packages/core/dist/cli.cjs init <path>       # extract only
node packages/mcp/dist/index.cjs                  # MCP stdio server
```
