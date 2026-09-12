import { hexToBigInt, hexToNumber } from './hex'

/**
 * Blocks, transactions and receipts as the page holds them.
 *
 * Numbers that fit a number are numbers; amounts and fees are bigints; and
 * every parsed thing keeps `raw`, so the details view can show exactly what
 * the client said without `JSON.stringify` ever meeting a bigint.
 */

export interface TxSummary {
  hash: string
  from: string
  to?: string
  value: bigint
  gas: number
  nonce: number
  index?: number
}

export interface BlockDetail {
  number: number
  hash: string
  parentHash: string
  timestamp: number
  gasUsed: number
  gasLimit: number
  baseFeePerGas?: bigint
  miner: string
  extraData: string
  stateRoot: string
  size?: number
  transactions: TxSummary[]
  raw: Record<string, unknown>
}

export interface TxDetail extends TxSummary {
  /** Absent while the transaction is still in the pool. */
  blockNumber?: number
  blockHash?: string
  input: string
  type?: number
  gasPrice?: bigint
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  raw: Record<string, unknown>
}

export interface Log {
  address: string
  topics: string[]
  data: string
  logIndex: number
}

export interface Receipt {
  status: boolean
  gasUsed: number
  effectiveGasPrice?: bigint
  contractAddress?: string
  logs: Log[]
  raw: Record<string, unknown>
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

export function parseTx(raw: unknown): TxDetail | undefined {
  const t = record(raw)
  if (!t) return undefined
  const hash = str(t.hash)
  const from = str(t.from)
  const value = hexToBigInt(t.value)
  const gas = hexToNumber(t.gas)
  const nonce = hexToNumber(t.nonce)
  if (!hash || !from || value === undefined || gas === undefined || nonce === undefined) return undefined
  return {
    hash,
    from,
    to: str(t.to),
    value,
    gas,
    nonce,
    index: hexToNumber(t.transactionIndex),
    blockNumber: hexToNumber(t.blockNumber),
    blockHash: str(t.blockHash),
    input: str(t.input) ?? '0x',
    type: hexToNumber(t.type),
    gasPrice: hexToBigInt(t.gasPrice),
    maxFeePerGas: hexToBigInt(t.maxFeePerGas),
    maxPriorityFeePerGas: hexToBigInt(t.maxPriorityFeePerGas),
    raw: t,
  }
}

export function parseBlock(raw: unknown): BlockDetail | undefined {
  const b = record(raw)
  if (!b) return undefined
  const number = hexToNumber(b.number)
  const hash = str(b.hash)
  const timestamp = hexToNumber(b.timestamp)
  const gasUsed = hexToNumber(b.gasUsed)
  const gasLimit = hexToNumber(b.gasLimit)
  if (number === undefined || !hash || timestamp === undefined || gasUsed === undefined || gasLimit === undefined) {
    return undefined
  }
  const transactions = Array.isArray(b.transactions)
    ? b.transactions.flatMap((entry) => {
        const tx = parseTx(entry)
        return tx ? [tx] : []
      })
    : []
  return {
    number,
    hash,
    parentHash: str(b.parentHash) ?? '',
    timestamp,
    gasUsed,
    gasLimit,
    baseFeePerGas: hexToBigInt(b.baseFeePerGas),
    miner: str(b.miner) ?? '',
    extraData: str(b.extraData) ?? '0x',
    stateRoot: str(b.stateRoot) ?? '',
    size: hexToNumber(b.size),
    transactions,
    raw: b,
  }
}

export function parseReceipt(raw: unknown): Receipt | undefined {
  const r = record(raw)
  if (!r) return undefined
  const gasUsed = hexToNumber(r.gasUsed)
  if (gasUsed === undefined) return undefined
  const logs = Array.isArray(r.logs)
    ? r.logs.flatMap((entry) => {
        const log = record(entry)
        const address = str(log?.address)
        const data = str(log?.data)
        if (!log || !address || data === undefined || !Array.isArray(log.topics)) return []
        return [
          {
            address,
            topics: log.topics.filter((topic): topic is string => typeof topic === 'string'),
            data,
            logIndex: hexToNumber(log.logIndex) ?? 0,
          },
        ]
      })
    : []
  return {
    status: hexToNumber(r.status) === 1,
    gasUsed,
    effectiveGasPrice: hexToBigInt(r.effectiveGasPrice),
    contractAddress: str(r.contractAddress),
    logs,
    raw: r,
  }
}
