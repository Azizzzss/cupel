import {
  NETWORK,
  beaconState,
  executionHead,
  finalizedRoot,
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
  root: Answer<string>
}

async function readAll(): Promise<Row[]> {
  return Promise.all(
    NETWORK.map(async (node) => ({
      name: node.name,
      consensus: node.consensus ?? '',
      execution: await executionHead(node.rpc),
      beacon: await beaconState(node.beacon!),
      root: await finalizedRoot(node.beacon!),
    })),
  )
}

/**
 * Three answers to one question, and whether they match.
 *
 * The verdict deliberately has four outcomes rather than two. A client that has
 * not answered has not disagreed — it has not been asked successfully — and a
 * chain with nothing finalised yet has not disagreed either. Collapsing those
 * into "disagree" produces a red panel on a healthy chain during its first
 * twenty-five minutes, which teaches people to ignore the panel.
 */
function verdict(rows: Row[]): { text: string; kind: string } {
  const answered = rows.filter((r) => r.root.ok && r.beacon.ok)
  const reachable = rows.filter((r) => r.beacon.ok).length

  if (reachable === 0) return { text: 'no clients reachable', kind: 'pill-idle' }
  if (answered.length === 0) return { text: 'nothing finalised yet', kind: 'pill-working' }

  // Behind is not the same as disagreeing, and the difference is the epoch. A
  // client three epochs back has the finalised root that *was* correct three
  // epochs ago — it has fallen behind, which is a liveness problem. Two clients
  // reporting different roots for the *same* epoch have built different chains,
  // which is the thing worth an alarm. Calling the first one a disagreement
  // cries wolf every time a node restarts, and then nobody reads the panel.
  const epochs = new Map<number, Set<string>>()
  for (const row of answered) {
    const epoch = (row.beacon as { value: BeaconState }).value.finalized
    const root = (row.root as { value: string }).value
    if (!epochs.has(epoch)) epochs.set(epoch, new Set())
    epochs.get(epoch)!.add(root)
  }

  const forked = [...epochs.values()].some((roots) => roots.size > 1)
  if (forked) return { text: 'the clients disagree', kind: 'pill-wrong' }

  if (epochs.size > 1) {
    const behind = [...epochs.keys()].sort((a, b) => a - b)
    const gap = behind[behind.length - 1] - behind[0]
    return {
      text: `same chain, one client ${gap} epoch${gap === 1 ? '' : 's'} behind`,
      kind: 'pill-working',
    }
  }

  if (answered.length < rows.length) {
    return {
      text: `${answered.length} of ${rows.length} agree, rest catching up`,
      kind: 'pill-working',
    }
  }
  return { text: 'three clients, one chain', kind: 'pill-agree' }
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
            {rows.map((row) => (
              <tr key={row.name}>
                <td className="name">{row.name}</td>
                <td>{row.consensus}</td>
                <td className="num">{row.execution.ok ? row.execution.value.number : '—'}</td>
                <td className="num">{row.beacon.ok ? row.beacon.value.headSlot : '—'}</td>
                <td className="num">{row.beacon.ok ? row.beacon.value.justified : '—'}</td>
                <td className="num">{row.beacon.ok ? row.beacon.value.finalized : '—'}</td>
                <td className="num">{row.beacon.ok ? row.beacon.value.peers : '—'}</td>
                <td className="num faint">{row.root.ok ? short(row.root.value) : '—'}</td>
              </tr>
            ))}
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
