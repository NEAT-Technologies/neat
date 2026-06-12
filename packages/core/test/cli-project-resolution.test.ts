// Issue #500 — a bare query verb (no --project, no NEAT_PROJECT) must resolve
// the target project from the daemon's registered projects instead of blindly
// routing to `default`, which 404s after a one-command `npx neat.is` run (the
// orchestrator registers under the cwd basename, not `default`).
//
// These drive runQueryVerb against an isolated stub daemon on an ephemeral
// loopback port. They never touch the real ~/.neat registry or the real
// daemon ports — the stub answers GET /projects and the verb endpoint itself.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { parseArgs, runQueryVerb } from '../src/cli.js'

interface StubState {
  // What GET /projects returns.
  projects: { name: string }[]
  // Every request path the stub saw, in order. Lets us assert routing.
  seen: string[]
}

// Stand up a stub daemon that answers GET /projects with `state.projects` and
// any /graph/divergences request (default or /projects/:name/...) with an
// empty divergence result. Records request paths into `state.seen`.
async function withStubDaemon(
  state: StubState,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? ''
    state.seen.push(url)
    if (url === '/projects') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(state.projects))
      return
    }
    if (url.includes('/graph/divergences')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ totalAffected: 0, divergences: [] }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found', path: url }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('listen() gave no address')
  const baseUrl = `http://127.0.0.1:${addr.port}`
  try {
    await fn(baseUrl)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('bare query verb project resolution (#500)', () => {
  let prevApi: string | undefined
  let prevCore: string | undefined
  let prevProject: string | undefined
  const prevErr = console.error
  // Silence the dispatcher's stderr; capture it for the assertions that need it.
  let stderr = ''

  beforeEach(() => {
    prevApi = process.env.NEAT_API_URL
    prevCore = process.env.NEAT_CORE_URL
    prevProject = process.env.NEAT_PROJECT
    // Isolation: no inherited NEAT_PROJECT can leak into resolution.
    delete process.env.NEAT_PROJECT
    delete process.env.NEAT_CORE_URL
    stderr = ''
    console.error = (...args: unknown[]) => {
      stderr += args.join(' ') + '\n'
    }
  })

  afterEach(() => {
    console.error = prevErr
    if (prevApi === undefined) delete process.env.NEAT_API_URL
    else process.env.NEAT_API_URL = prevApi
    if (prevCore === undefined) delete process.env.NEAT_CORE_URL
    else process.env.NEAT_CORE_URL = prevCore
    if (prevProject === undefined) delete process.env.NEAT_PROJECT
    else process.env.NEAT_PROJECT = prevProject
  })

  // Test 1 — single registered project, no --project. Was: routes to `default`
  // and 404s. Now: routes to the one registered project.
  it('routes a bare verb to the single registered project', async () => {
    const state: StubState = { projects: [{ name: 'northsea-code' }], seen: [] }
    await withStubDaemon(state, async (baseUrl) => {
      process.env.NEAT_API_URL = baseUrl
      const code = await runQueryVerb('divergences', parseArgs([]))
      expect(code).toBe(0)
      // The verb request must be project-scoped to the one registered name —
      // not the legacy unprefixed `default` route.
      expect(state.seen).toContain('/projects')
      expect(state.seen.some((p) => p.startsWith('/projects/northsea-code/graph/divergences'))).toBe(
        true,
      )
      expect(state.seen.some((p) => p === '/graph/divergences')).toBe(false)
    })
  })

  // Test 2 — several projects, none named `default`, no --project. Don't guess:
  // helpful error listing them, non-zero exit (not a silent pick, not a 404).
  it('errors helpfully when several projects are registered and none is default', async () => {
    const state: StubState = {
      projects: [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }],
      seen: [],
    }
    await withStubDaemon(state, async (baseUrl) => {
      process.env.NEAT_API_URL = baseUrl
      const code = await runQueryVerb('divergences', parseArgs([]))
      expect(code).not.toBe(0)
      // No verb request was made — we never guessed a project.
      expect(state.seen.some((p) => p.includes('/graph/divergences'))).toBe(false)
      // The error names every project so the user can pick one.
      expect(stderr).toMatch(/--project/)
      expect(stderr).toContain('alpha')
      expect(stderr).toContain('beta')
      expect(stderr).toContain('gamma')
    })
  })

  // Test 3 — a project literally named `default` exists. Back-compat: keep
  // routing through the legacy unprefixed routes the server maps to `default`.
  it('keeps the default project on the legacy unprefixed route', async () => {
    const state: StubState = {
      projects: [{ name: 'default' }, { name: 'other' }],
      seen: [],
    }
    await withStubDaemon(state, async (baseUrl) => {
      process.env.NEAT_API_URL = baseUrl
      const code = await runQueryVerb('divergences', parseArgs([]))
      expect(code).toBe(0)
      // Unprefixed route — the server resolves it to project=default.
      expect(state.seen.some((p) => p === '/graph/divergences')).toBe(true)
      expect(state.seen.some((p) => p.startsWith('/projects/'))).toBe(false)
    })
  })

  // Test 4 — explicit --project <name> is unchanged: route straight to it and
  // never even hit /projects.
  it('routes explicit --project untouched and skips the registry lookup', async () => {
    const state: StubState = {
      projects: [{ name: 'alpha' }, { name: 'beta' }],
      seen: [],
    }
    await withStubDaemon(state, async (baseUrl) => {
      process.env.NEAT_API_URL = baseUrl
      const code = await runQueryVerb('divergences', parseArgs(['--project', 'beta']))
      expect(code).toBe(0)
      expect(state.seen.some((p) => p.startsWith('/projects/beta/graph/divergences'))).toBe(true)
      // Explicit project needs no resolution round-trip.
      expect(state.seen).not.toContain('/projects')
    })
  })

  // Test 5 — daemon unreachable. The resolution lookup fails as a transport
  // error and the verb keeps its exit-3 / "daemon running?" behavior.
  it('exits 3 with the daemon-down message when the registry lookup cannot connect', async () => {
    // Bind then immediately free a port so a connect refuses.
    const probe = http.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const addr = probe.address()
    if (!addr || typeof addr === 'string') throw new Error('listen() gave no address')
    const port = addr.port
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    process.env.NEAT_API_URL = `http://127.0.0.1:${port}`
    const code = await runQueryVerb('divergences', parseArgs([]))
    expect(code).toBe(3)
    expect(stderr.toLowerCase()).toMatch(/daemon|cannot reach/)
  })
})
