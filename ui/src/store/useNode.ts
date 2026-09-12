import { beaconState, executionHead, type Answer, type NodeTarget } from '../api/chain'
import type { Row } from '../lib/verdict'
import { CLOSED } from '../live/state'
import { usePoll } from '../usePoll'
import type { NodeState } from './context'

/**
 * One node's answers, as one row.
 *
 * An answer only when the beacon node spoke: finality is what the row is for,
 * and an execution client answering alone is a node with half its mind. The
 * last good row is kept across failures and judged for age by whoever reads
 * it, so a node that stops is shown greyed with when it last spoke rather
 * than replaced by dashes at the first blip.
 */
async function readRow(target: NodeTarget): Promise<Answer<Row>> {
  const [execution, beacon] = await Promise.all([
    executionHead(target.rpc),
    beaconState(target.beacon!),
  ])
  if (!beacon.ok) return beacon
  return {
    ok: true,
    value: { name: target.name, consensus: target.consensus ?? '', execution, beacon },
  }
}

/** One of network mode's nodes, polled while there is a network to ask. */
export function useNode(target: NodeTarget, enabled: boolean): NodeState {
  const row = usePoll(() => readRow(target), 2000, [target.rpc], enabled)
  return { target, row, live: CLOSED }
}
