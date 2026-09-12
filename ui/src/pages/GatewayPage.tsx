import { Gateway } from '../components/Gateway'
import { PageHead } from '../shell/PageHead'

export function GatewayPage() {
  return (
    <>
      <PageHead
        title="The gateway"
        lede="One JSON-RPC address for every tool, in front of whichever nodes are answering. Point cast, forge, MetaMask or viem at 8545 and never at a node."
      />
      <Gateway />
      <section className="panel">
        <div className="panel-head">
          <h2>What it does between you and the node</h2>
        </div>
        <div className="panel-body">
          <p className="dim" style={{ margin: 0, fontSize: '0.88rem' }}>
            Upstreams are a list with declared capabilities, even when there is one
            of them, and every request resolves capability, then health, then
            weight. Answers that cannot change — a block by number, a receipt — are
            cached; anything mentioning latest, pending, safe or finalised never
            is. Expensive methods have their own rate limit, so a runaway script
            cannot starve the walkthrough.
          </p>
          <p className="panel-note" style={{ margin: 0 }}>
            The counters above are the gateway&apos;s own, from{' '}
            <span className="mono">/health</span>; Prometheus reads the same
            numbers from <span className="mono">/metrics</span> when{' '}
            <span className="mono">cupel observe</span> is running.
          </p>
        </div>
      </section>
    </>
  )
}
