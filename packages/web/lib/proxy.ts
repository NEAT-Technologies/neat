// web-bootstrap §6 — neatd's spawnWebUI sets NEAT_API_URL in the child's env,
// pointing at the daemon that launched it. The proxy routes must read the same
// name, or a non-default PORT lands us back on :8080 (the old NEAT_CORE_URL
// mismatch, #418). NEAT_CORE_URL stays as a deprecated fallback so operators
// who set it by hand don't break on upgrade.
export const CORE_URL =
  process.env.NEAT_API_URL ?? process.env.NEAT_CORE_URL ?? 'http://localhost:8080'
export const DEMO = process.env.NEAT_DEMO === '1'

// Forward the operator's bearer (ADR-073 §3) and the SSE caller's Last-Event-ID
// so the daemon sees what the browser sent. Other headers are upstream-managed.
const FORWARD_HEADERS = ['authorization', 'last-event-id'] as const

function pickForwardableHeaders(req?: Request): HeadersInit | undefined {
  if (!req) return undefined
  const out: Record<string, string> = {}
  for (const name of FORWARD_HEADERS) {
    const v = req.headers.get(name)
    if (v) out[name] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export async function proxyGet(
  url: string,
  fallback: () => Response,
  req?: Request,
): Promise<Response> {
  try {
    const upstream = await fetch(url, { cache: 'no-store', headers: pickForwardableHeaders(req) })
    const body = await upstream.text()
    return new Response(body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    })
  } catch {
    if (DEMO) return fallback()
    return Response.json({ error: 'failed to reach neat-core', coreUrl: CORE_URL }, { status: 502 })
  }
}
