import { describe, expect, it } from 'vitest'
import { freshest, freshness, staleAfter, worst } from './freshness'

const NOW = 1_000_000

describe('staleAfter', () => {
  it('is three intervals, never under five seconds', () => {
    expect(staleAfter(1500)).toBe(5000)
    expect(staleAfter(4000)).toBe(12_000)
    expect(staleAfter(10_000)).toBe(30_000)
  })
})

describe('freshness', () => {
  it('has never answered until it has', () => {
    expect(freshness({ intervalMs: 1500 }, NOW)).toEqual({ kind: 'never', error: undefined })
    expect(freshness({ intervalMs: 1500, error: 'refused' }, NOW)).toEqual({
      kind: 'never',
      error: 'refused',
    })
  })

  it('is fresh inside the threshold and stale past it', () => {
    expect(freshness({ intervalMs: 1500, lastOk: NOW - 400 }, NOW)).toEqual({ kind: 'fresh', ageMs: 400 })
    expect(freshness({ intervalMs: 1500, lastOk: NOW - 5000 }, NOW).kind).toBe('fresh')
    expect(freshness({ intervalMs: 1500, lastOk: NOW - 5001 }, NOW)).toEqual({
      kind: 'stale',
      ageMs: 5001,
      error: undefined,
    })
  })

  it('treats one failure after a success as a blip until the age passes', () => {
    const source = { intervalMs: 1500, lastOk: NOW - 2000, error: 'unreachable' as const }
    expect(freshness(source, NOW).kind).toBe('fresh')
    expect(freshness(source, NOW + 4000)).toEqual({ kind: 'stale', ageMs: 6000, error: 'unreachable' })
  })

  it('widens the threshold when the interval is stretched', () => {
    const source = { intervalMs: 10_000, lastOk: NOW - 20_000 }
    expect(freshness(source, NOW).kind).toBe('fresh')
    expect(freshness({ ...source, intervalMs: 1500 }, NOW).kind).toBe('stale')
  })

  it('never reports a negative age', () => {
    expect(freshness({ intervalMs: 1500, lastOk: NOW + 500 }, NOW)).toEqual({ kind: 'fresh', ageMs: 0 })
  })
})

describe('worst', () => {
  const fresh = { intervalMs: 1500, lastOk: NOW - 100 }
  const older = { intervalMs: 1500, lastOk: NOW - 3000 }
  const stale = { intervalMs: 1500, lastOk: NOW - 9000 }
  const staler = { intervalMs: 1500, lastOk: NOW - 30_000, error: 'unreachable' as const }
  const never = { intervalMs: 1500 }

  it('picks the oldest fresh answer when all are fresh', () => {
    expect(worst([fresh, older], NOW)).toEqual({ kind: 'fresh', ageMs: 3000 })
  })

  it('ignores a source that never answered while others have', () => {
    // A node that is down is its panel's story, not the page's.
    expect(worst([fresh, never], NOW)).toEqual({ kind: 'fresh', ageMs: 100 })
    expect(worst([never, stale, fresh], NOW).kind).toBe('stale')
    expect(worst([never, never], NOW)).toEqual({ kind: 'never' })
  })

  it('picks the stalest of the stale', () => {
    expect(worst([stale, staler, fresh], NOW)).toEqual({ kind: 'stale', ageMs: 30_000, error: 'unreachable' })
  })

  it('is never with nothing to look at', () => {
    expect(worst([], NOW)).toEqual({ kind: 'never' })
  })

  it('knows the most recent answer too', () => {
    expect(freshest([older, fresh, never], NOW)).toBe(100)
    expect(freshest([never], NOW)).toBeUndefined()
    expect(freshest([{ intervalMs: 1500, lastOk: NOW + 50 }], NOW)).toBe(0)
  })
})
