import { NETWORK, beaconState, executionHead } from '../api/chain'
import { shortHash } from '../lib/format'
import { verdict, type Row } from '../lib/verdict'
import { usePoll } from '../usePoll'

async function readAll(): Promise<Row[]> {
  return Promise.all(
    NETWORK.map(async (node) => {
      const [execution, beacon] = await Promise.all([
        executionHead(node.rpc),
        beaconState(node.beacon!),
      ])
      return { name: node.name, consensus: node.consensus ?? '', execution, beacon }
    }),
  )
}

export function Agreement() {
  const { data: rows } = usePoll(readAll, 2000, [])
  if (!rows) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Do they agree?</h2>
        </div>
        <div className="panel-body">
          <span className="faint pulse">asking three clients…</span>
        </div>
      </section>
    )
  }

  const v = verdict(rows)
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Do they agree?</h2>
        <span className={`pill ${v.kind}`}>
          <span className="dot" />
          {v.text}
        </span>
      </div>
      <div className="panel-body scroll-x">
        <table className="plain">
          <thead>
            <tr>
              <th>node</th>
              <th>consensus</th>
              <th>block</th>
              <th>slot</th>
              <th>just.</th>
              <th>final</th>
              <th>peers</th>
              <th>finalised root</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const state = row.beacon.ok ? row.beacon.value : undefined
              return (
                <tr key={row.name}>
                  <td className="name">{row.name}</td>
                  <td>{row.consensus}</td>
                  <td className="num">{row.execution.ok ? row.execution.value.number : '—'}</td>
                  <td className="num">{state ? state.headSlot : '—'}</td>
                  <td className="num">{state ? state.justified : '—'}</td>
                  <td className="num">{state ? state.finalized : '—'}</td>
                  <td className="num">{state?.peers ?? '—'}</td>
                  <td className="num faint">
                    {state && state.finalized > 0 ? shortHash(state.finalizedRoot) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="panel-note" style={{ marginTop: '0.7rem' }}>
          Lighthouse, Prysm and Teku are written by different teams in different
          languages. The finalised root is the thing they have to agree on, and
          the validators are split 22&thinsp;/&thinsp;21&thinsp;/&thinsp;21 so
          no single one of them can decide it alone.
        </p>
      </div>
    </section>
  )
}
