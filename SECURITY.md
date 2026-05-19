# Security Policy

## Reporting a vulnerability

Send the report to **security@neat.is** or open a private GitHub Security Advisory at https://github.com/NEAT-Technologies/Neat/security/advisories/new.

Please include:

- A description of the vulnerability and the impact you observed.
- Steps to reproduce, ideally with a minimal example.
- The affected version (`npm view neat.is version` or the container tag).
- Your suggested remediation, if any.

Do not open public issues for security vulnerabilities. The public issue tracker is for non-sensitive bug reports and feature requests.

## Response

We acknowledge receipt within two business days. For confirmed vulnerabilities, we publish a fix and a security advisory within fourteen days. Critical issues (remote code execution, auth bypass, data exfiltration) ship a same-day patch when feasible.

## Supported versions

The current minor release line receives security fixes. Earlier release lines do not. Upgrade to the latest minor before reporting; the issue may already be resolved.

## Scope

In scope:

- The `neat.is` npm package and every `@neat.is/*` scoped package.
- The container image at `ghcr.io/neat-technologies/neat`.
- The REST API exposed by the `neatd` daemon.
- The OTLP HTTP receiver at `:4318`.
- The web dashboard at `:6328`.
- The MCP server exposed by `neat-mcp`.

Out of scope:

- Vulnerabilities in third-party dependencies (report upstream; we track and update via npm audit).
- Social engineering of NEAT maintainers.
- Denial-of-service attacks that require dropping the daemon under abusive traffic (NEAT is not designed to survive adversarial load).

## Acknowledgements

Reporters who responsibly disclose are credited in the security advisory and release notes unless they prefer anonymity.
