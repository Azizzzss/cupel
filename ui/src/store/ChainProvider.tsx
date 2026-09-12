import { useCallback, useMemo, type ReactNode } from 'react'
import {
  LAB,
  NETWORK,
  chainId as chainIdOf,
  executionHead,
  gatewayHealth,
  probeMode,
  type Answer,
  type Mode,
} from '../api/chain'
import { controlHealth } from '../api/control'
import { CLOSED } from '../live/state'
import { usePoll } from '../usePoll'
import { ChainContext, type ChainState } from './context'
import { useFeed } from './useFeed'
import { useNode } from './useNode'

/** Probing never fails: "nothing is running" is an answer, not an error. */
async function probed(): Promise<Answer<Mode>> {
  return { ok: true, value: await probeMode() }
}

/**
 * Fetches everything the page shows, once, and hands it down.
 *
 * Which mode is running is itself polled, so bringing a devnet up in another
 * terminal changes the page without anybody reloading it. The process serving
 * the page is asked first, because it knows; the ports are probed only when it
 * does not answer — a dev server with nothing behind it, or a page opened from
 * a file.
 */
export function ChainProvider({ children }: { children: ReactNode }) {
  const control = usePoll(controlHealth, 4000, [])
  // `error` clears on every success, so this is "what it said, if it is
  // answering now" — not the last thing it said before it stopped.
  const told = control.error === undefined ? control.value?.mode : undefined
  const probe = usePoll(probed, 4000, [], control.attempts > 0 && told === undefined)
  const mode: Mode = told ?? probe.value ?? 'none'
  const settled = told !== undefined || probe.attempts > 0

  const feed = mode === 'lab' ? LAB[0] : mode === 'network' ? NETWORK[0] : undefined
  const enabled = feed !== undefined
  const rpc = feed?.rpc ?? ''

  const head = usePoll(() => executionHead(rpc), 1500, [rpc], enabled)
  const chainId = usePoll(() => chainIdOf(rpc), 10_000, [rpc], enabled)
  const gateway = usePoll(() => gatewayHealth(), 2000, [], enabled)
  const blocks = useFeed(enabled ? rpc : undefined, head.value)

  // A fixed three, so the hooks are the same on every render; each is idle
  // outside network mode.
  const network = mode === 'network'
  const node1 = useNode(NETWORK[0], network)
  const node2 = useNode(NETWORK[1], network)
  const node3 = useNode(NETWORK[2], network)

  const refreshes = [control, probe, head, chainId, gateway, node1.row, node2.row, node3.row].map(
    (poll) => poll.refresh,
  )
  const refreshAll = useCallback(() => {
    for (const refresh of refreshes) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, refreshes)

  const value = useMemo<ChainState>(
    () => ({
      mode,
      settled,
      feed,
      control,
      chainId,
      head,
      blocks,
      gateway,
      nodes: network ? [node1, node2, node3] : [],
      live: CLOSED,
      refreshAll,
    }),
    [mode, settled, feed, control, chainId, head, blocks, gateway, network, node1, node2, node3, refreshAll],
  )

  return <ChainContext.Provider value={value}>{children}</ChainContext.Provider>
}
