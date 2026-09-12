import { describe, expect, it } from 'vitest'
import { CONTRACTS, DEV_ACCOUNTS, label } from './known'

describe('the known addresses', () => {
  it('are well formed and distinct', () => {
    const all = [...DEV_ACCOUNTS.map((a) => a.address), ...CONTRACTS.map((c) => c.address)]
    for (const address of all) expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(new Set(all.map((a) => a.toLowerCase())).size).toBe(all.length)
  })

  it('keep contract addresses lowercase, as genesis does', () => {
    for (const contract of CONTRACTS) expect(contract.address).toBe(contract.address.toLowerCase())
  })

  it('carry four accounts, each with its key', () => {
    expect(DEV_ACCOUNTS).toHaveLength(4)
    for (const account of DEV_ACCOUNTS) expect(account.key).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('label', () => {
  it('names accounts and contracts in any case', () => {
    expect(label('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe('account 0')
    expect(label('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')).toBe('account 0')
    expect(label('0x90F79bf6EB2c4f870365E785982E1f101E93b906')).toBe('account 3')
    expect(label('0x00000000000000000000000000000000C0DE4626')).toBe('Vault')
  })

  it('has nothing to say about strangers', () => {
    expect(label('0x0000000000000000000000000000000000000000')).toBeUndefined()
    expect(label(undefined)).toBeUndefined()
    expect(label('')).toBeUndefined()
  })
})
