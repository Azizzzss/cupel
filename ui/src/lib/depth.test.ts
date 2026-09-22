import { describe, expect, it } from 'vitest'
import type { ExecutionHead } from '../api/chain'
import {
  busiestGas,
  cameraDistance,
  heightFor,
  lane,
  laneCentre,
  laneDepth,
  SPACING,
  sameHash,
  standing,
} from './depth'

function block(number: number, gasUsed = 0, hash = `0x${number.toString(16)}`): ExecutionHead {
  return { number, hash, transactions: 0, timestamp: number, gasUsed }
}

describe('heightFor', () => {
  it('gives an empty block a floor rather than nothing', () => {
    const empty = heightFor(0, 30_000_000)
    expect(empty).toBeGreaterThan(0)
    // A block that used nothing is still visible, and still the shortest.
    expect(empty).toBeLessThan(heightFor(1, 30_000_000))
  })

  it('puts the busiest block in view at full height', () => {
    expect(heightFor(21_000, 21_000)).toBeCloseTo(heightFor(999, 999))
  })

  it('does not let one heavy block flatten the rest', () => {
    // Straight scaling would put a block using a thousandth of the gas at a
    // thousandth of the height, which is the floor for every one of them.
    const small = heightFor(30_000, 30_000_000)
    const large = heightFor(30_000_000, 30_000_000)
    expect(small / large).toBeGreaterThan(0.05)
  })

  it('survives a window with no gas in it at all', () => {
    expect(Number.isFinite(heightFor(0, 0))).toBe(true)
  })

  it('cannot exceed full height when a block is somehow busier than the busiest', () => {
    expect(heightFor(50, 10)).toBeCloseTo(heightFor(10, 10))
  })
})

describe('busiestGas', () => {
  it('is zero for a chain nobody has used', () => {
    // The ordinary state of a fresh lab: blocks every second, all of them
    // empty. The page says so rather than drawing fifty identical slabs.
    expect(busiestGas([block(3), block(2), block(1)])).toBe(0)
    expect(busiestGas([])).toBe(0)
  })

  it('finds the heaviest block in the window', () => {
    expect(busiestGas([block(3, 21_000), block(2, 900_000), block(1, 0)])).toBe(900_000)
  })
})

describe('lane', () => {
  it('runs the newest block away from the camera', () => {
    const placed = lane([block(9), block(8), block(7)])
    expect(placed.map((p) => p.number)).toEqual([9, 8, 7])
    expect(placed.map((p) => p.z)).toEqual([0, -SPACING, -2 * SPACING])
  })

  it('fades from the front of the lane to the back', () => {
    const placed = lane([block(3), block(2), block(1)])
    expect(placed[0].fade).toBe(0)
    expect(placed[2].fade).toBe(1)
  })

  it('places a single block without dividing by zero', () => {
    const placed = lane([block(1)])
    expect(placed).toHaveLength(1)
    expect(Number.isFinite(placed[0].fade)).toBe(true)
  })

  it('has nothing to place for an empty window', () => {
    expect(lane([])).toEqual([])
    expect(laneDepth(0)).toBe(0)
  })
})

describe('cameraDistance', () => {
  it('stands outside the lane rather than inside it', () => {
    // The camera looks at the middle of the lane, so anything less than half
    // the length puts it among the blocks: the first version backed off by a
    // fifth of a fifty-block window and framed four boxes.
    for (const count of [1, 5, 20, 50, 200]) {
      expect(cameraDistance(count)).toBeGreaterThan(laneCentre(count) + 2)
    }
  })

  it('backs off further as the lane grows', () => {
    expect(cameraDistance(50)).toBeGreaterThan(cameraDistance(10))
    expect(cameraDistance(10)).toBeGreaterThan(cameraDistance(1))
  })

  it('can see the whole of it', () => {
    // Far enough that the length of the lane fits in front of the camera.
    for (const count of [2, 12, 50]) {
      expect(cameraDistance(count)).toBeGreaterThan(laneDepth(count))
    }
  })
})

describe('standing', () => {
  const placed = lane([block(9), block(8), block(7)])

  it('calls a client on the same block at the same hash agreed', () => {
    expect(standing(placed, { number: 8, hash: '0x8' })).toBe('same')
  })

  it('ignores the case a client spells its hash in', () => {
    expect(standing(placed, { number: 8, hash: '0X8' })).toBe('same')
    expect(sameHash('0xAbC', '0xabc')).toBe(true)
  })

  it('only calls it a disagreement at the same number', () => {
    // The one alarming answer: same slot in the chain, different block.
    expect(standing(placed, { number: 8, hash: '0xdifferent' })).toBe('different')
  })

  it('separates ahead and behind from disagreeing', () => {
    // A client a block ahead has not disagreed with anything — it has seen
    // something this window has not caught up with yet.
    expect(standing(placed, { number: 12, hash: '0xc' })).toBe('ahead')
    expect(standing(placed, { number: 2, hash: '0x2' })).toBe('behind')
  })

  it('says nothing about a client that did not answer', () => {
    expect(standing(placed, undefined)).toBe('silent')
    expect(standing([], { number: 8, hash: '0x8' })).toBe('silent')
  })
})
