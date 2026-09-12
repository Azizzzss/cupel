import type { BeaconState } from '../api/chain'
import { mmss } from './format'

/** The three numbers a clock is built from, as the chain reported them. */
export interface Timing {
  secondsPerSlot: number
  slotsPerEpoch: number
  genesisTime: number
}

/**
 * The timing a client reported, or nothing.
 *
 * Nothing rather than a guess: the control plane spent two releases printing
 * durations computed from a slot time the chain was not using, and a clock
 * built from mainnet's numbers is the thing this panel exists not to be.
 */
export function timing(state: Pick<BeaconState, 'secondsPerSlot' | 'slotsPerEpoch' | 'genesisTime'>): Timing | undefined {
  const { secondsPerSlot, slotsPerEpoch, genesisTime } = state
  if (secondsPerSlot === undefined || slotsPerEpoch === undefined || genesisTime === undefined) {
    return undefined
  }
  if (secondsPerSlot <= 0 || slotsPerEpoch <= 0) return undefined
  return { secondsPerSlot, slotsPerEpoch, genesisTime }
}

/** Where the wall clock is in the chain's own units. */
export interface SlotView {
  /** The slot the wall clock is in — not the slot the chain has a block for. */
  clockSlot: number
  intoSlot: number
  epoch: number
  intoEpoch: number
  /** How far the head trails the clock; the gap is exactly what a missed slot is. */
  behind: number
  untilEpoch: number
  /** Seconds until the first finalised epoch is due; negative once it is overdue. */
  firstDue: number
  /** Epochs between the clock and the last finalised one. */
  lag: number
}

export function slotView(nowMs: number, t: Timing, headSlot: number, finalized: number): SlotView {
  const elapsed = Math.max(0, Math.floor(nowMs / 1000) - t.genesisTime)
  const clockSlot = Math.floor(elapsed / t.secondsPerSlot)
  const epoch = Math.floor(clockSlot / t.slotsPerEpoch)
  const epochSeconds = t.secondsPerSlot * t.slotsPerEpoch
  return {
    clockSlot,
    intoSlot: elapsed % t.secondsPerSlot,
    epoch,
    intoEpoch: clockSlot % t.slotsPerEpoch,
    behind: clockSlot - headSlot,
    untilEpoch: epochSeconds - (elapsed % epochSeconds),
    firstDue: 4 * epochSeconds - elapsed,
    lag: epoch - finalized,
  }
}

/**
 * What to say beside the finalised epoch.
 *
 * Finality normally trails the clock by two epochs, occasionally three. Past
 * that it has stopped, and saying "irreversible" beside a number that is not
 * moving hides the most interesting thing this devnet can show. The first
 * finalised epoch is due four epochs in; after that it is overdue, which is
 * different from "about now away".
 */
export function finalityNote(view: SlotView, finalized: number): string {
  if (finalized === 0) {
    return view.firstDue > 0
      ? `first one about ${mmss(view.firstDue)} away`
      : `overdue by ${mmss(-view.firstDue)} — finality needs more than two thirds of the stake attesting`
  }
  return view.lag > 3 ? `${view.lag} epochs behind the clock — finality has stalled` : 'irreversible'
}
