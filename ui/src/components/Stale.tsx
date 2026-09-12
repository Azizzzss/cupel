import { ago } from '../lib/format'
import type { Freshness } from '../lib/freshness'

/**
 * What a panel says under numbers that may no longer be true.
 *
 * Nothing while the answers are fresh. Once they are not, the age of the last
 * one and why there has been none since — which is more use than a blank
 * panel, and more honest than a number that looks current.
 */
export function StaleNote({ freshness }: { freshness: Freshness }) {
  if (freshness.kind !== 'stale') return null
  const why =
    freshness.error === 'refused'
      ? ' · the last request was refused'
      : freshness.error === 'unreachable'
        ? ' · nothing is answering'
        : ''
  return (
    <p className="stale-note">
      last answer {ago(freshness.ageMs)} ago — showing what was true then{why}
    </p>
  )
}

/** Whether a panel's numbers arrive by socket or by asking. */
export function Transport({ live }: { live: boolean }) {
  return <span className={`tag ${live ? 'tag-live' : 'tag-polling'}`}>{live ? 'live' : 'polling'}</span>
}
