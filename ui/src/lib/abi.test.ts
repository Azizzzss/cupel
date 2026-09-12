import { describe, expect, it } from 'vitest'
import { SELECTOR, decodeAddress, decodeBool, decodeString, decodeUint, encodeCall, word } from './abi'
import { padWord } from './hex'

const ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

/** What a contract returns for a `string`: offset, length, bytes padded to a word. */
function abiString(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const digits = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  const padded = digits.padEnd(Math.ceil(digits.length / 64) * 64, '0')
  return `0x${padWord('20')}${padWord(bytes.length.toString(16))}${padded}`
}

describe('encodeCall', () => {
  it('is the selector alone with no arguments', () => {
    expect(encodeCall(SELECTOR.totalSupply)).toBe('0x18160ddd')
  })

  it('pads an address to a word, lowercased', () => {
    expect(encodeCall(SELECTOR.balanceOf, [{ kind: 'address', value: ACCOUNT_0 }])).toBe(
      `0x70a08231${'0'.repeat(24)}f39fd6e51aad88f6f4ce6ab8827279cfffb92266`,
    )
  })

  it('pads a uint256 to a word', () => {
    expect(encodeCall('0xabcdef01', [{ kind: 'uint256', value: 1000n }])).toBe(
      `0xabcdef01${padWord('3e8')}`,
    )
  })
})

describe('decoding words', () => {
  const two = `0x${padWord('3e8')}${padWord('1')}`

  it('reads the word asked for', () => {
    expect(decodeUint(two)).toBe(1000n)
    expect(decodeUint(two, 1)).toBe(1n)
    expect(word(two, 2)).toBeUndefined()
  })

  it('reads an address from the low twenty bytes', () => {
    const data = `0x${padWord('f39fd6e51aad88f6f4ce6ab8827279cfffb92266')}`
    expect(decodeAddress(data)).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
  })

  it('reads a bool', () => {
    expect(decodeBool(`0x${padWord('1')}`)).toBe(true)
    expect(decodeBool(`0x${padWord('0')}`)).toBe(false)
    expect(decodeBool('0x')).toBeUndefined()
  })

  it('never throws on garbage', () => {
    expect(decodeUint('not hex')).toBeUndefined()
    expect(decodeUint('0x12')).toBeUndefined()
    expect(decodeAddress('')).toBeUndefined()
  })
})

describe('decodeString', () => {
  it('reads a short string', () => {
    expect(decodeString(abiString('Cupel Token'))).toBe('Cupel Token')
    expect(decodeString(abiString('CUP'))).toBe('CUP')
  })

  it('reads the empty string', () => {
    expect(decodeString(abiString(''))).toBe('')
  })

  it('reads a string that spans two words', () => {
    const long = 'abcdefghijklmnopqrstuvwxyz0123456'
    expect(long).toHaveLength(33)
    expect(decodeString(abiString(long))).toBe(long)
  })

  it('returns undefined rather than half a string', () => {
    // Eleven bytes of text and forty-two digits of padding: cutting fifty
    // digits reaches into the text itself, not just the padding after it.
    const whole = abiString('Cupel Token')
    expect(decodeString(whole.slice(0, whole.length - 50))).toBeUndefined()
    expect(decodeString('0x')).toBeUndefined()
    expect(decodeString(`0x${padWord('21')}`)).toBeUndefined()
  })
})
