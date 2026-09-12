/**
 * Hex, as the chain speaks it.
 *
 * Every quantity and every byte string over JSON-RPC is a `0x`-prefixed hex
 * string. Nothing here throws: a malformed value from a client becomes
 * `undefined`, and the page shows a dash rather than a stack trace.
 */

const HEX = /^0x[0-9a-fA-F]*$/

/** Whether a value is a `0x`-prefixed hex string, possibly empty after the prefix. */
export function isHex(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value)
}

/** The digits without their prefix. */
export function strip0x(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
}

/** Digits left-padded to one 32-byte word. */
export function padWord(digits: string): string {
  return digits.padStart(64, '0')
}

/**
 * A quantity as a number.
 *
 * Undefined for anything that is not hex. Block numbers, gas and timestamps
 * fit a number with room to spare; balances and fees do not, and use
 * `hexToBigInt`.
 */
export function hexToNumber(value: unknown): number | undefined {
  if (!isHex(value) || value.length < 3) return undefined
  return Number.parseInt(value, 16)
}

/** A quantity as a bigint, exact at any size. */
export function hexToBigInt(value: unknown): bigint | undefined {
  if (!isHex(value) || value.length < 3) return undefined
  return BigInt(value)
}

/**
 * The bytes of a hex string read as UTF-8 text, when they are text.
 *
 * Undefined when they are not — invalid UTF-8, or control characters, which
 * is what a state root looks like when something insists on reading it.
 */
export function utf8FromHex(value: unknown): string | undefined {
  if (!isHex(value)) return undefined
  const digits = strip0x(value)
  if (digits.length % 2 !== 0) return undefined
  const bytes = new Uint8Array(digits.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16)
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return /\p{Cc}/u.test(text) ? undefined : text
  } catch {
    return undefined
  }
}
