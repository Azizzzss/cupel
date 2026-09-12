import { expect, it } from 'vitest'
import { pageTitle } from './title'

it('names the page until there is a head to show', () => {
  expect(pageTitle('none')).toBe('Cupel — control room')
  expect(pageTitle('lab')).toBe('Cupel — control room')
  expect(pageTitle('none', 1234)).toBe('Cupel — control room')
})

it('shows the head once there is one', () => {
  expect(pageTitle('lab', 1234)).toBe('#1234 · Cupel')
  expect(pageTitle('network', 0)).toBe('#0 · Cupel')
})
