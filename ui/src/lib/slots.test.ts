import { describe, expect, it } from 'vitest'
import { finalityNote, slotView, timing } from './slots'

const T = { secondsPerSlot: 12, slotsPerEpoch: 32, genesisTime: 1_000_000 }
const at = (secondsAfterGenesis: number) => (T.genesisTime + secondsAfterGenesis) * 1000

describe('timing', () => {
  it('needs all three numbers', () => {
    expect(timing(T)).toEqual(T)
    expect(timing({ ...T, secondsPerSlot: undefined })).toBeUndefined()
    expect(timing({ ...T, slotsPerEpoch: undefined })).toBeUndefined()
    expect(timing({ ...T, genesisTime: undefined })).toBeUndefined()
    expect(timing({ ...T, slotsPerEpoch: 0 })).toBeUndefined()
  })
})

describe('slotView', () => {
  it('places the wall clock in slots and epochs', () => {
    const view = slotView(at(12 * 33 + 5), T, 32, 0)
    expect(view.clockSlot).toBe(33)
    expect(view.intoSlot).toBe(5)
    expect(view.epoch).toBe(1)
    expect(view.intoEpoch).toBe(1)
    expect(view.behind).toBe(1)
    expect(view.untilEpoch).toBe(384 - 17)
  })

  it('clamps before genesis', () => {
    const view = slotView(at(-100), T, 0, 0)
    expect(view.clockSlot).toBe(0)
    expect(view.intoSlot).toBe(0)
    expect(view.untilEpoch).toBe(384)
  })

  it('counts down to the first finalised epoch and then past it', () => {
    expect(slotView(at(0), T, 0, 0).firstDue).toBe(4 * 384)
    expect(slotView(at(4 * 384 + 60), T, 0, 0).firstDue).toBe(-60)
  })

  it('measures finality against the clock', () => {
    expect(slotView(at(10 * 384), T, 320, 8).lag).toBe(2)
  })
})

describe('finalityNote', () => {
  it('waits, then says overdue, on a chain that has never finalised', () => {
    expect(finalityNote(slotView(at(0), T, 0, 0), 0)).toBe('first one about 25m 36s away')
    expect(finalityNote(slotView(at(4 * 384 + 90), T, 0, 0), 0)).toBe(
      'overdue by 1m 30s — finality needs more than two thirds of the stake attesting',
    )
  })

  it('calls two epochs of lag irreversible and four a stall', () => {
    expect(finalityNote(slotView(at(10 * 384), T, 320, 8), 8)).toBe('irreversible')
    expect(finalityNote(slotView(at(10 * 384), T, 320, 6), 6)).toBe(
      '4 epochs behind the clock — finality has stalled',
    )
  })
})
