import { useEffect, useRef, useState } from 'react'
import { backoffMs } from './backoff'
import { SUBSCRIBE_NEW_HEADS, parseWsFrame } from './jsonrpcWs'
import { CLOSED, type LiveState } from './state'

/**
 * A `newHeads` subscription over a node's WebSocket — the doorbell.
 *
 * The socket says that a block exists; it does not deliver the block. Each
 * ring calls `onHead`, and the store fetches over HTTP as it always did — in
 * lab mode through the gateway, so the gateway's counters keep meaning
 * something. Polling never stops while this is open; it stretches, because a
 * dead-but-open socket must not be able to freeze the page.
 *
 * Reconnects with a doubling wait, capped, and rings once on every (re)open,
 * so whatever happened during a gap is fetched by the ordinary path.
 */
export function useNewHeads(url: string | undefined, onHead: () => void): LiveState {
  const [state, setState] = useState<LiveState>(CLOSED)
  const callback = useRef(onHead)

  useEffect(() => {
    callback.current = onHead
  })

  useEffect(() => {
    if (!url) return
    let alive = true
    let attempts = 0
    let socket: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      if (!alive) return
      setState({ status: 'connecting', attempts, since: Date.now() })
      const ws = new WebSocket(url)
      socket = ws
      ws.onopen = () => ws.send(SUBSCRIBE_NEW_HEADS)
      ws.onmessage = (event) => {
        const frame = parseWsFrame(String(event.data))
        if (frame.kind === 'subscribed') {
          attempts = 0
          setState({ status: 'open', attempts: 0, since: Date.now() })
          callback.current()
        } else if (frame.kind === 'head') {
          callback.current()
        } else if (frame.kind === 'error') {
          // `eth` missing from --ws.api, say. Closing sends this through the
          // same retry as a dropped connection; polling carries on meanwhile.
          ws.close()
        }
      }
      ws.onclose = () => {
        if (!alive || socket !== ws) return
        const wait = backoffMs(attempts)
        attempts += 1
        setState({ status: 'closed', attempts, since: Date.now() })
        timer = setTimeout(connect, wait)
      }
      ws.onerror = () => {
        // A close event follows; that is where the retry is.
      }
    }

    // On a timer, so a mount that is unmounted at once — StrictMode in
    // development does exactly this — never opens a socket it will not keep.
    timer = setTimeout(connect, 0)
    return () => {
      alive = false
      clearTimeout(timer)
      if (socket) {
        socket.onclose = null
        socket.onmessage = null
        socket.close()
      }
    }
  }, [url])

  // Nothing to open is closed, whatever the last socket was doing.
  return url ? state : CLOSED
}
