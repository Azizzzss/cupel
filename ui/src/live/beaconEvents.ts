/**
 * The Beacon API's event stream, as far as this page listens to it.
 *
 * Two topics: a new head, and a new finalised checkpoint. Both arrive as
 * server-sent events named after the topic, with a JSON body whose numbers are
 * strings, because that is how the Beacon API says numbers.
 */

export const EVENTS_PATH = '/eth/v1/events?topics=head,finalized_checkpoint'

export type BeaconEvent =
  | { kind: 'head'; slot: number; block: string }
  | { kind: 'finalized'; epoch: number; block: string }

export function parseBeaconEvent(name: string, data: string): BeaconEvent | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return undefined
  }
  if (typeof payload !== 'object' || payload === null) return undefined
  const fields = payload as Record<string, unknown>
  const block = typeof fields.block === 'string' ? fields.block : ''

  if (name === 'head') {
    const slot = decimal(fields.slot)
    return slot === undefined ? undefined : { kind: 'head', slot, block }
  }
  if (name === 'finalized_checkpoint') {
    const epoch = decimal(fields.epoch)
    return epoch === undefined ? undefined : { kind: 'finalized', epoch, block }
  }
  return undefined
}

function decimal(value: unknown): number | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined
}
