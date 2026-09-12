import type { BeaconState } from '../api/chain'
import { freshness, type Freshness } from '../lib/freshness'
import type { NodeState } from './context'

/** A beacon reading and how old it is. */
export interface BeaconReading {
  node: NodeState
  age: Freshness
  beacon: BeaconState
}

/**
 * The node the clock should read: whichever answered, fresh before old.
 *
 * Reading node1 alone meant that stopping node1 — the demonstration this lab
 * asks for — left the clock claiming no beacon node was answering while two
 * of them were.
 */
export function clockReading(nodes: NodeState[], now: number): BeaconReading | undefined {
  const readings = nodes.flatMap((node) => {
    const beacon = node.row.value?.beacon
    return beacon?.ok ? [{ node, age: freshness(node.row, now), beacon: beacon.value }] : []
  })
  return readings.find((reading) => reading.age.kind === 'fresh') ?? readings[0]
}
