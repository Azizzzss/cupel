import { gatewayHealth } from '../api/chain'
import { usePoll } from '../usePoll'

/**
 * What the gateway is doing with its upstreams.
 *
 * This is the panel that makes the gateway's whole point visible: stop a node
 * and watch it leave the rotation, start it and watch it come back, while the
 * requests keep being answered by whoever is left.
 */
export function Gateway() {
  const { data } = usePoll(() => gatewayHealth(), 2000, [])

  if (!data?.ok) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>The gateway</h2>
        </div>
        <div className="panel-body">
          <span className="faint">
            not running — it serves on 8545 while <span className="mono">cupel up</span> or{' '}
            <span className="mono">cupel network up</span> is in the foreground
          </span>
        </div>
      </section>
    )
  }

  const { healthy, total, upstreams } = data.value
  const kind = healthy === 0 ? 'pill-wrong' : healthy < total ? 'pill-working' : 'pill-agree'

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>The gateway</h2>
        <span className={`pill ${kind}`}>
          <span className="dot" />
          {healthy} of {total} answering
        </span>
      </div>
      <div className="panel-body scroll-x">
        <table className="plain">
          <thead>
            <tr>
              <th>upstream</th>
              <th>state</th>
              <th>forwarded</th>
              <th>errors</th>
            </tr>
          </thead>
          <tbody>
            {upstreams.map((up) => (
              <tr key={up.name}>
                <td className="name">{up.name}</td>
                <td style={{ color: up.up ? 'var(--bead)' : 'var(--wrong)' }}>
                  {up.up ? 'up' : 'down'}
                </td>
                <td className="num">{up.forwarded}</td>
                <td className="num" style={{ color: up.errors ? 'var(--litharge)' : undefined }}>
                  {up.errors}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="panel-note" style={{ marginTop: '0.7rem' }}>
          Routing resolves capability, then health, then weight. Two consecutive
          failed probes take a node out — one is usually a blip — and a
          successful one puts it back without anybody intervening. Try{' '}
          <span className="mono">docker stop cupel-el2</span> and watch this
          table rather than the terminal.
        </p>
      </div>
    </section>
  )
}
