# Contributing to NEAT

PRs welcome. NEAT is Apache 2.0; contributions are licensed under the same terms via [DCO sign-off](https://developercertificate.org/) or implicit agreement when you open a PR.

## Branch and PR convention

One issue, one branch, one PR. Branches are named `<issue-number>-<slug>` (e.g. `327-web-login-surface`). PR bodies reference the issue with `Refs #N`, never `Closes #N`. The maintainer closes issues by hand after verifying.

Sibling PRs branch from `main`. We don't stack PRs onto each other (rebase and merge ordering get complicated; main is the lower-friction base).

PR titles read like a colleague wrote them. No "this PR introduces" framing, no release-notes-y bullets. Plain English. Same for commit messages.

## Contracts framework

Every change is governed by the rules in [`docs/contracts.md`](./docs/contracts.md) (the index) and the per-topic contracts under `docs/contracts/`. When you edit a file the contract governs, the relevant contract surfaces automatically (PreToolUse hook in `.claude/settings.json` if you're using Claude Code; otherwise read the matching file under `docs/contracts/` before editing).

If your change conflicts with a contract, that's the bug. Either revise the change, or open a successor ADR if the contract itself needs to evolve.

## Development setup

Requires Node 20.x. `nvm use` picks up `.nvmrc` if you have nvm.

```bash
git clone https://github.com/NEAT-Technologies/Neat
cd Neat
npm install
npx turbo build test lint
```

A clean tree should pass `npx turbo build test lint` on every PR.

## Tests

```bash
npx turbo test                                                       # all packages
cd packages/core && npx vitest run test/audits/contracts.test.ts     # contract assertions only
cd packages/core && npx vitest run                                   # core only
```

Contract assertions in `packages/core/test/audits/contracts.test.ts` are the load-bearing check. Every contract rule has at least one assertion; PRs that violate a rule fail this file.

## Filing issues

Bug reports and feature requests use the templates under `.github/ISSUE_TEMPLATE/`. Pick the closest match; we'll re-triage if needed.

For security disclosures, see [`SECURITY.md`](./SECURITY.md). Don't file security issues in the public tracker.

## Code of conduct

Participation is governed by the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). Reports to conduct@neat.is.

## Repository layout

```
packages/
  types/          shared Zod schemas
  core/           graph engine, extraction, OTel ingest, REST, CLI
  mcp/            stdio MCP server
  web/            Next.js dashboard
  claude-skill/   Claude Code skill metadata
  neat.is/        umbrella package
docs/
  contracts/      binding per-topic rules
  contracts.md    contracts index
  architecture.md package boundaries and data flow
  api-reference.md REST + MCP signatures
  runbook.md      day-to-day commands
  runbook-publish.md npm publish process
```

## Questions

Open a discussion on the GitHub repo, or open an issue tagged `question`. Maintainers respond on best-effort.
