import { decodeUint } from './abi'
import { isHex } from './hex'

/**
 * The events the three genesis contracts emit, by the hash in `topics[0]`.
 *
 * Read off the deployed bytecode, like the selectors. The two `Deposit`s have
 * different signatures and so different hashes, which is why the table is
 * keyed by hash and not by name.
 */
export const TOPIC = {
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  approval: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  wethDeposit: '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c',
  wethWithdrawal: '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65',
  vaultDeposit: '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7',
  vaultWithdraw: '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db',
} as const

/** Indexed parameters are addresses and live in topics; the rest are uint256 and live in data. */
interface Shape {
  name: string
  indexed: readonly string[]
  data: readonly string[]
}

export const EVENTS: Readonly<Record<string, Shape>> = {
  [TOPIC.transfer]: { name: 'Transfer', indexed: ['from', 'to'], data: ['value'] },
  [TOPIC.approval]: { name: 'Approval', indexed: ['owner', 'spender'], data: ['value'] },
  [TOPIC.wethDeposit]: { name: 'Deposit', indexed: ['to'], data: ['value'] },
  [TOPIC.wethWithdrawal]: { name: 'Withdrawal', indexed: ['from'], data: ['value'] },
  [TOPIC.vaultDeposit]: {
    name: 'Deposit',
    indexed: ['caller', 'owner'],
    data: ['assets', 'shares'],
  },
  [TOPIC.vaultWithdraw]: {
    name: 'Withdraw',
    indexed: ['caller', 'receiver', 'owner'],
    data: ['assets', 'shares'],
  },
}

export type DecodedArg =
  | { name: string; kind: 'address'; value: string }
  | { name: string; kind: 'uint256'; value: bigint }

export interface DecodedLog {
  event: string
  args: DecodedArg[]
}

/**
 * A log as words, when it is one of the events above.
 *
 * Undefined for anything else, or for a log whose shape does not match its
 * hash — the page then shows the topics and data raw, which is still true.
 */
export function decodeLog(log: { topics: string[]; data: string }): DecodedLog | undefined {
  const [topic0, ...rest] = log.topics
  if (!topic0) return undefined
  const shape = EVENTS[topic0.toLowerCase()]
  if (!shape || rest.length !== shape.indexed.length) return undefined

  const args: DecodedArg[] = []
  for (const [i, name] of shape.indexed.entries()) {
    const topic = rest[i]
    if (!isHex(topic) || topic.length !== 66) return undefined
    args.push({ name, kind: 'address', value: `0x${topic.slice(26).toLowerCase()}` })
  }
  for (const [i, name] of shape.data.entries()) {
    const value = decodeUint(log.data, i)
    if (value === undefined) return undefined
    args.push({ name, kind: 'uint256', value })
  }
  return { event: shape.name, args }
}
