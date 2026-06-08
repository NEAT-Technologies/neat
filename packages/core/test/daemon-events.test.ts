import { describe, it, expect, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import {
  EVENT_BUS_CHANNEL,
  eventBus,
  type NeatEventEnvelope,
} from '../src/events.js'
import { handleSpan } from '../src/ingest.js'
import type { ParsedSpan } from '../src/otel.js'

// Issue #475. Under `neatd` — the deployed daemon, the mode every real
// install runs — graph mutations from OTLP ingest were never re-emitted as
// SSE frames: attachGraphToEventBus was only called from startWatch, and
// daemon.ts#bootstrapProject built project slots without ever attaching the
// graph to the bus. handleSse subscribed to a bus no producer fed, so the
// stream carried heartbeats and nothing else and the dashboard only caught
// up on a manual refresh.
//
// Three layers, hardest-to-false-pass last:
//   1. slot graph mutation → bus envelope with the right project scoping
//   2. removed slot stays silent — the detach half (a leaked listener on a
//      reloaded slot would double-emit)
//   3. the wire: a real HTTP /events connection on a bound daemon receives
//      an `edge-added` frame seconds after a span lands on the live OTLP
//      receiver.

interface Sandbox {
  home: string
  projectPaths: Map<string, string>
  cleanup: () => Promise<void>
}

// Registry sandbox under a throwaway NEAT_HOME, mirroring the daemon suite
// in audits/contracts.test.ts. Ephemeral ports so parallel workers never
// fight over 8080/4318.
async function setupSandbox(projectNames: string[]): Promise<Sandbox> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neatd-events-home-'))
  const projectPaths = new Map<string, string>()
  const cleanups: Array<() => Promise<void>> = []
  const savedEnv = new Map<string, string | undefined>()
  for (const key of ['NEAT_HOME', 'PORT', 'OTEL_PORT', 'HOST', 'NEAT_AUTH_TOKEN']) {
    savedEnv.set(key, process.env[key])
  }
  process.env.NEAT_HOME = home
  process.env.PORT = '0'
  process.env.OTEL_PORT = '0'
  process.env.HOST = '127.0.0.1'
  // Loopback bind without a token — keeps the API and SSE routes open so the
  // wire test doesn't need bearer plumbing.
  delete process.env.NEAT_AUTH_TOKEN

  const { addProject } = await import('../src/registry.js')
  for (const name of projectNames) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `neatd-events-${name}-`))
    const real = await fs.realpath(dir)
    await fs.writeFile(
      path.join(real, 'package.json'),
      JSON.stringify({ name, version: '0.0.0' }),
    )
    await addProject({ name, path: real, languages: ['javascript'] })
    projectPaths.set(name, real)
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
  }

  return {
    home,
    projectPaths,
    cleanup: async () => {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      for (const c of cleanups) await c().catch(() => {})
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

// Caller-side CLIENT span against an unresolvable peer host — mints a
// FrontierNode plus an OBSERVED CALLS edge (ADR-068), i.e. exactly the
// new-edge shape the live walk drove when this bug was found.
function clientSpan(service: string, host: string, spanId: string): ParsedSpan {
  return {
    service,
    traceId: 'aabbccddeeff00112233445566778899',
    spanId,
    name: 'GET /upstream',
    kind: 3, // CLIENT — the caller side is what mints (issue #429)
    startTimeUnixNano: '1770000000000000000',
    endTimeUnixNano: '1770000000050000000',
    startTimeIso: '2026-06-08T00:00:00.000Z',
    durationNanos: 50_000_000n,
    attributes: {
      'http.method': 'GET',
      'server.address': host,
      'server.port': 443,
    },
  }
}

function collectEnvelopes(): { envelopes: NeatEventEnvelope[]; stop: () => void } {
  const envelopes: NeatEventEnvelope[] = []
  const listener = (envelope: NeatEventEnvelope): void => {
    envelopes.push(envelope)
  }
  eventBus.on(EVENT_BUS_CHANNEL, listener)
  return { envelopes, stop: () => eventBus.off(EVENT_BUS_CHANNEL, listener) }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

describe('daemon slots feed the event bus (issue #475)', () => {
  const pendingCleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (pendingCleanups.length > 0) {
      await pendingCleanups.pop()!().catch(() => {})
    }
  })

  it('ingest into a bootstrapped slot emits an edge-added envelope scoped to the project', async () => {
    const sandbox = await setupSandbox(['evt-alpha'])
    pendingCleanups.push(sandbox.cleanup)
    const { startDaemon } = await import('../src/daemon.js')
    const handle = await startDaemon({ bindListeners: false })
    pendingCleanups.push(handle.stop)
    await handle.initialBootstrap

    const slot = handle.slots.get('evt-alpha')
    expect(slot, 'slot bootstrapped').toBeDefined()
    expect(slot!.status).toBe('active')

    const { envelopes, stop } = collectEnvelopes()
    try {
      // Same IngestContext shape the daemon's onSpan callback builds.
      await handleSpan(
        {
          graph: slot!.graph,
          errorsPath: slot!.paths.errorsPath,
          scanPath: slot!.entry.path,
          project: slot!.entry.name,
          writeErrorEventInline: false,
        },
        clientSpan('evt-alpha', 'frontier-one.example.test', '1111111111111111'),
      )
    } finally {
      stop()
    }

    const edgeAdded = envelopes.filter((e) => e.type === 'edge-added')
    expect(edgeAdded.length, 'edge-added envelopes on the bus').toBeGreaterThan(0)
    for (const e of edgeAdded) expect(e.project).toBe('evt-alpha')
    // The mint also lands the FrontierNode as a node-added on the same scope.
    const nodeAdded = envelopes.filter((e) => e.type === 'node-added')
    expect(nodeAdded.length).toBeGreaterThan(0)
    for (const e of nodeAdded) expect(e.project).toBe('evt-alpha')
  })

  it('a slot removed on reload is detached — its old graph stays silent', async () => {
    const sandbox = await setupSandbox(['evt-gone'])
    pendingCleanups.push(sandbox.cleanup)
    const { startDaemon } = await import('../src/daemon.js')
    const handle = await startDaemon({ bindListeners: false })
    pendingCleanups.push(handle.stop)
    await handle.initialBootstrap

    const slot = handle.slots.get('evt-gone')
    expect(slot?.status).toBe('active')
    const detachedGraph = slot!.graph

    const { removeProject } = await import('../src/registry.js')
    await removeProject('evt-gone')
    await handle.reload()
    expect(handle.slots.has('evt-gone')).toBe(false)

    const { envelopes, stop } = collectEnvelopes()
    try {
      // Ingest against the graph the dead slot used to own. With the leak,
      // this re-emits; detached, the bus hears nothing.
      await handleSpan(
        {
          graph: detachedGraph,
          errorsPath: path.join(sandbox.home, 'errors.ndjson'),
          scanPath: sandbox.projectPaths.get('evt-gone')!,
          project: 'evt-gone',
          writeErrorEventInline: false,
        },
        clientSpan('evt-gone', 'frontier-two.example.test', '2222222222222222'),
      )
    } finally {
      stop()
    }

    expect(envelopes).toEqual([])
  })

  it('e2e: a span on the live OTLP receiver arrives as an edge-added frame on a real /events connection', { timeout: 20_000 }, async () => {
    const sandbox = await setupSandbox(['evt-wire'])
    pendingCleanups.push(sandbox.cleanup)
    const { startDaemon } = await import('../src/daemon.js')
    const handle = await startDaemon()
    pendingCleanups.push(handle.stop)
    await handle.initialBootstrap
    expect(handle.restAddress).not.toBe('')
    expect(handle.otlpAddress).not.toBe('')

    // Real HTTP SSE connection — the exact path the dashboard's EventSource
    // takes, minus the web proxy (verified correct in the #475 walk).
    const abort = new AbortController()
    pendingCleanups.push(async () => abort.abort())
    const sseRes = await fetch(`${handle.restAddress}/projects/evt-wire/events`, {
      headers: { accept: 'text/event-stream' },
      signal: abort.signal,
    })
    expect(sseRes.status).toBe(200)
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream')

    let wire = ''
    const reader = sseRes.body!.getReader()
    const decoder = new TextDecoder()
    const drain = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          wire += decoder.decode(value, { stream: true })
        }
      } catch {
        // aborted on cleanup
      }
    })()

    // Drive a span through the live OTLP HTTP listener, exactly as an
    // instrumented app's exporter would.
    const otlpRes = await fetch(`${handle.otlpAddress}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: 'service.name', value: { stringValue: 'evt-wire' } }],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 'aabbccddeeff00112233445566778899',
                    spanId: '3333333333333333',
                    name: 'GET /upstream',
                    kind: 3,
                    startTimeUnixNano: '1770000000000000000',
                    endTimeUnixNano: '1770000000050000000',
                    attributes: [
                      { key: 'http.method', value: { stringValue: 'GET' } },
                      { key: 'server.address', value: { stringValue: 'frontier-wire.example.test' } },
                      { key: 'server.port', value: { intValue: '443' } },
                    ],
                    status: { code: 0 },
                  },
                ],
              },
            ],
          },
        ],
      }),
    })
    expect(otlpRes.status).toBe(200)

    const arrived = await waitFor(() => wire.includes('event: edge-added'), 10_000)
    expect(arrived, `edge-added frame on the wire within 10s; got: ${wire.slice(0, 500)}`).toBe(true)

    // The frame carries the minted OBSERVED edge's payload.
    const frame = wire
      .split('\n\n')
      .find((f) => f.includes('event: edge-added') && f.includes('frontier-wire.example.test'))
    expect(frame, 'edge-added frame names the frontier host').toBeDefined()
    const dataLine = frame!.split('\n').find((l) => l.startsWith('data: '))!
    const payload = JSON.parse(dataLine.slice('data: '.length))
    expect(payload.edge.provenance).toBe('OBSERVED')

    abort.abort()
    await drain
  })
})
