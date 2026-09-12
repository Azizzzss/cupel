import type { ReactNode } from 'react'
import { Transport } from '../components/Stale'
import { ago } from '../lib/format'
import { freshest, freshness, worst, type Freshness, type Source } from '../lib/freshness'
import { slotView, timing } from '../lib/slots'
import { clockReading } from '../store/select'
import { useChain } from '../store/context'
import { useNow } from '../usePoll'
import { ThemeToggle } from './ThemeToggle'

/**
 * The vitals, always in view.
 *
 * Mode, chain id, the head as it ticks, where the clock is in network mode,
 * whether the gateway has upstreams, and — the one that must not flatter —
 * how old the oldest answer on the page is.
 */
export function StatusStrip() {
  const { mode, settled, control, chainId, head, gateway, nodes, live } = useChain()
  const now = useNow(1000)

  const sources: Source<unknown>[] = [head, gateway, chainId, ...nodes.map((node) => node.row)]
  // Stale is judged from the worst source; "answered" names the most recent
  // one, because that is the question the words ask.
  const overall = mode === 'none' ? undefined : worst(sources, now)
  const recent = freshest(sources, now)
  const allStale =
    sources.length > 0 && sources.every((source) => freshness(source, now).kind === 'stale')

  const health = gateway.value
  const gatewayKind = !health
    ? 'pill-idle'
    : health.healthy === 0
      ? 'pill-wrong'
      : health.healthy < health.total
        ? 'pill-working'
        : 'pill-agree'

  const reading = clockReading(nodes, now)
  const t = reading ? timing(reading.beacon) : undefined
  const clock = reading && t ? slotView(now, t, reading.beacon.headSlot, reading.beacon.finalized) : undefined

  // What it said, if it is answering now — not the last thing it said before
  // it stopped.
  const version = control.error === undefined ? control.value?.version : undefined

  return (
    <div className="strip">
      <a className="brand" href="#/">
        Cupel
      </a>
      <span className={`pill ${mode === 'none' ? 'pill-idle' : 'pill-agree'}`}>
        <span className="dot" />
        {mode === 'none' ? (settled ? 'no chain' : 'looking…') : mode}
      </span>
      <Item label="chain id" value={chainId.value !== undefined ? String(chainId.value) : '—'} />
      <Item
        label="head"
        value={
          head.value ? (
            <a className="plain" href={`#/block/${head.value.number}`}>
              #{head.value.number}
            </a>
          ) : (
            '—'
          )
        }
        extra={mode === 'none' ? undefined : <Transport live={live.status === 'open'} />}
      />
      {clock && <Item label="slot · epoch" value={`${clock.clockSlot} · ${clock.epoch}`} />}
      {mode !== 'none' && (
        <a className="strip-link" href="#/gateway">
          <span className={`pill ${gatewayKind}`}>
            <span className="dot" />
            gateway {health ? `${health.healthy} of ${health.total}` : '—'}
          </span>
        </a>
      )}
      {overall && <FreshnessPill f={overall} recentMs={recent} everyStale={allStale} />}
      <span className="spacer" />
      <span className="panel-note mono">
        {version ? `v${version}` : control.error ? 'control room not answering' : ''}
      </span>
      <ThemeToggle />
    </div>
  )
}

function Item({ label, value, extra }: { label: string; value: ReactNode; extra?: ReactNode }) {
  return (
    <span className="strip-item">
      <span className="strip-label">{label}</span>
      <span className="row" style={{ gap: '0.4rem' }}>
        <span className="strip-value">{value}</span>
        {extra}
      </span>
    </span>
  )
}

function FreshnessPill({
  f,
  recentMs,
  everyStale,
}: {
  f: Freshness
  recentMs: number | undefined
  everyStale: boolean
}) {
  if (f.kind === 'never') {
    return (
      <span className="pill pill-idle">
        <span className="dot" />
        no answer yet
      </span>
    )
  }
  if (f.kind === 'fresh') {
    return (
      <span className="pill pill-agree">
        <span className="dot" />
        answered {ago(recentMs ?? f.ageMs)} ago
      </span>
    )
  }
  return (
    <span className={`pill ${everyStale ? 'pill-wrong' : 'pill-working'}`}>
      <span className="dot" />
      last answer {ago(f.ageMs)} ago
    </span>
  )
}
