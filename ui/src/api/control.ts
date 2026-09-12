import { json, type Answer } from './transport'

/**
 * What the process serving this page says about itself.
 *
 * Same origin, always: served by the binary it is the same origin by
 * construction, and under `npm run dev` or `preview` Vite proxies `/api` to
 * it. The mode is the thing worth asking for — the process knows what it is,
 * where a page guessing from ports does not — and the version is worth
 * showing, because a page compiled into a binary is exactly as old as it.
 */
export interface ControlHealth {
  mode?: 'lab' | 'network'
  /** Whether this process can produce a block — lab mode's walkthrough button. */
  producing?: boolean
  version?: string
}

export async function controlHealth(): Promise<Answer<ControlHealth>> {
  const answer = await json('/api/mode')
  if (!answer.ok) return answer
  const body = answer.value as { mode?: unknown; producing?: unknown; version?: unknown }
  return {
    ok: true,
    value: {
      mode: body.mode === 'lab' || body.mode === 'network' ? body.mode : undefined,
      producing: typeof body.producing === 'boolean' ? body.producing : undefined,
      version: typeof body.version === 'string' ? body.version : undefined,
    },
  }
}
