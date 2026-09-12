import { age, shortHash } from '../lib/format'
import { staleClass } from '../lib/freshness'
import { useChain } from '../store/context'
import { useFreshness, useNow } from '../usePoll'
import { BlockLink } from './Entity'
import { StaleNote, Transport } from './Stale'

/**
 * The last few blocks, as they arrive.
 *
 * The window itself lives in the store — backfilled, gap-filled, capped. This
 * shows the top of it.
 */
export function BlockFeed({ limit = 12 }: { limit?: number }) {
  const { blocks, head, live } = useChain()
  const freshness = useFreshness(head)
  const now = useNow(1000)
  const shown = blocks.slice(0, limit)

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Blocks, as they arrive</h2>
        <span className="row" style={{ gap: '0.5rem' }}>
          <Transport live={live.status === 'open'} />
          <a className="plain panel-note" href="#/blocks">
            all of them
          </a>
        </span>
      </div>
      <div className={staleClass(freshness, 'panel-body scroll-x')}>
        {shown.length === 0 ? (
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
              {shown.map((block) => (
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
      </div>
    </section>
  )
}
