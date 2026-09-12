import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { blockByNumber, executionHead, type ExecutionHead } from '../api/chain'
import { merge } from '../lib/blocks'
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
      void fill(rpc, latest.number - KEEP + 1, latest.number, setBlocks)
      return
    }

    // Poll every 1.5s against a chain making a block every second and some
    // blocks are simply never the head when asked. Adding only what the poll
    // returned leaves 590, 588, 586 — which reads as a chain missing blocks
    // rather than a reader missing them. Fetch what was skipped.
    setBlocks((current) => {
      const newest = current[0]?.number ?? latest.number
      if (latest.number - newest > 1) {
        void fill(rpc, newest + 1, latest.number - 1, setBlocks)
      }
      return merge(current, [latest], KEEP)
    })
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

/** Fetch an inclusive range of blocks and fold them in. */
async function fill(
  rpc: string,
  from: number,
  to: number,
  set: Dispatch<SetStateAction<ExecutionHead[]>>,
) {
  const wanted: number[] = []
  // Capped: a page left open while a chain runs away, or reopened against a
  // much longer chain, should not ask for thousands of blocks at once.
  for (let n = Math.max(0, to - KEEP + 1 > from ? to - KEEP + 1 : from); n <= to; n += 1) {
    wanted.push(n)
  }
  const answers = await Promise.all(wanted.map((n) => blockByNumber(rpc, n)))
  set((current) => merge(current, answers.flatMap((a) => (a.ok ? [a.value] : [])), KEEP))
}

function age(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}
