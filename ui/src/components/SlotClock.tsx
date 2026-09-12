import type { ReactNode } from 'react'
import { NETWORK, beaconState, type BeaconState } from '../api/chain'
import { mmss } from '../lib/format'
import { finalityNote, slotView, timing } from '../lib/slots'
import { useNow, usePoll } from '../usePoll'
import { Field } from './Field'

interface Reading {
  node: string
  consensus: string
  state: BeaconState
}

/**
 * The first beacon node that answers, and which one it was.
 *
 * Every client, not only node1. Reading Lighthouse alone meant that stopping
 * node1 — the demonstration this lab asks for — left the clock claiming no
 * beacon node was answering while two of them were.
 */
async function firstAnswering(): Promise<Reading | undefined> {
  for (const node of NETWORK) {
    const answer = await beaconState(node.beacon!)
    if (answer.ok) {
      return { node: node.name, consensus: node.consensus ?? '', state: answer.value }
    }
  }
  return undefined
}

/**
 * Where the chain is in its own units.
 *
 * Everything here is derived from `SECONDS_PER_SLOT`, `SLOTS_PER_EPOCH` and the
 * genesis time as the chain reports them — never from constants held here. The
 * control plane spent two releases printing durations computed from a slot time
 * the chain was not using, and the only symptom was that its arithmetic was
 * quietly wrong. Asking costs one request.
 */
export function SlotClock() {
  const { data } = usePoll(firstAnswering, 4000, [])
  const now = useNow(500)

  if (!data) {
    return (
      <Panel>
        <span className="faint">no beacon node answering</span>
      </Panel>
    )
  }

  const { headSlot, justified, finalized } = data.state
  const via = `via ${data.consensus} (${data.node})`
  const t = timing(data.state)

  if (!t) {
    return (
      <Panel note={via}>
        <span className="faint">
          the client answered but did not report its slot time, epoch length and
          genesis — and a clock built from guesses is the thing this panel exists
          not to be
        </span>
      </Panel>
    )
  }

  const view = slotView(now, t, headSlot, finalized)

  return (
    <Panel note={`${t.secondsPerSlot}s slots · ${t.slotsPerEpoch} per epoch · ${via}`}>
      <div className="tight">
        <Field label="Slot" value={`${view.clockSlot}`} note={`${view.intoSlot}s in`} />
        <Field
          label="Epoch"
          value={`${view.epoch}`}
          note={`slot ${view.intoEpoch} of ${t.slotsPerEpoch} · next in ${mmss(view.untilEpoch)}`}
        />
        <Field
          label="Head"
          value={`${headSlot}`}
          note={view.behind <= 1 ? 'keeping time' : `${view.behind} slots behind the clock`}
        />
        <Field label="Justified epoch" value={`${justified}`} />
        <Field label="Finalised epoch" value={`${finalized}`} note={finalityNote(view, finalized)} />
        <p className="panel-note" style={{ marginTop: '0.5rem' }}>
          A slot is a fixed opportunity for one validator to propose; it passes
          whether or not they do. Finality trails the head by roughly two
          epochs, and that gap is not latency waiting to be optimised away — it
          is how long collecting the votes takes.
        </p>
      </div>
    </Panel>
  )
}

function Panel({ note, children }: { note?: string; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>The clock</h2>
        {note && <span className="panel-note mono">{note}</span>}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  )
}
