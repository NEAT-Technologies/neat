import { CORE_URL, proxyGet } from '../../../lib/proxy'

// ADR-073 §3 amendment — `/api/config` is the daemon's auth-mode negotiation
// endpoint. Always unauthenticated, returns `{ publicRead, authProxy }`. The
// Next.js side just forwards through so the browser hits one URL regardless
// of where the daemon happens to be bound.
export async function GET(request: Request): Promise<Response> {
  return proxyGet(
    `${CORE_URL}/api/config`,
    () => Response.json({ publicRead: false, authProxy: false }),
    request,
  )
}
