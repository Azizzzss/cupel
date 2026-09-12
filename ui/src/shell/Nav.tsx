import type { Mode } from '../api/chain'
import { available, type Page, type Route } from '../router'

interface Item {
  page: Page
  label: string
  hash: string
  /** The mode that has this page, when only one does. */
  needs?: Mode
}

const ITEMS: Item[] = [
  { page: 'overview', label: 'Overview', hash: '#/' },
  { page: 'gateway', label: 'Gateway', hash: '#/gateway' },
  { page: 'consensus', label: 'Consensus', hash: '#/consensus', needs: 'network' },
  { page: 'walkthrough', label: 'Walkthrough', hash: '#/walkthrough', needs: 'lab' },
]

/**
 * The pages, as plain links.
 *
 * A page the running mode does not have stays in the list, greyed and marked
 * with the mode that has it, and opens to a page saying so: the reader learns
 * what the other mode offers, and the list does not rearrange itself when a
 * devnet comes up.
 */
export function Nav({ route, mode }: { route: Route; mode: Mode }) {
  return (
    <nav className="nav" aria-label="pages">
      {ITEMS.map((item) => {
        const active = route.page === item.page
        const ok = available(item.page, mode)
        const classes = ['nav-link', active ? 'active' : '', ok ? '' : 'unavailable']
        return (
          <a
            key={item.page}
            className={classes.filter(Boolean).join(' ')}
            href={item.hash}
            aria-current={active ? 'page' : undefined}
          >
            {item.label}
            {!ok && item.needs && <span className="nav-hint">{item.needs} mode</span>}
          </a>
        )
      })}
    </nav>
  )
}
