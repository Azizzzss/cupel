import { NETWORK, beaconState, type BeaconState } from '../api/chain'
import { useNow, usePoll } from '../usePoll'

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

  const { secondsPerSlot, slotsPerEpoch, genesisTime, headSlot, justified, finalized } = data.state
  const via = `via ${data.consensus} (${data.node})`

  if (secondsPerSlot === undefined || slotsPerEpoch === undefined || genesisTime === undefined) {
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

  // The slot the wall clock is in, which is not the same as the slot the chain
  // has a block for — the gap between them is exactly what a missed slot is.
  const elapsed = Math.max(0, Math.floor(now / 1000) - genesisTime)
  const clockSlot = Math.floor(elapsed / secondsPerSlot)
  const intoSlot = elapsed % secondsPerSlot
  const epoch = Math.floor(clockSlot / slotsPerEpoch)
  const intoEpoch = clockSlot % slotsPerEpoch
  const behind = clockSlot - headSlot

  const epochSeconds = secondsPerSlot * slotsPerEpoch
  const untilEpoch = epochSeconds - (elapsed % epochSeconds)

  // Finality normally trails the clock by two epochs, occasionally three. Past
  // that it has stopped, and saying "irreversible" beside a number that is not
  // moving hides the most interesting thing this devnet can show. The first
  // finalised epoch is due four epochs in; after that it is overdue, which is
  // different from "about now away", the message this used to show for ever.
  const firstDue = 4 * epochSeconds - elapsed
  const lag = epoch - finalized
  const finalNote =
    finalized === 0
      ? firstDue > 0
        ? `first one about ${mmss(firstDue)} away`
        : `overdue by ${mmss(-firstDue)} — finality needs more than two thirds of the stake attesting`
      : lag > 3
        ? `${lag} epochs behind the clock — finality has stalled`
        : 'irreversible'

  return (
    <Panel note={`${secondsPerSlot}s slots · ${slotsPerEpoch} per epoch · ${via}`}>
      <div className="tight">
        <Field label="Slot" value={`${clockSlot}`} note={`${intoSlot}s in`} />
        <Field
          label="Epoch"
          value={`${epoch}`}
          note={`slot ${intoEpoch} of ${slotsPerEpoch} · next in ${mmss(untilEpoch)}`}
        />
        <Field
          label="Head"
          value={`${headSlot}`}
          note={behind <= 1 ? 'keeping time' : `${behind} slots behind the clock`}
        />
        <Field label="Justified epoch" value={`${justified}`} />
        <Field label="Finalised epoch" value={`${finalized}`} note={finalNote} />
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

function Panel({ note, children }: { note?: string; children: React.ReactNode }) {
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

function Field({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="row" style={{ gap: '0.5rem' }}>
        {note && <span className="panel-note">{note}</span>}
        <span className="field-value">{value}</span>
      </span>
    </div>
  )
}

function mmss(seconds: number): string {
  if (seconds <= 0) return 'now'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}
