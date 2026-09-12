/** How long to wait before the next connection attempt: doubling from a second, capped at fifteen. */
export function backoffMs(attempt: number): number {
  return Math.min(15_000, 1_000 * 2 ** Math.max(0, Math.floor(attempt)))
}
