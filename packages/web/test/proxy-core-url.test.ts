import { describe, it, expect, afterEach, vi } from 'vitest'

// #418 — neatd's spawnWebUI sets NEAT_API_URL on the spawned web process
// (web-bootstrap §6). The proxy routes must read that same name. Before the
// fix they read only NEAT_CORE_URL, so on a non-default PORT the daemon set
// NEAT_API_URL=http://localhost:<restPort> while the proxy fell through to
// the :8080 default — and the dashboard talked to the wrong daemon.
//
// CORE_URL is resolved at module load, so each case resets the module
// registry and re-imports with the env it wants.

const ORIGINAL_API = process.env.NEAT_API_URL
const ORIGINAL_CORE = process.env.NEAT_CORE_URL

afterEach(() => {
  if (ORIGINAL_API === undefined) delete process.env.NEAT_API_URL
  else process.env.NEAT_API_URL = ORIGINAL_API
  if (ORIGINAL_CORE === undefined) delete process.env.NEAT_CORE_URL
  else process.env.NEAT_CORE_URL = ORIGINAL_CORE
  vi.resetModules()
})

async function loadCoreUrl(): Promise<string> {
  vi.resetModules()
  const mod = await import('../lib/proxy')
  return mod.CORE_URL
}

describe('#418 — proxy reads the daemon URL from NEAT_API_URL', () => {
  it('uses NEAT_API_URL when neatd spawned us on a non-default port', async () => {
    delete process.env.NEAT_CORE_URL
    process.env.NEAT_API_URL = 'http://localhost:9090'
    expect(await loadCoreUrl()).toBe('http://localhost:9090')
  })

  it('does not fall back to :8080 when NEAT_API_URL is set to a non-default port', async () => {
    delete process.env.NEAT_CORE_URL
    process.env.NEAT_API_URL = 'http://localhost:9090'
    expect(await loadCoreUrl()).not.toBe('http://localhost:8080')
  })

  it('keeps the :8080 default when nothing is set', async () => {
    delete process.env.NEAT_API_URL
    delete process.env.NEAT_CORE_URL
    expect(await loadCoreUrl()).toBe('http://localhost:8080')
  })

  it('still honors a hand-set NEAT_CORE_URL as a deprecated fallback', async () => {
    delete process.env.NEAT_API_URL
    process.env.NEAT_CORE_URL = 'http://localhost:7070'
    expect(await loadCoreUrl()).toBe('http://localhost:7070')
  })

  it('prefers NEAT_API_URL over NEAT_CORE_URL when both are set', async () => {
    process.env.NEAT_API_URL = 'http://localhost:9090'
    process.env.NEAT_CORE_URL = 'http://localhost:7070'
    expect(await loadCoreUrl()).toBe('http://localhost:9090')
  })
})
