import { describe, expect, it } from 'vitest'
import { hexToBigInt, hexToNumber, isHex, padWord, strip0x, utf8FromHex } from './hex'

describe('hexToNumber', () => {
  it('reads a quantity', () => {
    expect(hexToNumber('0x1b4')).toBe(436)
    expect(hexToNumber('0x0')).toBe(0)
  })

  it('rejects everything that is not a hex string', () => {
    expect(hexToNumber(436)).toBeUndefined()
    expect(hexToNumber(undefined)).toBeUndefined()
    expect(hexToNumber('zz')).toBeUndefined()
    expect(hexToNumber('0x12zz')).toBeUndefined()
    expect(hexToNumber('0x')).toBeUndefined()
  })
})

describe('hexToBigInt', () => {
  it('is exact at 32 bytes', () => {
    expect(hexToBigInt(`0x${'ff'.repeat(32)}`)).toBe(2n ** 256n - 1n)
    expect(hexToBigInt('0x21e19e0c9bab2400000')).toBe(10_000n * 10n ** 18n)
  })

  it('rejects garbage', () => {
    expect(hexToBigInt('0x')).toBeUndefined()
    expect(hexToBigInt('10')).toBeUndefined()
  })
})

describe('padWord and strip0x', () => {
  it('pads to 64 digits', () => {
    expect(padWord('1')).toBe(`${'0'.repeat(63)}1`)
    expect(padWord('a'.repeat(64))).toBe('a'.repeat(64))
  })

  it('strips a prefix in either case', () => {
    expect(strip0x('0xab')).toBe('ab')
    expect(strip0x('0Xab')).toBe('ab')
    expect(strip0x('ab')).toBe('ab')
  })

  it('knows what is hex', () => {
    expect(isHex('0x')).toBe(true)
    expect(isHex('0xAbC')).toBe(true)
    expect(isHex('AbC')).toBe(false)
    expect(isHex(12)).toBe(false)
  })
})

describe('utf8FromHex', () => {
  it('reads text', () => {
    expect(utf8FromHex('0x637570656c')).toBe('cupel')
    expect(utf8FromHex('0x')).toBe('')
  })

  it('refuses bytes that are not text', () => {
    expect(utf8FromHex('0xff')).toBeUndefined()
    expect(utf8FromHex('0x00')).toBeUndefined()
    expect(utf8FromHex('0xabc')).toBeUndefined()
    expect(utf8FromHex('nope')).toBeUndefined()
  })
})
