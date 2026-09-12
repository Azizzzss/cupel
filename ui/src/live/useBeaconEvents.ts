import { useEffect, useRef, useState } from 'react'
import { backoffMs } from './backoff'
import { EVENTS_PATH, parseBeaconEvent, type BeaconEvent } from './beaconEvents'
import { CLOSED, type LiveState } from './state'

/**
 * A beacon node's event stream: new heads and new finalised checkpoints.
 *
 * Server-sent events, one plain GET, which the three clients' existing CORS
 * flags cover. The browser reconnects a dropped stream on its own; only when
 * it gives up — a refusal, a client without the route — does this retry, with
 * a doubling wait. As with the socket, an event is a reason to ask, not the
 * answer: the store re-reads the node's row.
 */
export function useBeaconEvents(
  beacon: string | undefined,
  onEvent: (event: BeaconEvent) => void,
): LiveState {
  const [state, setState] = useState<LiveState>(CLOSED)
  const callback = useRef(onEvent)

  useEffect(() => {
    callback.current = onEvent
  })

  useEffect(() => {
    if (!beacon) return
    let alive = true
    let attempts = 0
    let source: EventSource | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const deliver = (name: 'head' | 'finalized_checkpoint') => (event: Event) => {
      const parsed = parseBeaconEvent(name, String((event as MessageEvent).data))
      if (parsed) callback.current(parsed)
    }

    const connect = () => {
      if (!alive) return
      setState({ status: 'connecting', attempts, since: Date.now() })
      const stream = new EventSource(`${beacon}${EVENTS_PATH}`)
      source = stream
      stream.onopen = () => {
        attempts = 0
        setState({ status: 'open', attempts: 0, since: Date.now() })
      }
      stream.addEventListener('head', deliver('head'))
      stream.addEventListener('finalized_checkpoint', deliver('finalized_checkpoint'))
      stream.onerror = () => {
        if (!alive || source !== stream) return
        if (stream.readyState === EventSource.CLOSED) {
          const wait = backoffMs(attempts)
          attempts += 1
          setState({ status: 'closed', attempts, since: Date.now() })
          timer = setTimeout(connect, wait)
        } else {
          setState({ status: 'connecting', attempts, since: Date.now() })
        }
      }
    }

    timer = setTimeout(connect, 0)
    return () => {
      alive = false
      clearTimeout(timer)
      source?.close()
    }
  }, [beacon])

  // Nothing to open is closed, whatever the last stream was doing.
  return beacon ? state : CLOSED
}
