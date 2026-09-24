import { useEffect, useRef } from 'react'
import { nonce, txpoolContent, txpoolStatus } from '../api/execution'
import type { Answer } from '../api/transport'
import { Address, TxLink } from '../components/Entity'
import { StaleNote } from '../components/Stale'
import { formatEther, formatGwei, withCommas } from '../lib/format'
import { staleClass } from '../lib/freshness'
import {
  queuedSenders,
  remember,
  timeInPool,
  track,
  waitingFor,
  type Pool as PoolContent,
  type PoolTx,
  type Sighting,
} from '../lib/pool'
import { PageHead } from '../shell/PageHead'
import { useChain } from '../store/context'
import { useFreshness, useNow, usePoll } from '../usePoll'

/** A reading of the pool, with what the page has worked out from the ones before. */
interface Reading {
  pool: PoolContent
  seen: ReadonlyMap<string, Sighting>
  history: Sighting[]
}

/**
 * What the node has accepted and not yet put in a block.
 *
 * Every other page shows transactions that ran. This is where they wait first,
 * and it is the answer to the commonest bug in anything that sends them: a hash
 * back from `eth_sendRawTransaction` means the transaction is *here*, not that
 * it has happened.
 */
export function Pool() {
  const { feed, mode, head, nodes } = useChain()
  const rpc = feed?.rpc ?? ''
  const enabled = feed !== undefined
  // Four times a second in lab mode. A lab transaction spends under a second
  // here, and reading once a second — which also lands just after each block,
  // when the pool has just been emptied — showed an empty table and timed
  // everything that left at 0.0s. The node is local and the answer is small.
  const every = mode === 'network' ? 1000 : 250

  // Following transactions from one reading to the next happens inside the
  // poll rather than in an effect, so each reading is compared with exactly the
  // one before it — and a different node starts from nothing.
  const memory = useRef<{ rpc: string; seen: Map<string, Sighting>; history: Sighting[]; at?: number }>({
    rpc,
    seen: new Map(),
    history: [],
  })
  const reading = usePoll<Reading>(
    async (): Promise<Answer<Reading>> => {
      const answer = await txpoolContent(rpc)
      if (!answer.ok) return answer
      if (memory.current.rpc !== rpc) memory.current = { rpc, seen: new Map(), history: [] }
      const at = Date.now()
      const { seen, left } = track(memory.current.seen, answer.value, at, memory.current.at)
      memory.current.at = at
      memory.current.seen = seen
      memory.current.history = remember(memory.current.history, left)
      return { ok: true, value: { pool: answer.value, seen, history: memory.current.history } }
    },
    every,
    [rpc],
    enabled,
  )
  const age = useFreshness(reading)
  const now = useNow(500)

  // A new block is exactly when the pool changes, so look then as well.
  const refresh = reading.refresh
  const headNumber = head.value?.number
  useEffect(() => {
    if (headNumber !== undefined) refresh()
  }, [headNumber, refresh])

  // For a queued transaction, the nonce it waits for depends on the sender's
  // account when nothing of theirs is pending — so ask, but only about those.
  const senders = queuedSenders(reading.value?.pool)
  const chainNonces = usePoll<Record<string, number>>(
    async () => {
      const answers = await Promise.all(senders.map((sender) => nonce(rpc, sender)))
      const out: Record<string, number> = {}
      answers.forEach((answer, i) => {
        if (answer.ok) out[senders[i]] = answer.value
      })
      return { ok: true, value: out }
    },
    2000,
    [rpc, senders.join(',')],
    enabled && senders.length > 0,
  )

  const statuses = usePoll(
    async () => {
      const answers = await Promise.all(nodes.map((node) => txpoolStatus(node.target.rpc)))
      return { ok: true as const, value: answers }
    },
    2000,
    [nodes.map((node) => node.target.rpc).join(',')],
    mode === 'network' && nodes.length > 0,
  )

  const pool = reading.value?.pool
  const gaps = pool ? waitingFor(pool, chainNonces.value ?? {}) : new Map<string, number>()
  const since = (hash: string) => {
    const first = reading.value?.seen.get(hash)?.firstSeen
    return first === undefined ? '—' : seconds(now - first)
  }

  return (
    <>
      <PageHead
        title="Waiting to be included"
        lede="What the node has accepted and not yet put in a block. A hash back from eth_sendRawTransaction means the transaction is here — not that it has run."
      />

      <section className="panel">
        <div className="panel-head">
          <h2>Pending — ready for the next block</h2>
          <span className="panel-note">
            {pool ? `${pool.pending.length} waiting · ` : ''}read every {every} ms
          </span>
        </div>
        <div className={staleClass(age, 'panel-body scroll-x')}>
          {!enabled ? (
            <span className="dim">This page needs a chain. Start either mode and it will fill in on its own.</span>
          ) : !pool ? (
            <span className={reading.loading ? 'faint pulse' : 'faint'}>
              {reading.loading ? 'asking…' : 'the node would not say what it is holding'}
            </span>
          ) : pool.pending.length === 0 ? (
            <p className="panel-note" style={{ margin: 0 }}>
              Nothing waiting. {mode === 'network' ? 'A block comes every twelve seconds' : 'A block is made every second'}, and
              it takes whatever is ready, so a transaction usually passes through here
              {mode === 'network' ? ' within a slot' : ' in under a second'}. Run{' '}
              <span className="mono">cupel traffic</span> in another terminal to watch them go by.
            </p>
          ) : (
            <PoolTable rows={pool.pending} since={since} />
          )}
          <StaleNote freshness={age} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Queued — accepted, and waiting on something</h2>
          <span className="panel-note">{pool ? `${pool.queued.length} parked` : ''}</span>
        </div>
        <div className={staleClass(age, 'panel-body scroll-x')}>
          {pool && pool.queued.length > 0 && <PoolTable rows={pool.queued} since={since} gaps={gaps} />}
          <p className="panel-note" style={{ margin: 0 }}>
            {pool && pool.queued.length === 0 ? 'Nothing queued. ' : ''}
            A sender's transactions run in nonce order, one after another. Send nonce 7
            before 6 and the node accepts it — it answers with a hash like any other —
            then parks it here, where no block will take it until 6 arrives. Nothing
            reports an error, because nothing is wrong yet. <span className="mono">cupel traffic</span>{' '}
            does this on purpose now and then.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Just left</h2>
          <span className="panel-note">timed from when this page looked, so as a range</span>
        </div>
        <div className={staleClass(age, 'panel-body scroll-x')}>
          {!reading.value || reading.value.history.length === 0 ? (
            <span className="faint">nothing has left the pool since this page opened</span>
          ) : (
            <table className="plain">
              <thead>
                <tr>
                  <th>transaction</th>
                  <th>from</th>
                  <th className="num">nonce</th>
                  <th>what</th>
                  <th className="num">in the pool</th>
                </tr>
              </thead>
              <tbody>
                {reading.value.history.map((sighting) => (
                  <tr key={sighting.hash}>
                    <td>
                      <TxLink hash={sighting.hash} />
                    </td>
                    <td>
                      <Address value={sighting.from} />
                    </td>
                    <td className="num">{sighting.nonce}</td>
                    <td>
                      {sighting.what ?? <span className="faint">unknown call</span>}
                      {sighting.wasQueued && <span className="faint"> · was queued</span>}
                    </td>
                    <td className="num">{stay(timeInPool(sighting))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="panel-note" style={{ margin: 0 }}>
            Leaving the pool usually means a block took it — but a transaction replaced
            by another with the same nonce and a higher fee leaves too, and so does one
            the node dropped. Open it: the transaction page says which block, if any.
          </p>
        </div>
      </section>

      {mode === 'network' && (
        <section className="panel">
          <div className="panel-head">
            <h2>Every node has its own pool</h2>
          </div>
          <div className="panel-body scroll-x">
            <table className="plain">
              <thead>
                <tr>
                  <th>node</th>
                  <th className="num">pending</th>
                  <th className="num">queued</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node, i) => {
                  const answer = statuses.value?.[i]
                  return (
                    <tr key={node.target.name}>
                      <td>
                        <span className="name">{node.target.name}</span>
                      </td>
                      <td className="num">{answer?.ok ? answer.value.pending : '—'}</td>
                      <td className="num">{answer?.ok ? answer.value.queued : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="panel-note" style={{ margin: 0 }}>
              A transaction is sent to one node and passed on to the others over devp2p,
              so for a moment after every send the three disagree about what is waiting.
              There is no network-wide pool — only each node's view of one. A queued
              transaction is not passed on at all until it can run.
            </p>
          </div>
        </section>
      )}
    </>
  )
}

function PoolTable({
  rows,
  since,
  gaps,
}: {
  rows: PoolTx[]
  since: (hash: string) => string
  gaps?: Map<string, number>
}) {
  return (
    <table className="plain">
      <thead>
        <tr>
          <th>transaction</th>
          <th>from</th>
          <th className="num">nonce</th>
          <th>what</th>
          <th className="num">value</th>
          <th className="num">tip</th>
          <th className="num">gas</th>
          <th className="num">{gaps ? 'waiting for' : 'here for'}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((tx) => (
          <tr key={tx.hash}>
            <td>
              <TxLink hash={tx.hash} />
            </td>
            <td>
              <Address value={tx.from} />
            </td>
            <td className="num">{tx.nonce}</td>
            <td>
              {tx.what ?? <span className="faint mono">{tx.input.slice(0, 10)}</span>}
              {tx.what === 'ether payment' && (
                <>
                  {' '}
                  <span className="faint">to</span> <Address value={tx.to} />
                </>
              )}
            </td>
            <td className="num">{tx.value === 0n ? <span className="faint">0</span> : `${formatEther(tx.value, 4)} ETH`}</td>
            <td className="num">
              {tx.maxPriorityFeePerGas !== undefined
                ? formatGwei(tx.maxPriorityFeePerGas)
                : tx.gasPrice !== undefined
                  ? formatGwei(tx.gasPrice)
                  : '—'}
            </td>
            <td className="num">{withCommas(tx.gas)}</td>
            <td className="num">
              {gaps ? (
                gaps.has(tx.hash) ? (
                  <>nonce {gaps.get(tx.hash)}</>
                ) : (
                  <span className="faint">—</span>
                )
              ) : (
                since(tx.hash)
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** A stay in the pool, as the range the readings allow. */
function stay({ least, most }: { least: number; most?: number }): string {
  if (most === undefined) return `at least ${seconds(least)}`
  if (least < 50) return `under ${seconds(most)}`
  return `${seconds(least)}–${seconds(most)}`
}

function seconds(ms: number): string {
  return ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`
}
