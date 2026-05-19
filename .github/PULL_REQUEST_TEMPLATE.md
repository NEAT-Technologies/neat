<!--
Read CONTRIBUTING.md and docs/contracts.md before opening this PR.

PR title: plain English, no "this PR introduces" framing, no release-notes-y bullets.
PR body: `Refs #N`, never `Closes #N` — the maintainer closes issues by hand.
-->

## Summary

What ships in this PR, in one or two sentences.

## Contract surface

If this PR is governed by a contract under `docs/contracts/`, name it. If it changes a contract or adds a new one, link the ADR or contract file.

## Verification

- [ ] `npx turbo build test lint` clean
- [ ] New contract assertions pass (if applicable)
- [ ] Manual smoke on the change (commands run, output captured)

## Refs

Refs #
