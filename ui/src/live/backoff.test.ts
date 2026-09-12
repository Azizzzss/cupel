import { expect, it } from 'vitest'
import { backoffMs } from './backoff'

it('doubles from a second and stops at fifteen', () => {
  expect([0, 1, 2, 3, 4, 5, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000, 15_000])
  expect(backoffMs(-3)).toBe(1000)
})
