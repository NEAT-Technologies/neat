import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  EVENT_BUS_CHANNEL,
  eventBus,
  type NeatEventEnvelope,
} from '../src/events.js'
import { handleSse, SSE_HEARTBEAT_MS } from '../src/streaming.js'

// Issue #356. handleSse set the SSE headers and flushed them, then waited on
// the bus or the 30s heartbeat before writing anything to the body. Until the
// first body byte lands, a browser's EventSource stays in CONNECTING (0) and
// the StatusBar renders "reconnecting" — up to 30s of a dashboard that looks
// stuck on a healthy, idle daemon. The fix writes an initial `:open\n\n`
// comment right after flushHeaders so the stream opens at the handshake.

// Minimal stand-ins for the Fastify req/reply pair handleSse touches. raw is
// an EventEmitter so the close/error wiring binds without throwing; every
// write is captured in order.
function makeFakeReply(): {
  reply: any
  writes: string[]
  raw: EventEmitter & Record<string, any>
} {
  const writes: string[] = []
  const raw = new EventEmitter() as EventEmitter & Record<string, any>
  raw.writableEnded = false
  raw.setHeader = vi.fn()
  raw.flushHeaders = vi.fn()
  raw.write = vi.fn((chunk: string, cb?: () => void) => {
    writes.push(chunk)
    // Async-drain callback like the real socket, so pending decrements.
    if (cb) queueMicrotask(cb)
    return true
  })
  raw.end = vi.fn(() => {
    raw.writableEnded = true
  })
  return { reply: { raw }, writes, raw }
}

function makeFakeReq(): any {
  const raw = new EventEmitter()
  return { raw }
}

describe('handleSse initial frame (issue #356)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('writes an :open comment at connect time, before any event or the heartbeat', () => {
    vi.useFakeTimers()
    const { reply, writes, raw } = makeFakeReply()
    const req = makeFakeReq()

    handleSse(req, reply, { project: 'p-open' })

    // The very first body byte lands synchronously at the handshake — no bus
    // traffic, no advancing of the heartbeat timer. On unfixed main this
    // array is empty here and stays empty until the 30s tick.
    expect(writes.length).toBeGreaterThan(0)
    expect(writes[0]).toBe(':open\n\n')
    // It's a comment, so it carries no event:/data: lines — outside the
    // locked ADR-051 taxonomy.
    expect(writes[0]).not.toContain('event:')
    expect(writes[0]).not.toContain('data:')

    // Sanity: we're well short of the heartbeat interval; nothing else fired.
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS - 1)
    expect(writes).toEqual([':open\n\n'])

    raw.emit('close')
  })

  it('still fires the heartbeat on its interval and still flows real events after the open frame', async () => {
    vi.useFakeTimers()
    const { reply, writes, raw } = makeFakeReply()
    const req = makeFakeReq()

    handleSse(req, reply, { project: 'p-flow', heartbeatMs: 1_000 })
    expect(writes[0]).toBe(':open\n\n')

    // Heartbeat still lands on its interval, unchanged by the initial frame.
    vi.advanceTimersByTime(1_000)
    expect(writes).toContain(':heartbeat\n\n')

    // A real node-added/edge-added on the bus still routes to a frame.
    const nodeEnvelope: NeatEventEnvelope = {
      project: 'p-flow',
      type: 'node-added',
      payload: { node: { id: 'service:checkout' } },
    } as NeatEventEnvelope
    eventBus.emit(EVENT_BUS_CHANNEL, nodeEnvelope)

    const edgeEnvelope: NeatEventEnvelope = {
      project: 'p-flow',
      type: 'edge-added',
      payload: { edge: { id: 'e1', provenance: 'OBSERVED' } },
    } as NeatEventEnvelope
    eventBus.emit(EVENT_BUS_CHANNEL, edgeEnvelope)

    // Let the write callbacks drain.
    await vi.runOnlyPendingTimersAsync()

    expect(writes.some((w) => w.startsWith('event: node-added'))).toBe(true)
    expect(writes.some((w) => w.startsWith('event: edge-added'))).toBe(true)

    // The open frame was first and is not duplicated by anything the bus did.
    expect(writes.filter((w) => w === ':open\n\n')).toHaveLength(1)

    raw.emit('close')
  })
})
