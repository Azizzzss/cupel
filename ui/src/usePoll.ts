import { useEffect, useRef, useState } from 'react'

/**
 * Run an async function on an interval and keep its latest result.
 *
 * Two things this does that a naive `setInterval` does not. It never lets two
 * runs overlap, because a slow client on a loaded machine would otherwise queue
 * requests faster than it answers them. And it keeps the previous value while a
 * run is in flight, so a panel shows the last thing that was true rather than
 * blanking on every tick — a dashboard that flickers is one nobody trusts.
 */
export function usePoll<T>(
  fn: () => Promise<T>,
  everyMs: number,
  deps: unknown[] = [],
): { data: T | undefined; loading: boolean; ticks: number } {
  const [data, setData] = useState<T | undefined>(undefined)
  const [ticks, setTicks] = useState(0)
  const [loading, setLoading] = useState(true)
  const running = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    let timer: ReturnType<typeof setTimeout>

    const run = async () => {
      if (running.current) return
      running.current = true
      try {
        const value = await fn()
        if (alive.current) {
          setData(value)
          setTicks((n) => n + 1)
          setLoading(false)
        }
      } finally {
        running.current = false
        if (alive.current) timer = setTimeout(run, everyMs)
      }
    }

    void run()
    return () => {
      alive.current = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, loading, ticks }
}

/**
 * A clock that ticks locally.
 *
 * The slot countdown has to move every second, and polling three beacon nodes
 * every second to find out what time it is would be absurd — the chain's slot
 * number is a function of the wall clock and the genesis time, so it can be
 * computed here between polls.
 */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}
