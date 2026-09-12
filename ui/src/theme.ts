import { useCallback, useState } from 'react'

/**
 * Light, dark, or whatever the system says.
 *
 * The stylesheet already knows all three: it follows `prefers-color-scheme`
 * unless `<html data-theme>` says otherwise. This is only the switch, and the
 * memory of where it was left.
 */
export type Theme = 'light' | 'dark' | 'system'

export const THEME_KEY = 'cupel:theme'

/** A stored choice, or `system` for nothing and for junk. */
export function readTheme(stored: string | null | undefined): Theme {
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

/** What `data-theme` should say; null means the attribute comes off. */
export function themeAttribute(theme: Theme): 'light' | 'dark' | null {
  return theme === 'system' ? null : theme
}

interface Root {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

export function applyTheme(theme: Theme, root: Root): void {
  const attribute = themeAttribute(theme)
  if (attribute) root.setAttribute('data-theme', attribute)
  else root.removeAttribute('data-theme')
}

/** The stored choice. Storage can be absent or refused; then it is `system`. */
export function storedTheme(): Theme {
  try {
    return readTheme(localStorage.getItem(THEME_KEY))
  } catch {
    return 'system'
  }
}

export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(storedTheme)
  const choose = useCallback((next: Theme) => {
    setTheme(next)
    applyTheme(next, document.documentElement)
    try {
      if (next === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, next)
    } catch {
      // Storage refused — a private window, say. The choice lasts the session.
    }
  }, [])
  return [theme, choose]
}
