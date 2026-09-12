import { NETWORK, beaconState, executionHead, type Answer } from '../api/chain'
import { shortHash } from '../lib/format'
import { staleClass } from '../lib/freshness'
import { verdict, type Row } from '../lib/verdict'
import { useFreshness, usePoll } from '../usePoll'
import { StaleNote } from './Stale'

/**
 * Every node's answers. An answer only when at least one beacon node spoke:
 * three silences are not a reading of the chain, and the panel keeps the last
 * reading it had, greyed, rather than replacing it with three dashes.
 */
async function readAll(): Promise<Answer<Row[]>> {
  const rows = await Promise.all(
    NETWORK.map(async (node) => {
      const [execution, beacon] = await Promise.all([
        executionHead(node.rpc),
        beaconState(node.beacon!),
      ])
      return { name: node.name, consensus: node.consensus ?? '', execution, beacon }
    }),
  )
  return rows.some((row) => row.beacon.ok)
    ? { ok: true, value: rows }
    : { ok: false, reason: 'unreachable' }
}

export function Agreement() {
  const answers = usePoll(readAll, 2000, [])
  const freshness = useFreshness(answers)
  const rows = answers.value
  if (!rows) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Do they agree?</h2>
        </div>
        <div className="panel-body">
          <span className="faint pulse">
            {answers.loading ? 'asking three clients…' : 'no clients reachable'}
          </span>
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
      <div className={staleClass(freshness, 'panel-body scroll-x')}>
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
        <StaleNote freshness={freshness} />
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
