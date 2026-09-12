import type { Mode } from '../api/chain'

/** The tab's title: the head number while there is one, so a row of tabs reads like a ticker. */
export function pageTitle(mode: Mode, head?: number): string {
  return mode === 'none' || head === undefined ? 'Cupel — control room' : `#${head} · Cupel`
}
