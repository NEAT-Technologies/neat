import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

// #419 — when neither the URL nor localStorage names a project, AppShell
// resolves against GET /projects. Taking list[0] blindly lands on a broken
// (dead path) or paused project, which graphs to nothing and blanks the
// dashboard. The resolver must skip non-active projects.

import { AppShell, resolveProjectFromList } from '../app/components/AppShell'

describe('#419 — resolveProjectFromList (the resolution selector, tested directly)', () => {
  it('skips a broken project ordered first and picks the active one', () => {
    expect(
      resolveProjectFromList([
        { name: 'dead', status: 'broken' },
        { name: 'live', status: 'active' },
      ]),
    ).toBe('live')
  })

  it('skips a paused project ordered first and picks the active one', () => {
    expect(
      resolveProjectFromList([
        { name: 'snoozed', status: 'paused' },
        { name: 'live', status: 'active' },
      ]),
    ).toBe('live')
  })

  it('resolves a single registered project to it, not to default', () => {
    expect(resolveProjectFromList([{ name: 'medusa', status: 'active' }])).toBe('medusa')
  })

  it('falls back to the first available when none are active', () => {
    expect(
      resolveProjectFromList([
        { name: 'dead', status: 'broken' },
        { name: 'snoozed', status: 'paused' },
      ]),
    ).toBe('dead')
  })

  it('treats a missing status as non-active but still beats default', () => {
    // A registered project with no status string shouldn't be preferred over an
    // explicitly active one...
    expect(
      resolveProjectFromList([{ name: 'unknown' }, { name: 'live', status: 'active' }]),
    ).toBe('live')
    // ...but on its own it still beats the literal 'default'.
    expect(resolveProjectFromList([{ name: 'unknown' }])).toBe('unknown')
  })

  it('falls back to default on an empty list', () => {
    expect(resolveProjectFromList([])).toBe('default')
  })
})

// Stub the heavy data-fetching children so AppShell renders under jsdom; each
// echoes the project it was handed onto a /api fetch so we can read resolution.
vi.mock('../app/components/GraphCanvas', () => ({
  GraphCanvas: ({ project }: { project: string }) => {
    fetch(`/api/graph?project=${encodeURIComponent(project)}`)
    return <div data-testid="graph-canvas" data-project={project} />
  },
}))
vi.mock('../app/components/Inspector', () => ({ Inspector: () => null }))
vi.mock('../app/components/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('../app/components/Rail', () => ({ Rail: () => null }))
vi.mock('../app/components/TopBar', () => ({ TopBar: () => null }))
vi.mock('../app/components/Toaster', () => ({ Toaster: () => null }))
vi.mock('../app/components/DebugPanel', () => ({ DebugPanel: () => null }))

// jsdom 25's built-in localStorage is flaky under this setup, so we install a
// fresh in-memory shim per test (same pattern as login-surface.test.tsx).
function makeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => store.clear(),
  } as Storage
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('#419 — AppShell resolves to a healthy project end to end', () => {
  const fetchCalls: string[] = []

  beforeEach(() => {
    fetchCalls.length = 0
    // No URL or localStorage project, so resolution falls to GET /projects.
    window.history.replaceState({}, '', '/')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: makeStorage(),
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        fetchCalls.push(url)
        if (url.includes('/api/projects')) {
          return jsonResponse([
            { name: 'broken-one', status: 'broken' },
            { name: 'healthy-one', status: 'active' },
          ])
        }
        return jsonResponse({})
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('lands the graph on the active project, never the broken one ordered first', async () => {
    render(<AppShell />)
    await waitFor(() => {
      expect(fetchCalls.some((u) => u.includes('project=healthy-one'))).toBe(true)
    })
    expect(fetchCalls.some((u) => u.includes('project=broken-one'))).toBe(false)
    // And localStorage now remembers the healthy resolution, not 'default'.
    expect(window.localStorage.getItem('neat:lastProject')).toBe('healthy-one')
  })
})
