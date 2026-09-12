import { useEffect, useRef, useState } from 'react'
import { blockByNumber, type ExecutionHead } from '../api/chain'
import { KEEP, merge, missingRange } from '../lib/blocks'

/**
 * The recent window of blocks, kept up to date from a stream of heads.
 *
 * Backfilled on first sight so the page opens with history rather than filling
 * one row at a time; gap-filled after that, because polling against a chain
 * making a block a second means some blocks are simply never the head when
 * asked, and a reader's gaps must not look like a chain's. Capped, so a chain
 * left running overnight does not become an unbounded list.
 *
 * Pointing this at a different chain clears the window: the same block number
 * then means a different block, and keeping the rows would mix two chains.
 */
export function useFeed(rpc: string | undefined, head: ExecutionHead | undefined): ExecutionHead[] {
  const [blocks, setBlocks] = useState<ExecutionHead[]>([])
  // The newest number held or already asked for, so one gap is fetched once.
  // A ref because it must not cause a render, read and written only in effects
  // — never inside a state updater, which React may run twice.
  const newest = useRef<number | undefined>(undefined)
  const chain = useRef(rpc)

  useEffect(() => {
    if (chain.current !== rpc) {
      chain.current = rpc
      newest.current = undefined
      setBlocks([])
    }
    if (!rpc || !head) return
    if (newest.current !== undefined && head.number <= newest.current) return

    const gap = missingRange(newest.current, head.number, KEEP)
    newest.current = head.number
    setBlocks((current) => merge(current, [head], KEEP))
    if (!gap) return

    // In batches, so a reopened page against a long chain asks for fifty
    // blocks as two bursts the gateway takes in its stride, not one.
    void (async () => {
      for (let from = gap.from; from <= gap.to; from += 25) {
        const to = Math.min(gap.to, from + 24)
        const wanted = Array.from({ length: to - from + 1 }, (_, i) => from + i)
        const answers = await Promise.all(wanted.map((n) => blockByNumber(rpc, n)))
        // An answer to a question about another chain is not an answer.
        if (chain.current !== rpc) return
        const found = answers.flatMap((a) => (a.ok ? [a.value] : []))
        setBlocks((current) => merge(current, found, KEEP))
      }
    })()
  }, [rpc, head])

  return blocks
}
