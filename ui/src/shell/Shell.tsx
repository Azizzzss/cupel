import { useEffect } from 'react'
import type { Mode } from '../api/chain'
import { pageTitle } from '../lib/title'
import { Accounts } from '../pages/Accounts'
import { Block } from '../pages/Block'
import { Blocks } from '../pages/Blocks'
import { Consensus } from '../pages/Consensus'
import { GatewayPage } from '../pages/GatewayPage'
import { Missing } from '../pages/Missing'
import { Overview } from '../pages/Overview'
import { Tx } from '../pages/Tx'
import { WalkthroughPage } from '../pages/WalkthroughPage'
import { WrongMode } from '../pages/WrongMode'
import { available, toHash, useRoute, type Route } from '../router'
import { useChain } from '../store/context'
import { ErrorBoundary } from './ErrorBoundary'
import { Nav } from './Nav'
import { StatusStrip } from './StatusStrip'

/** The frame every page sits in: the strip above, the pages beside, the page itself. */
export function Shell() {
  const route = useRoute()
  const { mode, settled, head } = useChain()
  const hash = toHash(route)
  const headNumber = head.value?.number

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [hash])

  useEffect(() => {
    document.title = pageTitle(mode, headNumber)
  }, [mode, headNumber])

  return (
    <div className="shell">
      <StatusStrip />
      <Nav route={route} mode={mode} />
      <main className="page">
        <ErrorBoundary key={route.page}>
          <Page route={route} mode={mode} settled={settled} />
        </ErrorBoundary>
      </main>
    </div>
  )
}

function Page({ route, mode, settled }: { route: Route; mode: Mode; settled: boolean }) {
  // No redirects: the mode is polled, and a transient "none" must not rewrite
  // the URL somebody typed. A page the mode does not have says so instead.
  if (!available(route.page, mode)) {
    return settled ? <WrongMode page={route.page} mode={mode} /> : null
  }
  switch (route.page) {
    case 'overview':
      return <Overview />
    case 'blocks':
      return <Blocks />
    case 'block':
      return <Block number={route.number} />
    case 'tx':
      return <Tx hash={route.hash} />
    case 'accounts':
      return <Accounts />
    case 'gateway':
      return <GatewayPage />
    case 'consensus':
      return <Consensus />
    case 'walkthrough':
      return <WalkthroughPage />
    case 'missing':
      return <Missing hash={route.hash} />
    default:
      return <Missing hash={toHash(route)} />
  }
}
