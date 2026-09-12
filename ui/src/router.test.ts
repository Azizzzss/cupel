import { describe, expect, it } from 'vitest'
import { available, parseRoute, toHash, type Route } from './router'

const HASH = `0x${'ab'.repeat(32)}`

describe('parseRoute', () => {
  it('reads the overview from every empty spelling', () => {
    for (const hash of ['', '#', '#/', '#//']) expect(parseRoute(hash)).toEqual({ page: 'overview' })
  })

  it('reads the plain pages, with or without a trailing slash', () => {
    expect(parseRoute('#/blocks')).toEqual({ page: 'blocks' })
    expect(parseRoute('#/blocks/')).toEqual({ page: 'blocks' })
    expect(parseRoute('#/accounts')).toEqual({ page: 'accounts' })
    expect(parseRoute('#/gateway')).toEqual({ page: 'gateway' })
    expect(parseRoute('#/consensus')).toEqual({ page: 'consensus' })
    expect(parseRoute('#/walkthrough')).toEqual({ page: 'walkthrough' })
  })

  it('reads a block number', () => {
    expect(parseRoute('#/block/123')).toEqual({ page: 'block', number: 123 })
    expect(parseRoute('#/block/0')).toEqual({ page: 'block', number: 0 })
    expect(parseRoute('#/block/abc')).toEqual({ page: 'missing', hash: '#/block/abc' })
    expect(parseRoute('#/block/-1').page).toBe('missing')
    expect(parseRoute('#/block/1/2').page).toBe('missing')
    expect(parseRoute('#/block').page).toBe('missing')
  })

  it('reads a transaction hash and normalises its case', () => {
    expect(parseRoute(`#/tx/${HASH.toUpperCase().replace('0X', '0x')}`)).toEqual({
      page: 'tx',
      hash: HASH,
    })
    expect(parseRoute('#/tx/0x1234').page).toBe('missing')
    expect(parseRoute('#/tx').page).toBe('missing')
  })

  it('has a page for what it does not know', () => {
    expect(parseRoute('#/nope')).toEqual({ page: 'missing', hash: '#/nope' })
    expect(parseRoute('#/blocks/extra').page).toBe('missing')
  })
})

describe('toHash', () => {
  const canonical: Route[] = [
    { page: 'overview' },
    { page: 'blocks' },
    { page: 'block', number: 42 },
    { page: 'tx', hash: HASH },
    { page: 'accounts' },
    { page: 'gateway' },
    { page: 'consensus' },
    { page: 'walkthrough' },
  ]

  it('round-trips every canonical route', () => {
    for (const route of canonical) {
      const hash = toHash(route)
      expect(hash.startsWith('#/')).toBe(true)
      expect(parseRoute(hash)).toEqual(route)
    }
  })

  it('never produces a path', () => {
    for (const route of canonical) expect(toHash(route)).not.toMatch(/^\//)
  })

  it('keeps whatever a missing route was asked for', () => {
    expect(toHash({ page: 'missing', hash: '#/nope' })).toBe('#/nope')
  })
})

describe('available', () => {
  it('ties consensus to network mode and the walkthrough to lab mode', () => {
    expect(available('consensus', 'network')).toBe(true)
    expect(available('consensus', 'lab')).toBe(false)
    expect(available('walkthrough', 'lab')).toBe(true)
    expect(available('walkthrough', 'network')).toBe(false)
    expect(available('blocks', 'none')).toBe(true)
  })
})
