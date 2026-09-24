import { describe, expect, it } from 'vitest'
import genesisText from '../../../config/genesis/genesis.json?raw'
import {
  FUNCTIONS,
  SELECTOR,
  decodeAddress,
  decodeBool,
  decodeString,
  decodeUint,
  describeCall,
  encodeCall,
  word,
} from './abi'
import { padWord } from './hex'
import { CONTRACTS } from './known'

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

/** The runtime bytecode of each genesis contract, from the committed genesis. */
const CODE: Record<string, string> = (() => {
  const alloc = (JSON.parse(genesisText) as { alloc: Record<string, { code?: string }> }).alloc
  const byName: Record<string, string> = {}
  for (const contract of CONTRACTS) byName[contract.name] = (alloc[contract.address]?.code ?? '').toLowerCase()
  return byName
})()

/** Whether a contract dispatches on a selector: Solidity compares against it with a PUSH4. */
function dispatches(contract: string, selector: string): boolean {
  return CODE[contract]?.includes(`63${selector.slice(2)}`) ?? false
}

describe('selectors, against the deployed bytecode', () => {
  // The constants were typed in by hand, and a wrong one fails quietly: the
  // call lands on no function, returns nothing, and the page shows a dash.
  // The genesis file is the bytecode the chain actually runs.
  it('finds every contract in genesis', () => {
    for (const contract of CONTRACTS) expect(CODE[contract.name]?.length ?? 0).toBeGreaterThan(100)
  })

  it('has every read the page makes', () => {
    for (const key of ['name', 'symbol', 'decimals', 'totalSupply', 'balanceOf'] as const) {
      expect(dispatches('Token', SELECTOR[key]), key).toBe(true)
    }
    expect(dispatches('Vault', SELECTOR.asset)).toBe(true)
    expect(dispatches('Vault', SELECTOR.totalAssets)).toBe(true)
  })

  it('has every function the pool names, on the contract it names it for', () => {
    const where: Record<string, string[]> = {
      '0xa9059cbb': ['Token', 'Vault', 'Weth'],
      '0x23b872dd': ['Token', 'Weth'],
      '0x095ea7b3': ['Token', 'Vault', 'Weth'],
      '0xd505accf': ['Token'],
      '0x40c10f19': ['Token'],
      '0x42966c68': ['Token'],
      '0xd0e30db0': ['Weth'],
      '0x2e1a7d4d': ['Weth'],
      '0x6e553f65': ['Vault'],
      '0xba087652': ['Vault'],
    }
    expect(Object.keys(where).sort()).toEqual(Object.keys(FUNCTIONS).sort())
    for (const [selector, contracts] of Object.entries(where)) {
      for (const contract of contracts) expect(dispatches(contract, selector), `${contract} ${selector}`).toBe(true)
    }
  })

  it('would notice a wrong one', () => {
    expect(dispatches('Token', '0xdeadbeef')).toBe(false)
    expect(dispatches('Weth', '0x40c10f19')).toBe(false)
  })
})

describe('describeCall', () => {
  const token = '0x00000000000000000000000000000000c0de0020'
  const vault = '0x00000000000000000000000000000000c0de4626'
  const weth = '0x00000000000000000000000000000000c0de0009'

  it('names a known function on a known contract', () => {
    expect(describeCall(token, `0xa9059cbb${padWord('1')}`)).toBe('Token.transfer')
    expect(describeCall(vault, '0x6E553F65')).toBe('Vault.deposit')
  })

  it('tells a payment from ether sent to a contract', () => {
    expect(describeCall(ACCOUNT_0, '0x')).toBe('ether payment')
    expect(describeCall('0x1234567890123456789012345678901234567890', '0x')).toBe('ether payment')
    expect(describeCall(weth, '0x')).toBe('Weth (receive)')
  })

  it('says nothing rather than guess', () => {
    expect(describeCall(token, '0xdeadbeef')).toBeUndefined()
    expect(describeCall(undefined, '0x6080')).toBe('contract creation')
    // A known selector sent to a stranger is named without a contract.
    expect(describeCall('0x1234567890123456789012345678901234567890', '0xa9059cbb')).toBe('transfer')
  })
})
