/**
 * Numbers and hashes as something to read.
 *
 * Amounts are bigints all the way to the string: a balance of ten thousand
 * ether is 1e22 wei, which a double can hold and cannot count, and the whole
 * point of showing it is to count it.
 */

export function withCommas(value: bigint | number): string {
  return value.toLocaleString('en-US')
}

/**
 * A token amount in its own units.
 *
 * Truncated, never rounded: a balance of 0.9999999 shown as "1" is a lie a
 * vault's rounding lesson exists to expose. Trailing zeros go, so whole
 * amounts read as whole.
 */
export function formatUnits(value: bigint, decimals = 18, maxFraction = 6): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const fraction = (abs % base)
    .toString()
    .padStart(decimals, '0')
    .slice(0, maxFraction)
    .replace(/0+$/, '')
  return `${negative ? '-' : ''}${withCommas(whole)}${fraction ? `.${fraction}` : ''}`
}

export function formatEther(wei: bigint, maxFraction = 6): string {
  return formatUnits(wei, 18, maxFraction)
}

/** A fee. Anything under a thousandth of a gwei is said in wei, where it is legible. */
export function formatGwei(wei: bigint): string {
  return wei < 1_000_000n ? `${wei} wei` : `${formatUnits(wei, 9, 3)} gwei`
}

/** A hash or address with its middle taken out. */
export function shortHash(hash: string, keep = 8): string {
  return hash.length > keep + 6 ? `${hash.slice(0, keep)}…${hash.slice(-4)}` : hash || '—'
}

/** How long ago a block's timestamp was, coarsely. */
export function age(timestampSec: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - timestampSec)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}

/** A duration in milliseconds, with the precision that matters at its size. */
export function ago(ms: number): string {
  const clamped = Math.max(0, ms)
  if (clamped < 10_000) return `${(clamped / 1000).toFixed(1)}s`
  const seconds = Math.floor(clamped / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** Seconds as something to read rather than divide. */
export function mmss(seconds: number): string {
  if (seconds <= 0) return 'now'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}
