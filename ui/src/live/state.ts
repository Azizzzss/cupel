/** Where a socket or event stream is, as far as the page can tell. */
export interface LiveState {
  status: 'closed' | 'connecting' | 'open'
  /** Connection attempts since the last success; sets the backoff. */
  attempts: number
  /** When the status last changed, in milliseconds since the epoch. */
  since?: number
}

export const CLOSED: LiveState = { status: 'closed', attempts: 0 }
