import { describe, expect, it } from 'vitest'
import type { BeaconState } from '../api/chain'
import { unreachableRow, verdict, type Row } from './verdict'

function state(finalized: number, root = `root-${finalized}`): BeaconState {
  return {
    headSlot: 100,
    syncing: false,
    justified: finalized + 1,
    finalized,
    finalizedRoot: root,
    peers: 2,
    secondsPerSlot: 12,
    slotsPerEpoch: 32,
    genesisTime: 0,
  }
}

function row(name: string, beacon: BeaconState): Row {
  return {
    name,
    consensus: name,
    execution: { ok: true, value: { number: 1, hash: '0x1', transactions: 0, timestamp: 0, gasUsed: 0 } },
    beacon: { ok: true, value: beacon },
  }
}

describe('verdict', () => {
  it('is idle when nobody answers', () => {
    const rows = [unreachableRow('node1', 'Lighthouse'), unreachableRow('node2', 'Prysm')]
    expect(verdict(rows)).toEqual({ text: 'no clients reachable', kind: 'pill-idle' })
  })

  it('is patient before the first finalised epoch', () => {
    expect(verdict([row('a', state(0)), row('b', state(0))])).toEqual({
      text: 'nothing finalised yet',
      kind: 'pill-working',
    })
    expect(verdict([row('a', state(0)), unreachableRow('b', 'Prysm')]).text).toBe(
      'nothing finalised yet · 1 not answering',
    )
  })

  it('alarms only on different roots for the same epoch', () => {
    const rows = [row('a', state(7, 'x')), row('b', state(7, 'y')), row('c', state(7, 'x'))]
    expect(verdict(rows)).toEqual({ text: 'the clients disagree', kind: 'pill-wrong' })
  })

  it('calls a lower epoch behind, not wrong', () => {
    expect(verdict([row('a', state(7)), row('b', state(5)), row('c', state(7))])).toEqual({
      text: 'one chain · 1 behind by up to 2 epochs',
      kind: 'pill-working',
    })
    expect(verdict([row('a', state(7)), row('b', state(6))]).text).toBe(
      'one chain · 1 behind by up to 1 epoch',
    )
  })

  it('names the ones still waiting and the ones not answering', () => {
    expect(verdict([row('a', state(7)), row('b', state(0))]).text).toBe(
      'one chain · 1 not finalised yet',
    )
    expect(verdict([row('a', state(7)), row('b', state(7)), unreachableRow('c', 'Teku')]).text).toBe(
      'one chain · 1 not answering',
    )
  })

  it('agrees when every client says the same', () => {
    expect(verdict([row('a', state(7)), row('b', state(7)), row('c', state(7))])).toEqual({
      text: 'three clients, one chain',
      kind: 'pill-agree',
    })
    expect(verdict([row('a', state(7))]).text).toBe('one clients, one chain')
  })

  it('never counts a row substituted as unreachable toward agreement', () => {
    // A stale row is handed in as unreachable, so it is "not answering" —
    // never a silent vote for whichever root it last reported.
    const stale = unreachableRow('c', 'Teku')
    expect(verdict([row('a', state(7, 'x')), row('b', state(7, 'x')), stale]).kind).toBe('pill-working')
  })
})
