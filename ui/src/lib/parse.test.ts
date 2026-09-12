import { describe, expect, it } from 'vitest'
import { parseBlock, parseReceipt, parseTx } from './parse'

const TX = {
  hash: '0x' + 'ab'.repeat(32),
  from: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  to: '0x00000000000000000000000000000000c0de0020',
  value: '0x0',
  gas: '0x1b58e',
  nonce: '0x3',
  transactionIndex: '0x0',
  blockNumber: '0x3e8',
  blockHash: '0x' + 'cd'.repeat(32),
  input: '0x40c10f19',
  type: '0x2',
  maxFeePerGas: '0x3b9aca07',
  maxPriorityFeePerGas: '0x1',
}

describe('parseTx', () => {
  it('reads a mined transaction', () => {
    const tx = parseTx(TX)
    expect(tx?.hash).toBe(TX.hash)
    expect(tx?.to).toBe(TX.to)
    expect(tx?.value).toBe(0n)
    expect(tx?.gas).toBe(112_014)
    expect(tx?.nonce).toBe(3)
    expect(tx?.blockNumber).toBe(1000)
    expect(tx?.type).toBe(2)
    expect(tx?.maxFeePerGas).toBe(1_000_000_007n)
    expect(tx?.maxPriorityFeePerGas).toBe(1n)
    expect(tx?.gasPrice).toBeUndefined()
    expect(tx?.raw).toBe(TX)
  })

  it('reads a pending one, with no block yet', () => {
    const tx = parseTx({ ...TX, blockNumber: null, blockHash: null, transactionIndex: null })
    expect(tx?.blockNumber).toBeUndefined()
    expect(tx?.blockHash).toBeUndefined()
    expect(tx?.index).toBeUndefined()
  })

  it('reads a contract creation, whose to is null', () => {
    expect(parseTx({ ...TX, to: null })?.to).toBeUndefined()
  })

  it('refuses what is not a transaction', () => {
    expect(parseTx(null)).toBeUndefined()
    expect(parseTx('0xabc')).toBeUndefined()
    expect(parseTx({ ...TX, value: 'lots' })).toBeUndefined()
  })
})

describe('parseBlock', () => {
  const BLOCK = {
    number: '0x3e8',
    hash: '0x' + 'cd'.repeat(32),
    parentHash: '0x' + 'ef'.repeat(32),
    timestamp: '0x68c3f2a0',
    gasUsed: '0x1b58e',
    gasLimit: '0x1c9c380',
    baseFeePerGas: '0x7',
    miner: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    extraData: '0x637570656c',
    stateRoot: '0x' + '12'.repeat(32),
    size: '0x2f0',
    transactions: [TX, 'not a transaction'],
  }

  it('reads the header and the transactions it can', () => {
    const block = parseBlock(BLOCK)
    expect(block?.number).toBe(1000)
    expect(block?.gasLimit).toBe(30_000_000)
    expect(block?.baseFeePerGas).toBe(7n)
    expect(block?.size).toBe(752)
    expect(block?.transactions).toHaveLength(1)
    expect(block?.transactions[0].hash).toBe(TX.hash)
  })

  it('treats a header fetched without bodies as having no transactions', () => {
    expect(parseBlock({ ...BLOCK, transactions: [TX.hash] })?.transactions).toEqual([])
  })

  it('refuses a block missing what a block has', () => {
    expect(parseBlock(null)).toBeUndefined()
    expect(parseBlock({ ...BLOCK, number: undefined })).toBeUndefined()
  })
})

describe('parseReceipt', () => {
  const RECEIPT = {
    status: '0x1',
    gasUsed: '0xd6a8',
    effectiveGasPrice: '0x8',
    contractAddress: null,
    logs: [
      {
        address: '0x00000000000000000000000000000000c0de0020',
        topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
        data: '0x',
        logIndex: '0x0',
      },
      { address: 'no topics' },
    ],
  }

  it('reads status, gas, fee and logs', () => {
    const receipt = parseReceipt(RECEIPT)
    expect(receipt?.status).toBe(true)
    expect(receipt?.gasUsed).toBe(54_952)
    expect(receipt?.effectiveGasPrice).toBe(8n)
    expect(receipt?.contractAddress).toBeUndefined()
    expect(receipt?.logs).toHaveLength(1)
    expect(receipt?.logs[0].logIndex).toBe(0)
  })

  it('reads a failed one', () => {
    expect(parseReceipt({ ...RECEIPT, status: '0x0' })?.status).toBe(false)
  })

  it('refuses what is not a receipt', () => {
    expect(parseReceipt(null)).toBeUndefined()
    expect(parseReceipt({ status: '0x1' })).toBeUndefined()
  })
})
