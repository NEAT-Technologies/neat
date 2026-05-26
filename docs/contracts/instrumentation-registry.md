---
name: instrumentation-registry
description: "@neat.is/instrumentation-registry ships a curated, separately-versioned JSON dataset of OTel instrumentation coverage per library. Flat-map + nested-versions schema (Option C), five-value coverage enum, range-matched loader. Core consumes it through the loader, never by reading JSON directly. Refresh is an offline maintainer-reviewed batch."
governs:
  - "packages/instrumentation-registry/**"
  - "packages/core/src/installers/javascript.ts"
adr: [ADR-080, ADR-086]
---

# Instrumentation registry contract

`@neat.is/instrumentation-registry` is a separately-versioned npm package carrying a curated dataset of OTel instrumentation coverage. It is the single source of truth for "for library X at version Y, what's the canonical instrumentation?" The installer and the `/neat extend` tools consume it; the substrate does not embed library-specific logic.

## 1. Schema is flat-map + nested versions (Option C)

The dataset is a flat map keyed by library name. Each entry holds a `versions` array; each version entry carries a semver `range`, a `coverage` value, and `notes`. When `coverage` is `first-party` or `third-party`, the entry must also carry `instrumentation_package`, `package_version`, and `registration`.

```json
{
  "@prisma/client": {
    "versions": [
      { "range": ">=6.0.0", "coverage": "first-party", "instrumentation_package": "@prisma/instrumentation", "package_version": "^6.0.0", "registration": "new PrismaInstrumentation()", "notes": "..." },
      { "range": ">=5.0.0 <6.0.0", "coverage": "first-party", "instrumentation_package": "@prisma/instrumentation", "package_version": "^5.0.0", "registration": "new PrismaInstrumentation()", "notes": "..." }
    ]
  }
}
```

The seed JSON validates against a Zod schema covering this structure. A version entry that claims `first-party`/`third-party` without the three install fields is a schema violation.

## 2. Coverage enum is the five-value set

`bundled` | `first-party` | `third-party` | `http-only` | `gap`. No other values. `bundled` means `@opentelemetry/auto-instrumentations-node/register` already covers it; `http-only` means the HTTP instrumentation covers calls to the library's API host; `gap` means no instrumentation exists yet (HTTP-fallback or manual-snippet notes only).

## 3. Core consumes through the loader, never raw JSON

`packages/instrumentation-registry/src/index.ts` exports `resolve(library, installedVersion?)` (range-matched lookup returning the matching version entry or null) and `list()`. Core and the installer call these. No direct `import registry.json` or `fs.readFile` of the dataset anywhere in core — the loader is the only access path, so range-matching stays in one place.

## 4. Independent versioning is the reason this package exists

The registry ships on its own minor/patch cadence, decoupled from `neat.is`. `@neat.is/core` depends on it at a compatible range so registry refreshes reach users without bumping NEAT. This independent-versioning benefit is the structurally-unique reason the registry splits out while the rest of the substrate stays unified (ADR-086 §4). First published version is `1.0.0`; the schema is treated as stable from launch.

## 5. The publish lockstep includes the registry

Per ADR-064, every NEAT release bumps all packages including the registry, so an install never mixes skewed versions. The registry's independent cadence (§4) is for between-release refreshes; the lockstep still pins a known-good registry version at each NEAT release.

## 6. Refresh is offline, LLM-assisted, maintainer-reviewed, never auto-merged

`.github/workflows/refresh-registry.yml` runs monthly, walks the canonical OTel sources, queries an LLM with public package metadata to propose entries, and opens a PR. A maintainer reviews and accepts before publish. The LLM sees public package metadata only — never user code (see [`llm-policy.md`](./llm-policy.md)). No refresh auto-merges.
