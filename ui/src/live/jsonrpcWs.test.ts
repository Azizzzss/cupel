import { describe, expect, it } from 'vitest'
import { SUBSCRIBE_NEW_HEADS, parseWsFrame } from './jsonrpcWs'

describe('the subscription request', () => {
  it('is the exact frame geth expects', () => {
    expect(SUBSCRIBE_NEW_HEADS).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["newHeads"]}',
    )
  })
})

describe('parseWsFrame', () => {
  it('recognises the acknowledgement', () => {
    expect(
      parseWsFrame('{"jsonrpc":"2.0","id":1,"result":"0x9ce59a13059e417087c02d3236a0b1cc"}'),
    ).toEqual({ kind: 'subscribed', id: '0x9ce59a13059e417087c02d3236a0b1cc' })
  })

  it('reads a new head', () => {
    const frame = JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_subscription',
      params: {
        subscription: '0x9ce59a13059e417087c02d3236a0b1cc',
        result: { number: '0x1b4', hash: '0xabc', parentHash: '0xdef', gasUsed: '0x0' },
      },
    })
    expect(parseWsFrame(frame)).toEqual({ kind: 'head', number: 436, hash: '0xabc', parentHash: '0xdef' })
  })

  it('reports a refused subscription', () => {
    const frame = '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"the method eth_subscribe does not exist/is not available"}}'
    expect(parseWsFrame(frame)).toEqual({
      kind: 'error',
      message: 'the method eth_subscribe does not exist/is not available',
    })
    expect(parseWsFrame('{"jsonrpc":"2.0","id":1,"error":{}}')).toEqual({
      kind: 'error',
      message: 'subscription refused',
    })
  })

  it('shrugs at everything else', () => {
    expect(parseWsFrame('not json')).toEqual({ kind: 'other' })
    expect(parseWsFrame('null')).toEqual({ kind: 'other' })
    expect(parseWsFrame('{"jsonrpc":"2.0","id":7,"result":"0x1"}')).toEqual({ kind: 'other' })
    expect(parseWsFrame('{"method":"eth_subscription","params":{"result":{"hash":"0x1"}}}')).toEqual({
      kind: 'other',
    })
  })
})
