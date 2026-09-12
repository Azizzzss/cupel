import { describe, expect, it } from 'vitest'
import type { ExecutionHead } from '../api/chain'
import { KEEP, merge, missingRange } from './blocks'

function block(number: number): ExecutionHead {
  return { number, hash: `0x${number.toString(16)}`, transactions: 0, timestamp: number, gasUsed: 0 }
}

describe('merge', () => {
  it('keeps one row per number, newest first', () => {
    const merged = merge([block(3), block(1)], [block(2), block(3)])
    expect(merged.map((b) => b.number)).toEqual([3, 2, 1])
  })

  it('prefers the later copy of a block', () => {
    const replaced = { ...block(5), transactions: 4 }
    expect(merge([block(5)], [replaced])[0].transactions).toBe(4)
  })

  it('caps at the window', () => {
    const many = Array.from({ length: 80 }, (_, i) => block(i))
    const merged = merge([], many)
    expect(merged).toHaveLength(KEEP)
    expect(merged[0].number).toBe(79)
    expect(merged[KEEP - 1].number).toBe(80 - KEEP)
  })

  it('honours a smaller cap', () => {
    const merged = merge([], [block(1), block(2), block(3)], 2)
    expect(merged.map((b) => b.number)).toEqual([3, 2])
  })
})

describe('missingRange', () => {
  it('has nothing to fetch when heads are consecutive', () => {
    expect(missingRange(9, 10)).toBeUndefined()
    expect(missingRange(10, 10)).toBeUndefined()
  })

  it('names the gap a poll skipped', () => {
    expect(missingRange(5, 9)).toEqual({ from: 6, to: 8 })
  })

  it('backfills the window when nothing is held', () => {
    expect(missingRange(undefined, 100)).toEqual({ from: 51, to: 99 })
    expect(missingRange(undefined, 3)).toEqual({ from: 0, to: 2 })
    expect(missingRange(undefined, 0)).toBeUndefined()
  })

  it('caps a huge jump at the window', () => {
    expect(missingRange(5, 1000)).toEqual({ from: 951, to: 999 })
    expect(missingRange(5, 1000, 10)).toEqual({ from: 991, to: 999 })
  })
})
