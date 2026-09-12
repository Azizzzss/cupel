import { hexToNumber } from '../lib/hex'

/**
 * The little JSON-RPC that goes over a WebSocket.
 *
 * One request — subscribe to new heads — and then notifications until the
 * socket closes. geth answers the request with a subscription id, and every
 * later frame names that id beside a block header.
 */

export const SUBSCRIBE_ID = 1

export const SUBSCRIBE_NEW_HEADS = JSON.stringify({
  jsonrpc: '2.0',
  id: SUBSCRIBE_ID,
  method: 'eth_subscribe',
  params: ['newHeads'],
})

export type WsFrame =
  | { kind: 'subscribed'; id: string }
  | { kind: 'head'; number: number; hash: string; parentHash: string }
  | { kind: 'error'; message: string }
  | { kind: 'other' }

export function parseWsFrame(text: string): WsFrame {
  let frame: unknown
  try {
    frame = JSON.parse(text)
  } catch {
    return { kind: 'other' }
  }
  if (typeof frame !== 'object' || frame === null) return { kind: 'other' }
  const message = frame as {
    id?: unknown
    result?: unknown
    error?: unknown
    method?: unknown
    params?: unknown
  }

  if (message.method === 'eth_subscription') {
    const result = (message.params as { result?: Record<string, unknown> } | undefined)?.result
    const number = hexToNumber(result?.number)
    if (result && number !== undefined && typeof result.hash === 'string') {
      return {
        kind: 'head',
        number,
        hash: result.hash,
        parentHash: typeof result.parentHash === 'string' ? result.parentHash : '',
      }
    }
    return { kind: 'other' }
  }

  if (message.id === SUBSCRIBE_ID) {
    if (typeof message.result === 'string') return { kind: 'subscribed', id: message.result }
    if (message.error) {
      const error = message.error as { message?: unknown }
      return {
        kind: 'error',
        message: typeof error.message === 'string' ? error.message : 'subscription refused',
      }
    }
  }
  return { kind: 'other' }
}
