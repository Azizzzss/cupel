import type { Reason } from '../lib/freshness'

/** Everything a request can be, including the two ways it can fail. */
export type Answer<T> = { ok: true; value: T } | { ok: false; reason: Reason }

const TIMEOUT_MS = 2500

/**
 * Fetch and parse, reporting the two ways that can fail separately.
 *
 * `accept` names statuses that are answers rather than refusals. The gateway's
 * `/health` returns 503 with a full body when every upstream is down — correct
 * for a load balancer, and exactly the moment the panel most needs to show
 * which upstreams are down. Treating every non-2xx as a refusal turned that
 * into "the gateway is not running".
 */
export async function json(
  url: string,
  init?: RequestInit,
  accept: number[] = [],
): Promise<Answer<unknown>> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: abort.signal })
    if (!response.ok && !accept.includes(response.status)) return { ok: false, reason: 'refused' }
    return { ok: true, value: await response.json() }
  } catch {
    // A client that is not running and a client that is starting up look
    // identical from here, and both are ordinary in a lab.
    return { ok: false, reason: 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

/** One JSON-RPC call. The answer is the whole envelope; callers read `result`. */
export async function rpc(url: string, method: string, params: unknown[] = []): Promise<Answer<unknown>> {
  return json(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

/** The `result` of a JSON-RPC answer, or undefined when there is none. */
export function result(answer: Answer<unknown>): unknown {
  return answer.ok ? (answer.value as { result?: unknown }).result : undefined
}
