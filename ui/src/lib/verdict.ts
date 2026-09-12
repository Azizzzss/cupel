import type { Answer, BeaconState, ExecutionHead } from '../api/chain'

/** One node's answers to the question. */
export interface Row {
  name: string
  consensus: string
  execution: Answer<ExecutionHead>
  beacon: Answer<BeaconState>
}

export type Kind = 'pill-idle' | 'pill-working' | 'pill-wrong' | 'pill-agree'

export interface Verdict {
  text: string
  kind: Kind
}

/** A row for a node that has not answered — or whose last answer is too old to count. */
export function unreachableRow(name: string, consensus: string): Row {
  return {
    name,
    consensus,
    execution: { ok: false, reason: 'unreachable' },
    beacon: { ok: false, reason: 'unreachable' },
  }
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five']

/**
 * Three answers to one question, and whether they match.
 *
 * Several outcomes rather than two, because only one of them is alarming. A
 * client that has not answered has not disagreed; a chain with nothing
 * finalised has not disagreed; a client an epoch behind holds the root that was
 * right an epoch ago. Collapsing any of those into "disagree" puts a red panel
 * on a healthy chain, and then nobody reads the panel.
 *
 * The epoch and the root compared here come from one response per client. They
 * used to come from two requests made at different moments, so at an epoch
 * boundary a client could report epoch N beside the root for N+1, and the panel
 * called that a disagreement between clients that agreed.
 */
export function verdict(rows: Row[]): Verdict {
  const answering = rows.flatMap((row) => (row.beacon.ok ? [row.beacon.value] : []))
  const silent = rows.length - answering.length
  if (answering.length === 0) return { text: 'no clients reachable', kind: 'pill-idle' }

  const finalising = answering.filter((state) => state.finalized > 0)
  if (finalising.length === 0) {
    return {
      text: silent ? `nothing finalised yet · ${silent} not answering` : 'nothing finalised yet',
      kind: 'pill-working',
    }
  }

  // Behind is not the same as disagreeing, and the difference is the epoch. Two
  // clients reporting different roots for the same epoch have built different
  // chains, which is the thing worth an alarm.
  const rootsByEpoch = new Map<number, Set<string>>()
  for (const state of finalising) {
    const roots = rootsByEpoch.get(state.finalized) ?? new Set<string>()
    roots.add(state.finalizedRoot)
    rootsByEpoch.set(state.finalized, roots)
  }
  if ([...rootsByEpoch.values()].some((roots) => roots.size > 1)) {
    return { text: 'the clients disagree', kind: 'pill-wrong' }
  }

  // Everything else is somebody not being where the newest client is. Each kind
  // is counted and named, rather than "one client behind" when two are or
  // "catching up" when one has stopped.
  const newest = Math.max(...finalising.map((state) => state.finalized))
  const behind = finalising.filter((state) => state.finalized < newest)
  const waiting = answering.length - finalising.length
  const notes: string[] = []
  if (behind.length > 0) {
    const gap = newest - Math.min(...behind.map((state) => state.finalized))
    notes.push(`${behind.length} behind by up to ${gap} epoch${gap === 1 ? '' : 's'}`)
  }
  if (waiting > 0) notes.push(`${waiting} not finalised yet`)
  if (silent > 0) notes.push(`${silent} not answering`)

  if (notes.length === 0) {
    return { text: `${WORDS[rows.length] ?? rows.length} clients, one chain`, kind: 'pill-agree' }
  }
  return { text: `one chain · ${notes.join(' · ')}`, kind: 'pill-working' }
}
