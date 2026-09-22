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

/** The block window as a lane, newest first — the order the store keeps. */
export function lane(blocks: ExecutionHead[]): Placed[] {
  const busiest = busiestGas(blocks)
  const last = Math.max(1, blocks.length - 1)
  return blocks.map((block, index) => ({
    number: block.number,
    hash: block.hash,
    transactions: block.transactions,
    gasUsed: block.gasUsed,
    // Not `-index * SPACING`: at index 0 that is negative zero, which is
    // equal to zero everywhere except a deep comparison, where it is not.
    z: index === 0 ? 0 : -(index * SPACING),
    height: heightFor(block.gasUsed, busiest),
    fade: index / last,
  }))
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
 * Further back than the lane is long. That sounds obvious and was not: an
 * earlier version backed off by less than half the length, which put the camera
 * *inside* the ribbon a couple of blocks from its newest end, and the page
 * showed four enormous boxes and called it the chain.
 */
export function cameraDistance(count: number): number {
  return 6 + laneDepth(count)
}
