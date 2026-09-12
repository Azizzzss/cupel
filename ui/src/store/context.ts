import { createContext, useContext } from 'react'
import type { ExecutionHead, GatewayHealth, Mode, NodeTarget } from '../api/chain'
import type { ControlHealth } from '../api/control'
import type { Row } from '../lib/verdict'
import type { LiveState } from '../live/state'
import type { Poll } from '../usePoll'

/** One of network mode's nodes: what it last said, and how the page hears from it. */
export interface NodeState {
  target: NodeTarget
  row: Poll<Row>
  live: LiveState
}

/**
 * Everything the page knows about the chain, fetched once and read everywhere.
 *
 * Before this, three panels each asked for the head on their own timers, and
 * a status strip would have made it four. One provider asks; the strip and the
 * pages read.
 */
export interface ChainState {
  mode: Mode
  /** Whether the mode has been asked at least once — before that, "none" is only a default. */
  settled: boolean
  /** The node the feed reads: the gateway in lab mode, node1 in network mode. */
  feed?: NodeTarget
  /** What the process serving the page says about itself. */
  control: Poll<ControlHealth>
  chainId: Poll<number>
  head: Poll<ExecutionHead>
  /** The recent window, newest first. */
  blocks: ExecutionHead[]
  gateway: Poll<GatewayHealth>
  /** Network mode's three nodes; empty otherwise. */
  nodes: NodeState[]
  /** The feed's socket. */
  live: LiveState
  /** Ask everything again, now. */
  refreshAll(): void
}

export const ChainContext = createContext<ChainState | undefined>(undefined)

export function useChain(): ChainState {
  const state = useContext(ChainContext)
  if (!state) throw new Error('useChain must be used inside ChainProvider')
  return state
}
