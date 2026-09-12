import type { ExecutionHead } from '../api/chain'

/** How many recent blocks the page keeps. Enough to see a pattern, few enough to never grow. */
export const KEEP = 50

/**
 * Newest first, one row per block number, capped.
 *
 * Pure on purpose. This runs inside a state updater, and React invokes those
 * more than once — twice on every update under StrictMode. An earlier version
 * recorded which blocks it had seen in a ref from in here, so the second
 * invocation saw the first one's bookkeeping and discarded everything it had
 * just added: the requests all succeeded, and the panel showed one row.
 */
export function merge(
  current: ExecutionHead[],
  found: ExecutionHead[],
  cap = KEEP,
): ExecutionHead[] {
  const byNumber = new Map<number, ExecutionHead>()
  for (const block of [...current, ...found]) byNumber.set(block.number, block)
  return [...byNumber.values()].sort((a, b) => b.number - a.number).slice(0, cap)
}

/**
 * The block numbers between what is held and the head, if any.
 *
 * Polling against a chain making a block a second means some blocks are simply
 * never the head when asked. Adding only what a poll returned leaves 590, 588,
 * 586 — which reads as a chain missing blocks rather than a reader missing
 * them. This says what to fetch: everything after `newest` and before `latest`,
 * capped so a page reopened against a much longer chain does not ask for
 * thousands of blocks at once. With nothing held it is the backfill.
 */
export function missingRange(
  newest: number | undefined,
  latest: number,
  cap = KEEP,
): { from: number; to: number } | undefined {
  const to = latest - 1
  const floor = Math.max(0, latest - cap + 1)
  const from = newest === undefined ? floor : Math.max(newest + 1, floor)
  return from <= to ? { from, to } : undefined
}
