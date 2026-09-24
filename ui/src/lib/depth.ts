import type { ExecutionHead } from '../api/chain'

/**
 * Turning a window of blocks into a lane of boxes.
 *
 * All of the arithmetic the 3D view needs lives here, away from the renderer,
 * so it can be tested without a canvas — the scene does nothing but read these
 * numbers and put geometry where they say.
 */

/** Distance between one block and the next, in world units. */
export const SPACING = 0.62

const MIN_HEIGHT = 0.26
const MAX_HEIGHT = 3.2

/** One block, placed. */
export interface Placed {
  number: number
  hash: string
  transactions: number
  gasUsed: number
  /** Seconds, as the block says. */
  timestamp: number
  /** Along the lane: 0 is the newest block, and older ones run away from the camera. */
  z: number
  /** How tall the box stands, from the gas the block used. */
  height: number
  /** 0 at the front, 1 at the far end — how far back this block sits. */
  fade: number
}

/**
 * Gas used, as a height.
 *
 * Square-rooted against the busiest block in view rather than scaled straight,
 * because one heavy block among fifty empty ones would otherwise flatten the
 * rest onto the floor and the lane would read as a stalled chain.
 *
 * The floor height is the other half of that: an empty block is still a block,
 * and a chain of invisible boxes says the opposite of what is happening.
 */
export function heightFor(gasUsed: number, busiest: number): number {
  const share = busiest > 0 ? Math.min(1, Math.max(0, gasUsed / busiest)) : 0
  return MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * Math.sqrt(share)
}

/**
 * The most gas any block in the window used.
 *
 * Zero when nothing has been sent to the chain, which is the ordinary state of
 * a lab nobody has used yet — worth knowing about rather than drawing as fifty
 * identical slabs and leaving the reader to wonder what broke.
 */
export function busiestGas(blocks: ExecutionHead[]): number {
  return blocks.reduce((most, block) => Math.max(most, block.gasUsed), 0)
}

/**
 * The steps a full-height box is allowed to mean, in gas.
 *
 * Round numbers a reader can hold: a hundred thousand, then two, then five, and
 * so on to a block that fills its gas limit.
 */
const STEPS = [
  100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 15_000_000, 30_000_000,
]

/**
 * What a box at full height means.
 *
 * Scaling straight to the busiest block in view looks right and is not. The
 * window holds fifty blocks and moves every second, so when the busiest one
 * falls off the end, every remaining box silently grows — a block that has not
 * changed appears to have changed, which is the one thing a picture of a chain
 * must never do.
 *
 * The reference climbs in steps instead. Heights then hold still for minutes at
 * a time, and the legend prints the number, so when they do move the reader can
 * see what moved.
 */
export function scaleFor(busiest: number): number {
  return STEPS.find((step) => step >= busiest) ?? Math.max(busiest, STEPS[STEPS.length - 1])
}

/** The consensus clock, where there is one: network mode's beacon spec and genesis. */
export interface Clock {
  secondsPerSlot: number
  slotsPerEpoch: number
  genesisTime: number
}

/**
 * The usual time between blocks in a window, in seconds.
 *
 * The median gap rather than the mean, so a stall or a burst of blocks asked
 * for by hand does not move it: in lab mode this is the `--block-time`, one
 * second by default. At least one, because a chain's timestamps are whole
 * seconds and two blocks can share one.
 */
export function blockInterval(blocks: ExecutionHead[]): number {
  const gaps: number[] = []
  for (let i = 1; i < blocks.length; i++) {
    const gap = blocks[i - 1].timestamp - blocks[i].timestamp
    if (gap > 0) gaps.push(gap)
  }
  if (gaps.length === 0) return 1
  gaps.sort((a, b) => a - b)
  return Math.max(1, gaps[Math.floor(gaps.length / 2)])
}

/**
 * The longest gap drawn at its true length, in intervals. A chain stopped for
 * an hour would otherwise push everything before the stop out past the fog.
 */
export const LONGEST_GAP = 6

/**
 * The block window as a lane, newest first — the order the store keeps.
 *
 * Blocks sit at their place in time, one spacing per interval — the slot time
 * on the devnet, the block time in the lab. A slot nobody proposed in is a gap
 * the width of a block, which is what a missed slot is: time that passed with
 * no block in it. Spacing by position instead drew fifty evenly spaced boxes
 * whether they covered fifty seconds or ten minutes with holes in them.
 */
export function lane(blocks: ExecutionHead[], clock?: Pick<Clock, 'secondsPerSlot'>): Placed[] {
  const busiest = scaleFor(busiestGas(blocks))
  const last = Math.max(1, blocks.length - 1)
  const interval = clock?.secondsPerSlot ?? blockInterval(blocks)
  const placed: Placed[] = []
  let z = 0
  blocks.forEach((block, index) => {
    if (index > 0) {
      const gap = (blocks[index - 1].timestamp - block.timestamp) / interval
      // At least one spacing, so two blocks sharing a second do not stand in
      // one another; at most LONGEST_GAP, so one stall does not swallow the lane.
      z -= SPACING * Math.min(LONGEST_GAP, Math.max(1, gap))
    }
    placed.push({
      number: block.number,
      hash: block.hash,
      transactions: block.transactions,
      gasUsed: block.gasUsed,
      timestamp: block.timestamp,
      // `0` rather than `z` for the first: negative zero is equal to zero
      // everywhere except a deep comparison, where it is not.
      z: index === 0 ? 0 : z,
      height: heightFor(block.gasUsed, busiest),
      fade: index / last,
    })
  })
  return placed
}

