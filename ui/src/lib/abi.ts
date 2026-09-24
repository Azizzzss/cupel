import { isHex, padWord, strip0x, utf8FromHex } from './hex'
import { label } from './known'

/**
 * The four-byte selectors this page calls.
 *
 * Constants rather than hashes computed here, because hashing is the one thing
 * the page carries no library for. Each one is checked against the dispatch
 * table in the deployed bytecode, which is committed in the genesis file — see
 * `abi.test.ts`.
 */
export const SELECTOR = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
  balanceOf: '0x70a08231',
  asset: '0x38d52e0f',
  totalAssets: '0x01e1d114',
} as const

/**
 * The functions that change something on the genesis contracts, by selector.
 *
 * What the page reads is in `SELECTOR`; this is what other people send, so a
 * transaction waiting in the pool can say `Token.transfer` rather than
 * `0xa9059cbb`. Checked against the bytecode like the others.
 */
export const FUNCTIONS: Readonly<Record<string, string>> = {
  '0xa9059cbb': 'transfer',
  '0x23b872dd': 'transferFrom',
  '0x095ea7b3': 'approve',
  '0xd505accf': 'permit',
  '0x40c10f19': 'mint',
  '0x42966c68': 'burn',
  '0xd0e30db0': 'deposit',
  '0x2e1a7d4d': 'withdraw',
  '0x6e553f65': 'deposit',
  '0xba087652': 'redeem',
}

/**
 * What a transaction does, in words, when the page can tell.
 *
 * A known function on a known contract is `Token.transfer`; ether with no
 * input is a payment; anything else is undefined, and the caller shows the
 * selector rather than a guess.
 */
export function describeCall(to: string | undefined, input: string): string | undefined {
  if (!to) return 'contract creation'
  const name = label(to)
  const contract = name !== undefined && !name.startsWith('account') ? name : undefined
  if (input === '0x' || input === '') {
    return contract ? `${contract} (receive)` : 'ether payment'
  }
  const fn = FUNCTIONS[input.slice(0, 10).toLowerCase()]
  if (!fn) return undefined
  return contract ? `${contract}.${fn}` : fn
}

export type Arg = { kind: 'address'; value: string } | { kind: 'uint256'; value: bigint }

/** Calldata: the selector, then each argument as one 32-byte word. */
export function encodeCall(selector: string, args: Arg[] = []): string {
  const words = args.map((arg) =>
    arg.kind === 'address'
      ? padWord(strip0x(arg.value).toLowerCase())
      : padWord(arg.value.toString(16)),
  )
  return selector + words.join('')
}

/** The `index`th 32-byte word of return data, as 64 digits; undefined when the data is short. */
export function word(data: string, index: number): string | undefined {
  if (!isHex(data)) return undefined
  const digits = strip0x(data)
  const start = index * 64
  return digits.length < start + 64 ? undefined : digits.slice(start, start + 64)
}

export function decodeUint(data: string, index = 0): bigint | undefined {
  const digits = word(data, index)
  return digits === undefined ? undefined : BigInt(`0x${digits}`)
}

export function decodeAddress(data: string, index = 0): string | undefined {
  const digits = word(data, index)
  return digits === undefined ? undefined : `0x${digits.slice(24).toLowerCase()}`
}

export function decodeBool(data: string, index = 0): boolean | undefined {
  const value = decodeUint(data, index)
  return value === undefined ? undefined : value !== 0n
}

/**
 * A dynamic string: a word saying where it starts, a word saying how long it
 * is, then the bytes, padded out to a word boundary.
 */
export function decodeString(data: string): string | undefined {
  const offset = decodeUint(data, 0)
  if (offset === undefined || offset % 32n !== 0n || offset > 1_000_000n) return undefined
  const at = Number(offset / 32n)
  const length = decodeUint(data, at)
  if (length === undefined || length > 1_000_000n) return undefined
  const digits = strip0x(data)
  const start = (at + 1) * 64
  const end = start + Number(length) * 2
  return digits.length < end ? undefined : utf8FromHex(`0x${digits.slice(start, end)}`)
}
