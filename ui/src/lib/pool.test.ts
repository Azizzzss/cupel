import { describe, expect, it } from 'vitest'
import { parsePool, queuedSenders, remember, timeInPool, track, waitingFor, type Pool, type Sighting } from './pool'

const A = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const B = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'
const TOKEN = '0x00000000000000000000000000000000c0de0020'

function raw(from: string, nonce: number, hash: string, input = '0x', to = TOKEN) {
  return {
    hash,
    from,
    to,
    value: '0x0',
    gas: '0x186a0',
    nonce: `0x${nonce.toString(16)}`,
    input,
    blockNumber: null,
    maxFeePerGas: '0x3b9aca0e',
    maxPriorityFeePerGas: '0x3b9aca00',
    type: '0x2',
  }
}

describe('parsePool', () => {
  it('reads both lists, sorted by sender and then nonce', () => {
    const pool = parsePool({
      pending: {
        [B]: { '7': raw(B, 7, '0xb7') },
        [A]: { '5': raw(A, 5, '0xa5', '0xa9059cbb00'), '4': raw(A, 4, '0xa4') },
      },
      queued: { [B]: { '9': raw(B, 9, '0xb9') } },
    })
    // 0x90f… before 0xf39…, and each sender's nonces in order.
    expect(pool?.pending.map((tx) => tx.hash)).toEqual(['0xb7', '0xa4', '0xa5'])
    expect(pool?.queued.map((tx) => [tx.hash, tx.state])).toEqual([['0xb9', 'queued']])
    // Decoded where the page can tell.
    expect(pool?.pending[2].what).toBe('Token.transfer')
    expect(pool?.pending[0].blockNumber).toBeUndefined()
  })

  it('treats an empty pool as an answer, and a malformed one as none', () => {
    expect(parsePool({ pending: {}, queued: {} })).toEqual({ pending: [], queued: [] })
    expect(parsePool({})).toEqual({ pending: [], queued: [] })
    expect(parsePool(null)).toBeUndefined()
    expect(parsePool({ pending: 'nope', queued: {} })).toBeUndefined()
  })

  it('skips an entry it cannot read rather than failing the whole pool', () => {
    const pool = parsePool({ pending: { [A]: { '1': { hash: '0x1' }, '2': raw(A, 2, '0xa2') } }, queued: {} })
    expect(pool?.pending.map((tx) => tx.hash)).toEqual(['0xa2'])
  })
})

describe('waitingFor', () => {
  const pool = (pending: [string, number][], queued: [string, number][]): Pool =>
    parsePool({
      pending: Object.fromEntries(
        [...new Set(pending.map(([f]) => f))].map((f) => [
          f,
          Object.fromEntries(pending.filter(([g]) => g === f).map(([, n]) => [n, raw(f, n, `0x${f.slice(2, 4)}p${n}`)])),
        ]),
      ),
      queued: Object.fromEntries(
        [...new Set(queued.map(([f]) => f))].map((f) => [
          f,
          Object.fromEntries(queued.filter(([g]) => g === f).map(([, n]) => [n, raw(f, n, `0x${f.slice(2, 4)}q${n}`)])),
        ]),
      ),
    }) as Pool

  it('names the gap after the last pending nonce', () => {
    // Nonces 3 and 4 are ready; 6 arrived without 5.
    const p = pool([[A, 3], [A, 4]], [[A, 6]])
    expect(waitingFor(p, {}).get('0xf3q6')).toBe(5)
  })

  it('uses the chain nonce when nothing from the sender is pending', () => {
    const p = pool([], [[B, 9]])
    expect(waitingFor(p, { [B.toLowerCase()]: 8 }).get('0x90q9')).toBe(8)
  })

  it('says nothing when it does not know the account nonce', () => {
    const p = pool([], [[B, 9]])
    expect(waitingFor(p, {}).has('0x90q9')).toBe(false)
  })

  it('lists the senders worth asking about, once each', () => {
    const p = pool([[A, 1]], [[B, 4], [B, 5]])
    expect(queuedSenders(p)).toEqual([B.toLowerCase()])
    expect(queuedSenders(undefined)).toEqual([])
  })
})

describe('track', () => {
  const one = parsePool({ pending: { [A]: { '1': raw(A, 1, '0x1') } }, queued: { [B]: { '5': raw(B, 5, '0x5') } } }) as Pool
  const later = parsePool({ pending: { [B]: { '5': raw(B, 5, '0x5') } }, queued: {} }) as Pool

  it('keeps when a transaction was first seen, and whether it ever queued', () => {
    const first = track(new Map(), one, 1_000)
    expect(first.left).toEqual([])
    const second = track(first.seen, later, 2_500)
    expect(second.seen.get('0x5')?.firstSeen).toBe(1_000)
    // Queued once, now pending: it still counts as having waited on a gap.
    expect(second.seen.get('0x5')?.wasQueued).toBe(true)
  })

  it('reports what left, and when', () => {
    const first = track(new Map(), one, 1_000)
    const second = track(first.seen, later, 2_500)
    expect(second.left).toHaveLength(1)
    expect(second.left[0]).toMatchObject({ hash: '0x1', firstSeen: 1_000, leftAt: 2_500 })
  })

  it('times a stay as the bounds the readings allow, never a made-up midpoint', () => {
    // Readings at 750 (empty), 1000 and 1250 (it is there), 1260 (gone).
    const empty = parsePool({ pending: {}, queued: {} }) as Pool
    const a = track(new Map(), empty, 750)
    const b = track(a.seen, one, 1_000, 750)
    const c = track(b.seen, one, 1_250, 1_000)
    const d = track(c.seen, empty, 1_260, 1_250)
    const gone = d.left.find((s) => s.hash === '0x1') as Sighting
    // At least from first to last sighting; at most from the reading before
    // it arrived to the reading that found it gone.
    expect(timeInPool(gone)).toEqual({ least: 250, most: 510 })
  })

  it('has no upper bound for something already there when the page first looked', () => {
    const first = track(new Map(), one, 1_000)
    const gone = track(first.seen, parsePool({}) as Pool, 1_300, 1_000).left[0]
    expect(timeInPool(gone)).toEqual({ least: 0, most: undefined })
  })

  it('remembers a bounded, newest-first history', () => {
    const s = (n: number): Sighting => ({
      hash: `0x${n}`,
      from: A,
      nonce: n,
      firstSeen: 0,
      lastSeen: 0,
      wasQueued: false,
      leftAt: 1,
    })
    let history: Sighting[] = []
    for (let n = 0; n < 20; n++) history = remember(history, [s(n)], 12)
    expect(history).toHaveLength(12)
    expect(history[0].nonce).toBe(19)
    expect(remember(history, [])).toBe(history)
  })
})
