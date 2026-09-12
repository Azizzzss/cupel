import { useState } from 'react'

/** One Engine API call, as the producer recorded it making it. */
interface Exchange {
  method: string
  request: unknown
  response: unknown
  elapsedMs: number
}

interface Produced {
  block: {
    number: number
    hash: string
    timestamp: number
    transactions: number
    gasUsed: number
  }
  exchanges: Exchange[]
}

/**
 * What each call is for.
 *
 * Keyed by method rather than by position, because the sequence uses
 * `forkchoiceUpdated` twice and the two uses are not the same job — the first
 * asks for a block, the last accepts one. Explaining them by index would put
 * the wrong words under the right call the moment the order changed.
 */
const EXPLAINS: Record<string, { title: string; text: string }[]> = {
  engine_forkchoiceUpdatedV3: [
    {
      title: 'Ask for a block',
      text: 'This call does two jobs at once. It states which block is the head, and — because payload attributes are attached — asks the client to start building the next one. The answer is a payload id, which is a receipt for work that has started, not a block.',
    },
    {
      title: 'Adopt it',
      text: 'The same method again, with no attributes this time, so it is only making the statement: this is the head now. Until this call the new block existed and was not the chain. Nothing is asked for, because nothing more is wanted.',
    },
  ],
  engine_getPayloadV3: [
    {
      title: 'Collect it',
      text: 'Hand back the payload id and take what was built. The client has had a moment to gather transactions from its pool; how long is the difference between an empty block and a full one.',
    },
  ],
  engine_newPayloadV3: [
    {
      title: 'Offer it back',
      text: 'The consensus side gives the block to the execution side to execute and check. Only VALID counts here. SYNCING and ACCEPTED are legitimate answers on a real network and would mean something is wrong on this one.',
    },
  ],
}

export function Walkthrough() {
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; data: Produced } | { kind: 'failed'; why: string }
  >({ kind: 'idle' })

  const run = async () => {
    setState({ kind: 'running' })
    try {
      // Same origin, always: the binary serves both, and the dev server proxies.
      const response = await fetch('/api/produce', { method: 'POST' })
      const body = await response.json()
      if (!response.ok) {
        setState({ kind: 'failed', why: body.error ?? `the control room answered ${response.status}` })
        return
      }
      setState({ kind: 'done', data: body as Produced })
    } catch {
      setState({
        kind: 'failed',
        why: 'the control room is not answering — it is served by `cupel up`, which is what holds the Engine API secret',
      })
    }
  }

  // Two uses of forkchoiceUpdated, and the explanation depends on which.
  const seen = new Map<string, number>()
  const explain = (method: string) => {
    const n = seen.get(method) ?? 0
    seen.set(method, n + 1)
    const entries = EXPLAINS[method]
    return entries?.[Math.min(n, entries.length - 1)]
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Make a block, and watch what it took</h2>
        <button className="button" onClick={run} disabled={state.kind === 'running'}>
          {state.kind === 'running' ? 'producing…' : 'Produce a block'}
        </button>
      </div>
      <div className="panel-body">
        <p className="dim" style={{ margin: 0, fontSize: '0.88rem' }}>
          Since the merge a node is two programs: one executes transactions and
          knows nothing about time, the other decides when a block happens and
          knows nothing about what is in it. They talk over one authenticated
          port, four calls per block. This runs that sequence on your chain and
          shows what went over the wire.
        </p>

        {state.kind === 'idle' && (
          <p className="panel-note" style={{ margin: 0 }}>
            Nothing is simulated here and nothing is pre-recorded. The block this
            makes is a real block, and the chain keeps it.
          </p>
        )}

        {state.kind === 'failed' && (
          <p style={{ margin: 0, color: 'var(--wrong)', fontSize: '0.87rem' }}>{state.why}</p>
        )}

        {state.kind === 'done' && (
          <>
            <div className="row" style={{ gap: '1.2rem' }}>
              <Stat label="block" value={String(state.data.block.number)} />
              <Stat label="transactions" value={String(state.data.block.transactions)} />
              <Stat label="gas" value={state.data.block.gasUsed.toLocaleString()} />
              <Stat
                label="round trips"
                value={`${state.data.exchanges.length}`}
              />
              <Stat
                label="total"
                value={`${state.data.exchanges.reduce((t, e) => t + e.elapsedMs, 0).toFixed(1)}ms`}
              />
            </div>
            <ol className="steps">
              {state.data.exchanges.map((exchange, index) => {
                const help = explain(exchange.method)
                return (
                  <li key={index} className="step">
                    <div className="step-head">
                      <span className="step-title">{help?.title ?? exchange.method}</span>
                      <span className="mono panel-note">{exchange.elapsedMs.toFixed(1)}ms</span>
                    </div>
                    <code className="mono step-method">{exchange.method}</code>
                    {help && <p className="step-text">{help.text}</p>}
                    <details>
                      <summary className="panel-note">what went over the wire</summary>
                      <pre className="wire">
                        <span className="faint">→ request</span>
                        {'\n'}
                        {JSON.stringify(exchange.request, null, 2)}
                        {'\n\n'}
                        <span className="faint">← response</span>
                        {'\n'}
                        {JSON.stringify(exchange.response, null, 2)}
                      </pre>
                    </details>
                  </li>
                )
              })}
            </ol>
          </>
        )}
      </div>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="stack" style={{ gap: '0.1rem' }}>
      <span className="panel-note">{label}</span>
      <span className="mono" style={{ fontSize: '1.05rem' }}>
        {value}
      </span>
    </span>
  )
}
