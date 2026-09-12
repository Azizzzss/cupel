import { hexToBigInt, hexToNumber } from '../lib/hex'
import { parseBlock, parseReceipt, parseTx, type BlockDetail, type Receipt, type TxDetail } from '../lib/parse'
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

/** A read-only call: the return data, as hex. */
export async function call(rpcUrl: string, to: string, data: string): Promise<Answer<string>> {
  const answer = await rpc(rpcUrl, 'eth_call', [{ to, data }, 'latest'])
  if (!answer.ok) return answer
  const value = result(answer)
  return typeof value === 'string' ? { ok: true, value } : { ok: false, reason: 'refused' }
}
