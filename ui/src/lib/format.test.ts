import { describe, expect, it } from 'vitest'
import { age, ago, formatEther, formatGwei, formatUnits, mmss, shortHash, withCommas } from './format'

const ETHER = 10n ** 18n

describe('formatUnits', () => {
  it('shows whole amounts whole', () => {
    expect(formatUnits(ETHER)).toBe('1')
    expect(formatUnits(0n)).toBe('0')
    expect(formatUnits(10_000n * ETHER)).toBe('10,000')
  })

  it('keeps a fraction without trailing zeros', () => {
    expect(formatUnits(ETHER + ETHER / 2n)).toBe('1.5')
    expect(formatUnits(ETHER / 4n)).toBe('0.25')
  })

  it('truncates rather than rounds', () => {
    expect(formatUnits(ETHER - 1n)).toBe('0.999999')
    expect(formatUnits(1n)).toBe('0')
    expect(formatUnits(1n, 18, 18)).toBe('0.000000000000000001')
  })

  it('handles other decimals and negatives', () => {
    expect(formatUnits(1_500_000_000n, 9)).toBe('1.5')
    expect(formatUnits(-ETHER)).toBe('-1')
    expect(formatUnits(42n, 0)).toBe('42')
  })

  it('has ether and gwei spellings', () => {
    expect(formatEther(2n * ETHER)).toBe('2')
    expect(formatGwei(1_000_000_000n)).toBe('1 gwei')
    expect(formatGwei(7n)).toBe('7 wei')
    expect(formatGwei(1_500_000n)).toBe('0.001 gwei')
  })
})

describe('withCommas', () => {
  it('groups both kinds of number', () => {
    expect(withCommas(67_200)).toBe('67,200')
    expect(withCommas(10_000n)).toBe('10,000')
  })
})

describe('shortHash', () => {
  const hash = `0x${'ab'.repeat(32)}`

  it('keeps the ends', () => {
    expect(shortHash(hash)).toBe('0xababab…abab')
    expect(shortHash(hash, 10)).toBe('0xabababab…abab')
  })

  it('leaves short values and empties alone', () => {
    expect(shortHash('0x1234')).toBe('0x1234')
    expect(shortHash('')).toBe('—')
  })
})

describe('durations', () => {
  it('ages a timestamp coarsely', () => {
    const now = 1_000_000 * 1000
    expect(age(1_000_000, now)).toBe('0s')
    expect(age(1_000_000 - 59, now)).toBe('59s')
    expect(age(1_000_000 - 60, now)).toBe('1m')
    expect(age(1_000_000 - 3600, now)).toBe('1h')
    expect(age(1_000_010, now)).toBe('0s')
  })

  it('says how long ago with the right precision', () => {
    expect(ago(400)).toBe('0.4s')
    expect(ago(12_000)).toBe('12s')
    expect(ago(185_000)).toBe('3m 05s')
    expect(ago(3_660_000)).toBe('1h 01m')
    expect(ago(-5)).toBe('0.0s')
  })

  it('counts down in minutes and seconds', () => {
    expect(mmss(0)).toBe('now')
    expect(mmss(59)).toBe('59s')
    expect(mmss(65)).toBe('1m 05s')
  })
})
