import type { ReactNode } from 'react'
import { mmss } from '../lib/format'
import { freshness as judge } from '../lib/freshness'
import { finalityNote, slotView, timing } from '../lib/slots'
import { useChain } from '../store/context'
import { useNow } from '../usePoll'
import { Field } from './Field'
import { StaleNote } from './Stale'

/**
 * Where the chain is in its own units.
 *
 * Everything here is derived from `SECONDS_PER_SLOT`, `SLOTS_PER_EPOCH` and the
 * genesis time as the chain reports them — never from constants held here. The
 * control plane spent two releases printing durations computed from a slot time
 * the chain was not using, and the only symptom was that its arithmetic was
 * quietly wrong.
 *
 * Read from whichever client answers, not only node1: reading Lighthouse alone
 * meant that stopping node1 — the demonstration this lab asks for — left the
 * clock claiming no beacon node was answering while two of them were. A fresh
 * answer is preferred to an old one, and an old one to none.
 */
export function SlotClock() {
  const { nodes } = useChain()
  const now = useNow(500)

  const readings = nodes
    .filter((node) => node.row.value?.beacon.ok)
    .map((node) => ({ node, age: judge(node.row, now) }))
  const reading = readings.find((r) => r.age.kind === 'fresh') ?? readings[0]
  const beacon = reading?.node.row.value?.beacon

  if (!reading || !beacon?.ok) {
    return (
      <Panel>
        <span className="faint">no beacon node answering</span>
      </Panel>
    )
  }

  const { headSlot, justified, finalized } = beacon.value
  const via = `via ${reading.node.target.consensus} (${reading.node.target.name})`
  const t = timing(beacon.value)
  // The clock rows keep ticking whatever the client says: they are wall-clock
  // arithmetic and stay true. What the chain reported — the head, the
  // justified and finalised epochs — is what goes grey when it ages.
  const stale = reading.age.kind === 'stale'

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
          stale={stale}
        />
        <Field label="Justified epoch" value={`${justified}`} stale={stale} />
        <Field
          label="Finalised epoch"
          value={`${finalized}`}
          note={finalityNote(view, finalized)}
          stale={stale}
        />
        <StaleNote freshness={reading.age} />
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
