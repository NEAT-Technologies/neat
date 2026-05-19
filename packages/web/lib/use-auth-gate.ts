'use client'

import { useEffect } from 'react'
import { loadDaemonAuthConfig } from './public-read-mode'

/**
 * Client-side auth gate. When the operator has not yet pasted a NEAT token at
 * /login, redirect there carrying the current path as `?next=`. Reverse-proxy
 * deployments that already terminate auth opt out via
 * `NEXT_PUBLIC_NEAT_AUTH_PROXY=true` (ADR-073 §3 — the bearer is delegated to
 * the deploy platform).
 *
 * Public-read reference deployments (ADR-073 §3a) also skip the redirect.
 * The dashboard renders read-only without forcing a login. The negotiation
 * happens against the daemon's `/api/config` endpoint and is cached after
 * the first call, so the latency hit is paid once per session.
 *
 * Mount this from any client-only page subtree that lives behind the bearer.
 * /login itself does not call it (the page is the destination of the redirect).
 */
export function useAuthGate(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (process.env.NEXT_PUBLIC_NEAT_AUTH_PROXY === 'true') return

    let token: string | null = null
    try {
      token = window.localStorage.getItem('neat:authToken')
    } catch {
      /* private mode — fall through to the redirect */
    }
    if (token) return

    const path = window.location.pathname
    if (path === '/login') return

    let cancelled = false
    void loadDaemonAuthConfig().then((cfg) => {
      if (cancelled) return
      if (cfg.publicRead) return

      const next = encodeURIComponent(path + window.location.search)
      window.location.href = `/login?next=${next}`
    })
    return () => {
      cancelled = true
    }
  }, [])
}
