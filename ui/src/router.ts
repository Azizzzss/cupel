import { useMemo, useSyncExternalStore } from 'react'
import type { Mode } from './api/chain'

/**
 * Where on the page the reader is.
 *
 * Routes live in the hash — `#/block/123` — rather than the path, because the
 * bundle refers to its assets relatively (`./assets/…`) so the binary can mount
 * the page anywhere. A path route with a second segment would resolve those
 * assets under `/block/`, and the server's fallback would answer with the page
 * itself where the browser expected JavaScript. The hash never reaches the
 * server, and a plain `<a href="#/blocks">` is the whole navigation.
 */
export type Page =
  | 'overview'
  | 'blocks'
  | 'block'
  | 'tx'
  | 'accounts'
  | 'gateway'
  | 'consensus'
  | 'walkthrough'
  | 'missing'

export type Route =
  | { page: 'overview' }
  | { page: 'blocks' }
  | { page: 'block'; number: number }
  | { page: 'tx'; hash: string }
  | { page: 'accounts' }
  | { page: 'gateway' }
  | { page: 'consensus' }
  | { page: 'walkthrough' }
  | { page: 'missing'; hash: string }

const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const BLOCK_NUMBER = /^\d{1,15}$/

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '').replace(/\/+$/, '')
  const missing: Route = { page: 'missing', hash }
  if (path === '') return { page: 'overview' }

  const [head, ...rest] = path.split('/')
  const bare = rest.length === 0
  switch (head) {
    case 'blocks':
      return bare ? { page: 'blocks' } : missing
    case 'accounts':
      return bare ? { page: 'accounts' } : missing
    case 'gateway':
      return bare ? { page: 'gateway' } : missing
    case 'consensus':
      return bare ? { page: 'consensus' } : missing
    case 'walkthrough':
      return bare ? { page: 'walkthrough' } : missing
    case 'block':
      return rest.length === 1 && BLOCK_NUMBER.test(rest[0])
        ? { page: 'block', number: Number(rest[0]) }
        : missing
    case 'tx':
      return rest.length === 1 && TX_HASH.test(rest[0])
        ? { page: 'tx', hash: rest[0].toLowerCase() }
        : missing
    default:
      return missing
  }
}

/** The canonical hash for a route — what `parseRoute` gives back unchanged. */
export function toHash(route: Route): string {
  switch (route.page) {
    case 'overview':
      return '#/'
    case 'block':
      return `#/block/${route.number}`
    case 'tx':
      return `#/tx/${route.hash}`
    case 'missing':
      return route.hash
    default:
      return `#/${route.page}`
  }
}

/** Whether a page has anything to show in this mode. */
export function available(page: Page, mode: Mode): boolean {
  if (page === 'consensus') return mode === 'network'
  if (page === 'walkthrough') return mode === 'lab'
  return true
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

function snapshot(): string {
  return window.location.hash
}

/** The current route, re-read whenever the hash changes. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot)
  return useMemo(() => parseRoute(hash), [hash])
}
