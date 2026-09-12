import {
  NETWORK,
  beaconState,
  executionHead,
  type Answer,
  type BeaconState,
  type ExecutionHead,
} from '../api/chain'
import { usePoll } from '../usePoll'

interface Row {
  name: string
  consensus: string
  execution: Answer<ExecutionHead>
  beacon: Answer<BeaconState>
}

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

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five']

/**
 * Three answers to one question, and whether they match.
 *
 * Several outcomes rather than two, because only one of them is alarming. A
 * client that has not answered has not disagreed; a chain with nothing
 * finalised has not disagreed; a client an epoch behind holds the root that was
 * right an epoch ago. Collapsing any of those into "disagree" puts a red panel
 * on a healthy chain, and then nobody reads the panel.
 *
 * The epoch and the root compared here come from one response per client. They
 * used to come from two requests made at different moments, so at an epoch
 * boundary a client could report epoch N beside the root for N+1, and the panel
 * called that a disagreement between clients that agreed.
 */
function verdict(rows: Row[]): { text: string; kind: string } {
  const answering = rows.flatMap((row) => (row.beacon.ok ? [row.beacon.value] : []))
  const silent = rows.length - answering.length
  if (answering.length === 0) return { text: 'no clients reachable', kind: 'pill-idle' }

  const finalising = answering.filter((state) => state.finalized > 0)
  if (finalising.length === 0) {
    return {
      text: silent ? `nothing finalised yet · ${silent} not answering` : 'nothing finalised yet',
      kind: 'pill-working',
    }
  }

  // Behind is not the same as disagreeing, and the difference is the epoch. Two
  // clients reporting different roots for the same epoch have built different
  // chains, which is the thing worth an alarm.
  const rootsByEpoch = new Map<number, Set<string>>()
  for (const state of finalising) {
    const roots = rootsByEpoch.get(state.finalized) ?? new Set<string>()
    roots.add(state.finalizedRoot)
    rootsByEpoch.set(state.finalized, roots)
  }
  if ([...rootsByEpoch.values()].some((roots) => roots.size > 1)) {
    return { text: 'the clients disagree', kind: 'pill-wrong' }
  }

  // Everything else is somebody not being where the newest client is. Each kind
  // is counted and named, rather than "one client behind" when two are or
  // "catching up" when one has stopped.
  const newest = Math.max(...finalising.map((state) => state.finalized))
  const behind = finalising.filter((state) => state.finalized < newest)
  const waiting = answering.length - finalising.length
  const notes: string[] = []
  if (behind.length > 0) {
    const gap = newest - Math.min(...behind.map((state) => state.finalized))
    notes.push(`${behind.length} behind by up to ${gap} epoch${gap === 1 ? '' : 's'}`)
  }
  if (waiting > 0) notes.push(`${waiting} not finalised yet`)
  if (silent > 0) notes.push(`${silent} not answering`)

  if (notes.length === 0) {
    return { text: `${WORDS[rows.length] ?? rows.length} clients, one chain`, kind: 'pill-agree' }
  }
  return { text: `one chain · ${notes.join(' · ')}`, kind: 'pill-working' }
}

function short(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash || '—'
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
                    {state && state.finalized > 0 ? short(state.finalizedRoot) : '—'}
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
