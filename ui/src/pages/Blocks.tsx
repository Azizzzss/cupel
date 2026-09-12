import { useState } from 'react'
import { blockByNumber, type ExecutionHead } from '../api/chain'
import { BlockLink } from '../components/Entity'
import { StaleNote, Transport } from '../components/Stale'
import { merge } from '../lib/blocks'
import { age, shortHash } from '../lib/format'
import { staleClass } from '../lib/freshness'
import { PageHead } from '../shell/PageHead'
import { useChain } from '../store/context'
import { useFreshness, useNow } from '../usePoll'

/** How far back the page will go. Enough to see a pattern; not a history. */
const MOST = 500
const PAGE = 50

/**
 * The recent window, and older on request.
 *
 * The store's fifty arrive on their own; the rest are asked for in pages of
 * fifty below the oldest shown, and the page stops at five hundred and says
 * so. This is the recent window, not an explorer — an explorer indexes; this
 * asks.
 */
export function Blocks() {
  const { blocks, head, feed, live } = useChain()
  const freshness = useFreshness(head)
  const now = useNow(1000)
  const [older, setOlder] = useState<ExecutionHead[]>([])
  const [loading, setLoading] = useState(false)

  const all = merge(blocks, older, MOST)
  const oldest = all[all.length - 1]?.number
  const exhausted = oldest === 0 || all.length >= MOST

  const loadOlder = async () => {
    if (!feed || oldest === undefined || exhausted || loading) return
    setLoading(true)
    const to = oldest - 1
    const from = Math.max(0, to - PAGE + 1)
    const found: ExecutionHead[] = []
    for (let start = from; start <= to; start += 25) {
      const end = Math.min(to, start + 24)
      const wanted = Array.from({ length: end - start + 1 }, (_, i) => start + i)
      const answers = await Promise.all(wanted.map((n) => blockByNumber(feed.rpc, n)))
      found.push(...answers.flatMap((a) => (a.ok ? [a.value] : [])))
    }
    setOlder((current) => merge(current, found, MOST))
    setLoading(false)
  }

  return (
    <>
      <PageHead
        title="Blocks"
        lede="The recent window, newest first. Open one for what was in it."
      />
      <section className="panel">
        <div className="panel-head">
          <h2>{all.length === 0 ? 'Waiting for a block' : `The last ${all.length}`}</h2>
          <Transport live={live.status === 'open'} />
        </div>
        <div className={staleClass(freshness, 'panel-body scroll-x')}>
          {all.length === 0 ? (
            <span className="faint pulse">waiting for a block…</span>
          ) : (
            <table className="plain">
              <thead>
                <tr>
                  <th>number</th>
                  <th>hash</th>
                  <th>txs</th>
                  <th>gas</th>
                  <th>age</th>
                </tr>
              </thead>
              <tbody>
                {all.map((block) => (
                  <tr key={block.hash || block.number}>
                    <td className="name">
                      <BlockLink number={block.number} />
                    </td>
                    <td className="num faint">{shortHash(block.hash, 10)}</td>
                    <td
                      className="num"
                      style={{ color: block.transactions ? 'var(--glow)' : undefined }}
                    >
                      {block.transactions}
                    </td>
                    <td className="num faint">{block.gasUsed.toLocaleString()}</td>
                    <td className="num faint">{age(block.timestamp, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <StaleNote freshness={freshness} />
          {all.length > 0 && (
            <div className="row">
              <button className="button" onClick={loadOlder} disabled={exhausted || loading}>
                {loading ? 'asking…' : 'Load fifty older'}
              </button>
              <span className="panel-note">
                {oldest === 0
                  ? 'back to genesis'
                  : all.length >= MOST
                    ? `${MOST} is as far as this page goes — it is a window, not an explorer`
                    : `oldest shown is #${oldest}`}
              </span>
            </div>
          )}
        </div>
      </section>
    </>
  )
}
