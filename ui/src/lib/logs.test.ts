import { describe, expect, it } from 'vitest'
import { padWord } from './hex'
import { TOPIC, decodeLog } from './logs'

const A = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const B = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
const C = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'

const topic = (address: string) => `0x${padWord(address.slice(2))}`
const words = (...values: bigint[]) => `0x${values.map((v) => padWord(v.toString(16))).join('')}`
const ONE_THOUSAND = 1000n * 10n ** 18n

describe('decodeLog', () => {
  it('reads a Transfer', () => {
    const decoded = decodeLog({
      topics: [TOPIC.transfer, topic(A), topic(B)],
      data: words(ONE_THOUSAND),
    })
    expect(decoded).toEqual({
      event: 'Transfer',
      args: [
        { name: 'from', kind: 'address', value: A },
        { name: 'to', kind: 'address', value: B },
        { name: 'value', kind: 'uint256', value: ONE_THOUSAND },
      ],
    })
  })

  it('reads an Approval', () => {
    const decoded = decodeLog({ topics: [TOPIC.approval, topic(A), topic(B)], data: words(5n) })
    expect(decoded?.event).toBe('Approval')
    expect(decoded?.args.map((a) => a.name)).toEqual(['owner', 'spender', 'value'])
  })

  it('reads wrapped ether going in and out', () => {
    const deposit = decodeLog({ topics: [TOPIC.wethDeposit, topic(A)], data: words(7n) })
    expect(deposit).toEqual({
      event: 'Deposit',
      args: [
        { name: 'to', kind: 'address', value: A },
        { name: 'value', kind: 'uint256', value: 7n },
      ],
    })
    const withdrawal = decodeLog({ topics: [TOPIC.wethWithdrawal, topic(A)], data: words(7n) })
    expect(withdrawal?.event).toBe('Withdrawal')
    expect(withdrawal?.args[0]).toEqual({ name: 'from', kind: 'address', value: A })
  })

  it('reads the vault, whose events carry two amounts', () => {
    const deposit = decodeLog({
      topics: [TOPIC.vaultDeposit, topic(A), topic(B)],
      data: words(100n, 99n),
    })
    expect(deposit?.event).toBe('Deposit')
    expect(deposit?.args.map((a) => [a.name, a.value])).toEqual([
      ['caller', A],
      ['owner', B],
      ['assets', 100n],
      ['shares', 99n],
    ])

    const withdraw = decodeLog({
      topics: [TOPIC.vaultWithdraw, topic(A), topic(B), topic(C)],
      data: words(100n, 99n),
    })
    expect(withdraw?.event).toBe('Withdraw')
    expect(withdraw?.args.map((a) => a.name)).toEqual([
      'caller',
      'receiver',
      'owner',
      'assets',
      'shares',
    ])
  })

  it('matches the hash whatever its case', () => {
    const decoded = decodeLog({
      topics: [TOPIC.transfer.toUpperCase().replace('0X', '0x'), topic(A), topic(B)],
      data: words(1n),
    })
    expect(decoded?.event).toBe('Transfer')
  })

  it('leaves what it does not know alone', () => {
    expect(decodeLog({ topics: [`0x${'ab'.repeat(32)}`, topic(A)], data: words(1n) })).toBeUndefined()
    expect(decodeLog({ topics: [], data: '0x' })).toBeUndefined()
  })

  it('refuses a shape that does not match its hash', () => {
    // A Transfer with one indexed address is not a Transfer.
    expect(decodeLog({ topics: [TOPIC.transfer, topic(A)], data: words(1n) })).toBeUndefined()
    // A vault Deposit with only one amount.
    expect(
      decodeLog({ topics: [TOPIC.vaultDeposit, topic(A), topic(B)], data: words(100n) }),
    ).toBeUndefined()
    // A topic that is not a word.
    expect(decodeLog({ topics: [TOPIC.transfer, '0x1234', topic(B)], data: words(1n) })).toBeUndefined()
  })
})
