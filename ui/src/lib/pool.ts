import { describeCall } from './abi'
import { parseTx, type TxDetail } from './parse'

/**
 * The transaction pool, as `txpool_content` reports it.
 *
 * Two lists, and the difference between them is the lesson. **Pending** is
 * ready: the next nonce for its sender, or a run of nonces with no gap, so the
 * next block can take it. **Queued** is accepted and parked — usually because
 * a nonce in front of it has not arrived — and no block will take it until the
 * gap is filled. Both got a hash back from `eth_sendRawTransaction`. Neither
 * has run.
 */

export type PoolState = 'pending' | 'queued'

export interface PoolTx extends TxDetail {
  state: PoolState
  /** `Token.transfer`, `ether payment`, … — undefined when the page cannot tell. */
  what?: string
}

export interface Pool {
  pending: PoolTx[]
  queued: PoolTx[]
}

/**
 * Parse `txpool_content`: `{ pending: { sender: { nonce: tx } }, queued: … }`.
 *
 * Sorted by sender and then nonce, which is the order the pool itself thinks
 * in: a sender's transactions are a sequence, and the first one missing holds
 * up every one after it.
 */
export function parsePool(raw: unknown): Pool | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const content = raw as Record<string, unknown>
  const read = (state: PoolState): PoolTx[] | undefined => {
    const bySender = content[state]
    if (bySender === undefined || bySender === null) return []
    if (typeof bySender !== 'object') return undefined
    const out: PoolTx[] = []
    for (const byNonce of Object.values(bySender as Record<string, unknown>)) {
      if (!byNonce || typeof byNonce !== 'object') continue
      for (const entry of Object.values(byNonce as Record<string, unknown>)) {
        const tx = parseTx(entry)
        if (tx) out.push({ ...tx, state, what: describeCall(tx.to, tx.input) })
      }
    }
    return out.sort((a, b) => a.from.toLowerCase().localeCompare(b.from.toLowerCase()) || a.nonce - b.nonce)
  }
  const pending = read('pending')
  const queued = read('queued')
  return pending && queued ? { pending, queued } : undefined
}

/** Senders with something queued, lowercased — whose nonces are worth asking for. */
export function queuedSenders(pool: Pool | undefined): string[] {
  if (!pool) return []
  return [...new Set(pool.queued.map((tx) => tx.from.toLowerCase()))].sort()
}

/**
 * The nonce each queued transaction is waiting for.
 *
 * A sender's next runnable nonce is one past its last pending transaction, or
 * — with nothing pending — the nonce its account holds on chain. A queued
 * transaction above that is waiting for exactly that number to arrive.
 * Undefined when the page does not know the account's nonce yet, rather than
 * a number made up from the queue alone.
 */
export function waitingFor(pool: Pool, chainNonce: Readonly<Record<string, number>>): Map<string, number> {
  const next = new Map<string, number>()
  for (const tx of pool.pending) {
    const from = tx.from.toLowerCase()
    next.set(from, Math.max(next.get(from) ?? 0, tx.nonce + 1))
  }
  const out = new Map<string, number>()
  for (const tx of pool.queued) {
    const from = tx.from.toLowerCase()
    const expected = next.get(from) ?? chainNonce[from]
    if (expected !== undefined && tx.nonce > expected) out.set(tx.hash, expected)
  }
  return out
}

/** A transaction seen in the pool, and when. */
export interface Sighting {
  hash: string
  from: string
  nonce: number
  what?: string
  /** When the page first saw it in the pool, in ms. */
  firstSeen: number
  /** The last reading that still had it. */
  lastSeen: number
  /** The reading before the first one that had it — it arrived after this. Absent on the page's first look. */
  before?: number
  /** Whether it was ever seen queued before it left. */
  wasQueued: boolean
  /** The first reading without it, in ms; absent while it is still there. */
  leftAt?: number
}

/**
 * How long a transaction that has left was in the pool, as the bounds the
 * readings allow.
 *
 * The page only knows what it saw when it looked. At least as long as between
 * the first and last readings that had it; at most as long as between the
 * readings either side of those. A single midpoint would be a number the page
 * does not have — two readings a few milliseconds apart once timed everything
 * at 0.0s.
 */
export function timeInPool(sighting: Sighting): { least: number; most?: number } {
  const least = sighting.lastSeen - sighting.firstSeen
  const most =
    sighting.before !== undefined && sighting.leftAt !== undefined ? sighting.leftAt - sighting.before : undefined
  return { least, most }
}

/**
 * Follow transactions through the pool from one reading to the next.
 *
 * A hash that was there and is not any more has left — included, replaced or
 * dropped; the transaction page says which. How long it spent here is the
 * measurement worth having: in lab mode about a second, on the devnet up to a
 * slot, and for a queued one as long as the gap in front of it lasted.
 *
 * The times are the page's, from when it looked, so they are accurate to one
 * polling interval — which the page says.
 */
export function track(
  seen: ReadonlyMap<string, Sighting>,
  pool: Pool,
  now: number,
  previous?: number,
): { seen: Map<string, Sighting>; left: Sighting[] } {
  const next = new Map<string, Sighting>()
  for (const tx of [...pool.pending, ...pool.queued]) {
    const earlier = seen.get(tx.hash)
    next.set(tx.hash, {
      hash: tx.hash,
      from: tx.from,
      nonce: tx.nonce,
      what: tx.what,
      firstSeen: earlier?.firstSeen ?? now,
      lastSeen: now,
      before: earlier ? earlier.before : previous,
      wasQueued: (earlier?.wasQueued ?? false) || tx.state === 'queued',
    })
  }
  const left: Sighting[] = []
  for (const [hash, sighting] of seen) {
    if (!next.has(hash)) left.push({ ...sighting, leftAt: now })
  }
  return { seen: next, left }
}

/** Keep the most recent departures, newest first, at most `limit` of them. */
export function remember(history: readonly Sighting[], left: readonly Sighting[], limit = 12): Sighting[] {
  if (left.length === 0) return history as Sighting[]
  const fresh = [...left].sort((a, b) => b.nonce - a.nonce)
  return [...fresh, ...history].slice(0, limit)
}
