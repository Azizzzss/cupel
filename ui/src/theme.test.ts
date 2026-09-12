import { describe, expect, it } from 'vitest'
import { applyTheme, readTheme, themeAttribute } from './theme'

describe('readTheme', () => {
  it('trusts only the two explicit choices', () => {
    expect(readTheme('light')).toBe('light')
    expect(readTheme('dark')).toBe('dark')
    expect(readTheme('system')).toBe('system')
    expect(readTheme(null)).toBe('system')
    expect(readTheme(undefined)).toBe('system')
    expect(readTheme('junk')).toBe('system')
  })
})

describe('applyTheme', () => {
  it('sets the attribute for a choice and removes it for system', () => {
    const calls: string[] = []
    const root = {
      setAttribute: (name: string, value: string) => calls.push(`set ${name}=${value}`),
      removeAttribute: (name: string) => calls.push(`remove ${name}`),
    }
    applyTheme('dark', root)
    applyTheme('system', root)
    expect(calls).toEqual(['set data-theme=dark', 'remove data-theme'])
    expect(themeAttribute('light')).toBe('light')
    expect(themeAttribute('system')).toBeNull()
  })
})
