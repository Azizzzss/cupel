import { describe, expect, it } from 'vitest'
import { EVENTS_PATH, parseBeaconEvent } from './beaconEvents'

describe('parseBeaconEvent', () => {
  it('asks for exactly the two topics it understands', () => {
    expect(EVENTS_PATH).toBe('/eth/v1/events?topics=head,finalized_checkpoint')
  })

  it('reads a head', () => {
    const data =
      '{"slot":"10","block":"0x9a2f","state":"0x600e","epoch_transition":false,"execution_optimistic":false}'
    expect(parseBeaconEvent('head', data)).toEqual({ kind: 'head', slot: 10, block: '0x9a2f' })
  })

  it('reads a finalised checkpoint', () => {
    const data = '{"block":"0x9a2f","state":"0x600e","epoch":"2","execution_optimistic":false}'
    expect(parseBeaconEvent('finalized_checkpoint', data)).toEqual({
      kind: 'finalized',
      epoch: 2,
      block: '0x9a2f',
    })
  })

  it('ignores what it did not ask for and what it cannot read', () => {
    expect(parseBeaconEvent('attestation', '{"slot":"1"}')).toBeUndefined()
    expect(parseBeaconEvent('head', 'not json')).toBeUndefined()
    expect(parseBeaconEvent('head', '{"slot":10}')).toBeUndefined()
    expect(parseBeaconEvent('finalized_checkpoint', '{"block":"0x1"}')).toBeUndefined()
  })
})