/**
 * How many block-widths the lane spans, gaps included — the count the camera,
 * the floor and the centre are sized for.
 */
export function laneCount(placed: Placed[]): number {
  const end = placed[placed.length - 1]
  return end ? Math.round(-end.z / SPACING) + 1 : 0
}

/** Where an epoch begins, along the lane. */
export interface Boundary {
  epoch: number
  z: number
}

/**
 * The epoch boundaries inside the window, placed at the moment each epoch
 * began rather than beside whichever block happened to follow it.
 *
 * Lab mode has none: there are no slots without a consensus client, and
 * drawing lines every thirty-two blocks there would invent a clock.
 */
export function epochBoundaries(placed: Placed[], clock: Clock | undefined): Boundary[] {
  if (!clock || clock.secondsPerSlot <= 0 || clock.slotsPerEpoch <= 0) return []
  const epochSeconds = clock.secondsPerSlot * clock.slotsPerEpoch
  const epochOf = (time: number) => Math.floor((time - clock.genesisTime) / epochSeconds)
  const out: Boundary[] = []
  for (let i = 1; i < placed.length; i++) {
    const newer = placed[i - 1]
    const older = placed[i]
    const epoch = epochOf(newer.timestamp)
    if (epoch === epochOf(older.timestamp)) continue
    const began = clock.genesisTime + epoch * epochSeconds
    // Between the two blocks, in proportion to when it began.
    const share = (newer.timestamp - began) / Math.max(1, newer.timestamp - older.timestamp)
    out.push({ epoch, z: newer.z + (older.z - newer.z) * Math.min(1, Math.max(0, share)) })
  }
  return out
}

/** Seconds as something to read: "50 s", "4 min 10 s", "1 h 3 min". */
export function span(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  if (s < 3600) return s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

/** The block at a number, if the window still holds it. */
export function placeOf(placed: Placed[], number: number): Placed | undefined {
  return placed.find((block) => block.number === number)
}

/**
 * Where a client stands relative to the chain the lane was drawn from.
 *
 * Five answers rather than two, for the same reason the agreement table has
 * four: a client that has not answered has not disagreed, and one a block ahead
 * or a block behind has not either. Only `different` — the same number carrying
 * a different hash — means two clients built different chains.
 */
export type Standing = 'same' | 'different' | 'ahead' | 'behind' | 'silent'

export function standing(
  placed: Placed[],
  head: { number: number; hash: string } | undefined,
): Standing {
  if (!head) return 'silent'
  const here = placeOf(placed, head.number)
  if (here) return sameHash(here.hash, head.hash) ? 'same' : 'different'

  const newest = placed[0]?.number
  const oldest = placed[placed.length - 1]?.number
  if (newest === undefined || oldest === undefined) return 'silent'
  return head.number > newest ? 'ahead' : 'behind'
}

/** Hashes from different clients differ in case, and mean the same block. */
export function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

/** How long the lane is, end to end. */
export function laneDepth(count: number): number {
  return Math.max(0, count - 1) * SPACING
}

/**
 * The shift that puts the middle of the lane at the origin.
 *
 * The lane is built with its newest block at zero and older ones behind it, so
 * without this the whole thing hangs off one side and turning it swings the far
 * end out of frame rather than rotating it in place.
 */
export function laneCentre(count: number): number {
  return laneDepth(count) / 2
}

/**
 * How far back the camera sits to hold a lane of this length.
 *
 * Comfortably outside the ribbon — which sounds obvious and was not: an early
 * version backed off by less than half the length, so the camera sat *inside*
 * the lane a couple of blocks from its newest end, and the page showed four
 * enormous boxes and called it the chain. Standing off by the whole length
 * fixed that and overshot: fifty blocks then sat in the middle distance, too
 * small to point at. This is the near end of the range that still clears it.
 */
export function cameraDistance(count: number): number {
  return 6 + laneDepth(count) * 0.72
}

/** When the scene draws: every frame, only when something changes, or not at all. */
export type Frameloop = 'always' | 'demand' | 'never'

/**
 * How often to draw, given whether anybody can see the scene.
 *
 * A WebGL canvas left to itself draws sixty times a second for as long as the
 * page is open — and a browser only stops that for a tab in the background, not
 * for a canvas scrolled out of view while somebody reads the legend under it,
 * which on a laptop is a fan and a battery spent on pixels nobody sees. So it
 * stops outright when hidden or off screen.
 *
 * With reduced motion asked for, the scene has no idle movement to show, so it
 * draws only when something changes: a block arrives, the reader drags, a
 * glide settles.
 */
export function frameloopFor(seen: { hidden: boolean; onScreen: boolean; reduced: boolean }): Frameloop {
  if (seen.hidden || !seen.onScreen) return 'never'
  return seen.reduced ? 'demand' : 'always'
}
