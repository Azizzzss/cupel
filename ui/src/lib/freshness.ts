/**
 * Whether a number on the page is still true.
 *
 * Every panel keeps the last thing a source said, because a panel that blanks
 * on every failed request is one nobody trusts. The other half of that trade
 * is saying when the last answer was, so a chain that has stopped does not
 * keep looking like a chain that is running.
 */

export type Reason = 'unreachable' | 'refused'

export type Transport = 'polling' | 'live'

/** The last good answer from one source, and when it came. */
export interface Source<T> {
  /** Kept across failures. */
  value?: T
  /** When `value` was last confirmed, in milliseconds since the epoch. */
  lastOk?: number
  /** The most recent failure; cleared by the next success. */
  error?: Reason
  /** Completed runs, success or not. */
  attempts: number
  /** The interval in force — stretched while a socket is doing the asking. */
  intervalMs: number
  transport: Transport
}

/**
 * How long without an answer before a source is stale.
 *
 * Three intervals, not one: a single failed poll is a blip — the gateway's own
 * rule for its upstreams — and a slow client on a loaded machine misses one
 * routinely. Never under five seconds, so a fast poll does not flicker.
 */
export function staleAfter(intervalMs: number): number {
  return Math.max(3 * intervalMs, 5_000)
}

export type Freshness =
  | { kind: 'never'; error?: Reason }
  | { kind: 'fresh'; ageMs: number }
  | { kind: 'stale'; ageMs: number; error?: Reason }

export function freshness(
  source: Pick<Source<unknown>, 'lastOk' | 'error' | 'intervalMs'>,
  now: number,
): Freshness {
  if (source.lastOk === undefined) return { kind: 'never', error: source.error }
  const ageMs = Math.max(0, now - source.lastOk)
  return ageMs > staleAfter(source.intervalMs)
    ? { kind: 'stale', ageMs, error: source.error }
    : { kind: 'fresh', ageMs }
}

/** The class a panel body wears while its numbers are old. */
export function staleClass(f: Freshness, base = 'panel-body'): string {
  return f.kind === 'stale' ? `${base} stale` : base
}

/**
 * The worst of several sources, for a summary that must not flatter.
 *
 * Stale beats fresh, and among either the oldest answer wins. A source that
 * has never answered is a different thing from one that stopped — a node that
 * is down is the panel's story, not the page's — so it counts only when
 * nothing at all has answered yet.
 */
export function worst(sources: Pick<Source<unknown>, 'lastOk' | 'error' | 'intervalMs'>[], now: number): Freshness {
  let result: Freshness | undefined
  for (const source of sources) {
    const candidate = freshness(source, now)
    if (candidate.kind === 'never') continue
    if (
      result === undefined ||
      rank(candidate) > rank(result) ||
      (rank(candidate) === rank(result) && candidate.ageMs > ageOf(result))
    ) {
      result = candidate
    }
  }
  return result ?? { kind: 'never' }
}

function rank(f: Freshness): number {
  return f.kind === 'stale' ? 1 : 0
}

function ageOf(f: Freshness): number {
  return f.kind === 'never' ? 0 : f.ageMs
}
