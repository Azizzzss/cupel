import { useEffect, useRef, useState } from 'react'
import { blockByNumber, executionHead, type ExecutionHead } from '../api/chain'
import { usePoll } from '../usePoll'

const KEEP = 12

/**
 * The last few blocks, as they arrive.
 *
 * Backfilled on first sight so the panel opens with history rather than filling
 * one row at a time, and capped so a chain left running overnight does not
 * become an unbounded list.
 */
export function BlockFeed({ rpc }: { rpc: string }) {
  const [blocks, setBlocks] = useState<ExecutionHead[]>([])
  // Whether the one-time backfill has been started. Kept in a ref because it
  // must not cause a render, and read and written only in effects — never
  // inside a state updater. See `merge` below.
  const backfilling = useRef(false)

  const { data: head } = usePoll(() => executionHead(rpc), 1500, [rpc])

  // Pointing this at a different chain has to clear the list — the same block
  // number then means a different block, and keeping the rows would mix two
  // chains together. That is done by giving the element a `key` of the endpoint
  // where it is used, so React discards this instance and mounts a fresh one.
  // Clearing state from an effect instead would work and would also render the
  // stale list once on the way past.

  useEffect(() => {
    if (!head?.ok) return
    const latest = head.value

    if (!backfilling.current) {
      backfilling.current = true
      const wanted: number[] = []
      for (let n = latest.number; n > Math.max(-1, latest.number - KEEP); n -= 1) {
        wanted.push(n)
      }
      void Promise.all(wanted.map((n) => blockByNumber(rpc, n))).then((answers) => {
        setBlocks((current) =>
          merge(current, answers.flatMap((a) => (a.ok ? [a.value] : []))),
        )
      })
      return
    }

    setBlocks((current) => merge(current, [latest]))
  }, [head, rpc])

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Blocks, as they arrive</h2>
        <span className="panel-note">newest first</span>
      </div>
      <div className="panel-body scroll-x">
        {blocks.length === 0 ? (
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
              {blocks.map((block) => (
                <tr key={block.hash || block.number}>
                  <td className="num name">{block.number}</td>
                  <td className="num faint">
                    {block.hash.slice(0, 10)}…{block.hash.slice(-4)}
                  </td>
                  <td
                    className="num"
                    style={{ color: block.transactions ? 'var(--glow)' : undefined }}
                  >
                    {block.transactions}
                  </td>
                  <td className="num faint">{block.gasUsed.toLocaleString()}</td>
                  <td className="num faint">{age(block.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

/**
 * Newest first, one row per block number, capped.
 *
 * Pure on purpose. This runs inside a state updater, and React invokes those
 * more than once — twice on every update under StrictMode. An earlier version
 * recorded which blocks it had seen in a ref from in here, so the second
 * invocation saw the first one's bookkeeping and discarded everything it had
 * just added: the requests all succeeded, and the panel showed one row.
 */
function merge(current: ExecutionHead[], found: ExecutionHead[]): ExecutionHead[] {
  const byNumber = new Map<number, ExecutionHead>()
  for (const block of [...current, ...found]) byNumber.set(block.number, block)
  return [...byNumber.values()].sort((a, b) => b.number - a.number).slice(0, KEEP)
}

function age(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}
