import { NETWORK, beaconState } from '../api/chain'
import { useNow, usePoll } from '../usePoll'

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
  const { data } = usePoll(() => beaconState(NETWORK[0].beacon!), 4000, [])
  const now = useNow(500)

  if (!data?.ok) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>The clock</h2>
        </div>
        <div className="panel-body">
          <span className="faint">no beacon node answering</span>
        </div>
      </section>
    )
  }

  const { secondsPerSlot, slotsPerEpoch, genesisTime, headSlot, justified, finalized } = data.value

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

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>The clock</h2>
        <span className="panel-note mono">
          {secondsPerSlot}s slots · {slotsPerEpoch} per epoch
        </span>
      </div>
      <div className="panel-body tight">
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
        <Field
          label="Finalised epoch"
          value={`${finalized}`}
          note={
            finalized > 0
              ? 'irreversible'
              : `first one about ${mmss(4 * epochSeconds - elapsed)} away`
          }
        />
        <p className="panel-note" style={{ marginTop: '0.5rem' }}>
          A slot is a fixed opportunity for one validator to propose; it passes
          whether or not they do. Finality trails the head by roughly two
          epochs, and that gap is not latency waiting to be optimised away — it
          is how long collecting the votes takes.
        </p>
      </div>
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
