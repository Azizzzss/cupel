import { hexToBigInt, hexToNumber } from '../lib/hex'
import { parseBlock, parseReceipt, parseTx, type BlockDetail, type Receipt, type TxDetail } from '../lib/parse'
import { parsePool, type Pool } from '../lib/pool'
import { result, rpc, type Answer } from './transport'

/**
 * The execution layer, past the head.
 *
 * `null` is a legitimate answer from a client: a block it does not have yet, a
 * hash it has never seen. It is kept distinct from a refusal, because "not on
 * this chain" and "the client would not say" call for different words.
 */

export async function blockDetail(rpcUrl: string, number: number): Promise<Answer<BlockDetail | null>> {
  const answer = await rpc(rpcUrl, 'eth_getBlockByNumber', [`0x${number.toString(16)}`, true])
  if (!answer.ok) return answer
  const raw = result(answer)
  if (raw === null || raw === undefined) return { ok: true, value: null }
  const block = parseBlock(raw)
  return block ? { ok: true, value: block } : { ok: false, reason: 'refused' }
}

export async function transaction(rpcUrl: string, hash: string): Promise<Answer<TxDetail | null>> {
  const answer = await rpc(rpcUrl, 'eth_getTransactionByHash', [hash])
  if (!answer.ok) return answer
  const raw = result(answer)
  if (raw === null || raw === undefined) return { ok: true, value: null }
  const tx = parseTx(raw)
  return tx ? { ok: true, value: tx } : { ok: false, reason: 'refused' }
}

export async function receipt(rpcUrl: string, hash: string): Promise<Answer<Receipt | null>> {
  const answer = await rpc(rpcUrl, 'eth_getTransactionReceipt', [hash])
  if (!answer.ok) return answer
  const raw = result(answer)
  if (raw === null || raw === undefined) return { ok: true, value: null }
  const parsed = parseReceipt(raw)
  return parsed ? { ok: true, value: parsed } : { ok: false, reason: 'refused' }
}

export async function balance(rpcUrl: string, address: string): Promise<Answer<bigint>> {
  const answer = await rpc(rpcUrl, 'eth_getBalance', [address, 'latest'])
  if (!answer.ok) return answer
  const value = hexToBigInt(result(answer))
  return value === undefined ? { ok: false, reason: 'refused' } : { ok: true, value }
}

export async function nonce(rpcUrl: string, address: string): Promise<Answer<number>> {
  const answer = await rpc(rpcUrl, 'eth_getTransactionCount', [address, 'latest'])
  if (!answer.ok) return answer
  const value = hexToNumber(result(answer))
  return value === undefined ? { ok: false, reason: 'refused' } : { ok: true, value }
}

/** Everything the node is holding and has not put in a block. */
export async function txpoolContent(rpcUrl: string): Promise<Answer<Pool>> {
  const answer = await rpc(rpcUrl, 'txpool_content')
  if (!answer.ok) return answer
  const pool = parsePool(result(answer))
  return pool ? { ok: true, value: pool } : { ok: false, reason: 'refused' }
}

/** Just the two counts — cheap enough to ask every node for. */
export async function txpoolStatus(rpcUrl: string): Promise<Answer<{ pending: number; queued: number }>> {
  const answer = await rpc(rpcUrl, 'txpool_status')
  if (!answer.ok) return answer
  const raw = result(answer) as { pending?: unknown; queued?: unknown } | undefined
  const pending = hexToNumber(raw?.pending)
  const queued = hexToNumber(raw?.queued)
  return pending === undefined || queued === undefined
    ? { ok: false, reason: 'refused' }
    : { ok: true, value: { pending, queued } }
}

/** A read-only call: the return data, as hex. */
export async function call(rpcUrl: string, to: string, data: string): Promise<Answer<string>> {
  const answer = await rpc(rpcUrl, 'eth_call', [{ to, data }, 'latest'])
  if (!answer.ok) return answer
  const value = result(answer)
  return typeof value === 'string' ? { ok: true, value } : { ok: false, reason: 'refused' }
}
