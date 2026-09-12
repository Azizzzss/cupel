import { useEffect } from 'react'
import { blockDetail } from '../api/execution'
import { Address, BlockLink, TxLink } from '../components/Entity'
import { age, formatEther, formatGwei, shortHash, withCommas } from '../lib/format'
import { utf8FromHex } from '../lib/hex'
import { PageHead } from '../shell/PageHead'
import { useChain } from '../store/context'
import { useNow, usePoll } from '../usePoll'

/**
 * One block, and what was in it.
 *
 * Asked for with its transactions in full. A block the chain does not have
 * yet is said to be not there yet, and asked for again as the head passes it.
 */
export function Block({ number }: { number: number }) {
  const { feed, head } = useChain()
  const rpc = feed?.rpc ?? ''
  // Immutable once mined, and the gateway caches the answer; the long interval
  // is only so a page left open sees a block that arrives later.
  const detail = usePoll(() => blockDetail(rpc, number), 30_000, [rpc, number], feed !== undefined)
  const now = useNow(1000)
  const headNumber = head.value?.number
  const notYet = detail.value === null
  const refresh = detail.refresh

  useEffect(() => {
    if (notYet && headNumber !== undefined && headNumber >= number) refresh()
  }, [notYet, headNumber, number, refresh])

  if (!feed) {
    return (
      <>
        <PageHead title={`Block #${number}`} />
        <Empty>This page needs a chain. Start either mode and it will fill in on its own.</Empty>
      </>
    )
  }
  if (detail.loading) {
    return (
      <>
        <PageHead title={`Block #${number}`} />
        <Empty pulse>asking…</Empty>
      </>
    )
  }
  if (detail.value === null || detail.value === undefined) {
    return (
      <>
        <PageHead title={`Block #${number}`} />
        <Empty>
          {detail.value === null
            ? `Not on this chain yet — the head is ${headNumber === undefined ? 'unknown' : `#${headNumber}`}. This page will fill in when it arrives.`
            : `No answer from the chain${detail.error ? ` — ${detail.error}` : ''}.`}
        </Empty>
      </>
    )
  }

  const b = detail.value
  const used = b.gasLimit > 0 ? Math.round((b.gasUsed / b.gasLimit) * 1000) / 10 : 0
  const extra = utf8FromHex(b.extraData)
  const next = headNumber !== undefined && headNumber > number ? number + 1 : undefined

  return (
    <>
      <PageHead
        title={`Block #${withCommas(b.number)}`}
        lede={
          <span className="row" style={{ gap: '1rem' }}>
            <span className="mono">{shortHash(b.hash, 12)}</span>
            <span>
              {number > 0 && <BlockLink number={number - 1} />}
              {number > 0 && next !== undefined && ' · '}
              {next !== undefined && <BlockLink number={next} />}
            </span>
          </span>
        }
      />
      <section className="panel">
        <div className="panel-head">
          <h2>The header</h2>
          <span className="panel-note">{age(b.timestamp, now)} ago</span>
        </div>
        <div className="panel-body">
          <dl className="kv">
            <dt>hash</dt>
            <dd>{b.hash}</dd>
            <dt>parent</dt>
            <dd>
              {number > 0 ? (
                <a className="plain" href={`#/block/${number - 1}`}>
                  {b.parentHash}
                </a>
              ) : (
                b.parentHash
              )}
            </dd>
            <dt>timestamp</dt>
            <dd>
              {b.timestamp} · {new Date(b.timestamp * 1000).toISOString()}
            </dd>
            <dt>gas</dt>
            <dd>
              {withCommas(b.gasUsed)} of {withCommas(b.gasLimit)} · {used}%
            </dd>
            <dt>base fee</dt>
            <dd>{b.baseFeePerGas === undefined ? '—' : formatGwei(b.baseFeePerGas)}</dd>
            <dt>fee recipient</dt>
            <dd>
              <Address value={b.miner} />
            </dd>
            <dt>extra data</dt>
            <dd>{extra ? `"${extra}"` : b.extraData}</dd>
            <dt>state root</dt>
            <dd>{b.stateRoot}</dd>
            {b.size !== undefined && (
              <>
                <dt>size</dt>
                <dd>{withCommas(b.size)} bytes</dd>
              </>
            )}
          </dl>
          <details>
            <summary className="panel-note">what the client said</summary>
            <pre className="wire">{JSON.stringify(b.raw, null, 2)}</pre>
          </details>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>
            {b.transactions.length === 0
              ? 'No transactions'
              : `${b.transactions.length} transaction${b.transactions.length === 1 ? '' : 's'}`}
          </h2>
        </div>
        {b.transactions.length > 0 && (
          <div className="panel-body scroll-x">
            <table className="plain">
              <thead>
                <tr>
                  <th>#</th>
                  <th>hash</th>
                  <th>from</th>
                  <th>to</th>
                  <th>value</th>
                  <th>gas</th>
                </tr>
              </thead>
              <tbody>
                {b.transactions.map((tx) => (
                  <tr key={tx.hash}>
                    <td className="num faint">{tx.index ?? '—'}</td>
                    <td className="num">
                      <TxLink hash={tx.hash} />
                    </td>
                    <td>
                      <Address value={tx.from} />
                    </td>
                    <td>{tx.to ? <Address value={tx.to} /> : <span className="faint">creates a contract</span>}</td>
                    <td className="num">{formatEther(tx.value)} ETH</td>
                    <td className="num faint">{withCommas(tx.gas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

function Empty({ children, pulse = false }: { children: React.ReactNode; pulse?: boolean }) {
  return (
    <section className="panel">
      <div className="panel-body">
        <span className={pulse ? 'faint pulse' : 'dim'}>{children}</span>
      </div>
    </section>
  )
}
