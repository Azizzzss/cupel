import { ago, shortHash } from '../lib/format'
import { freshness as judge } from '../lib/freshness'
import { unreachableRow, verdict } from '../lib/verdict'
import { useChain } from '../store/context'
import { useNow } from '../usePoll'
import { Transport } from './Stale'

/**
 * Three answers to one question, and whether they match.
 *
 * Each node is judged for age on its own. A node that stops is shown greyed,
 * with when it last spoke, and counts as not answering — never as a silent
 * vote for whichever root it last reported.
 */
export function Agreement() {
  const { nodes } = useChain()
  const now = useNow(1000)

  if (nodes.length === 0) return null
  if (nodes.every((node) => node.row.loading)) {
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

  const readings = nodes.map((node) => {
    const silent = unreachableRow(node.target.name, node.target.consensus ?? '')
    const age = judge(node.row, now)
    const value = node.row.value
    return {
      node,
      age,
      shown: value ?? silent,
      counted: value && age.kind === 'fresh' ? value : silent,
    }
  })
  const v = verdict(readings.map((reading) => reading.counted))
  const stale = readings.filter((reading) => reading.age.kind === 'stale')

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
              <th>clients</th>
              <th>block</th>
              <th>slot</th>
              <th>just.</th>
              <th>final</th>
              <th>peers</th>
              <th>finalised root</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {readings.map(({ node, age, shown }) => {
              const state = shown.beacon.ok ? shown.beacon.value : undefined
              return (
                <tr key={node.target.name} className={age.kind === 'stale' ? 'stale' : undefined}>
                  <td className="name">{node.target.name}</td>
                  <td>
                    {node.target.execution && <span className="faint">{node.target.execution} + </span>}
                    {node.target.consensus}
                  </td>
                  <td className="num">{shown.execution.ok ? shown.execution.value.number : '—'}</td>
                  <td className="num">{state ? state.headSlot : '—'}</td>
                  <td className="num">{state ? state.justified : '—'}</td>
                  <td className="num">{state ? state.finalized : '—'}</td>
                  <td className="num">{state?.peers ?? '—'}</td>
                  <td className="num faint">
                    {state && state.finalized > 0 ? shortHash(state.finalizedRoot) : '—'}
                  </td>
                  <td>
                    <Transport live={node.live.status === 'open'} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {stale.map(({ node, age }) => (
          <p key={node.target.name} className="stale-note">
            {node.target.name}: last answer {age.kind === 'stale' ? ago(age.ageMs) : ''} ago —
            showing what was true then
          </p>
        ))}
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
