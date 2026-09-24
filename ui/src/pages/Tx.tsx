import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { receipt as receiptOf, transaction } from '../api/execution'
import type { Answer } from '../api/transport'
import { Address, BlockLink } from '../components/Entity'
import { describeCall } from '../lib/abi'
import { formatEther, formatGwei, formatUnits, shortHash, withCommas } from '../lib/format'
import { label } from '../lib/known'
import { decodeLog, type DecodedLog } from '../lib/logs'
import type { Log, Receipt, TxDetail } from '../lib/parse'
import { PageHead } from '../shell/PageHead'
import { useChain } from '../store/context'
import { usePoll } from '../usePoll'

interface Found {
  tx: TxDetail | null
  receipt: Receipt | null
}

async function readTx(rpc: string, hash: string): Promise<Answer<Found>> {
  const [tx, receipt] = await Promise.all([transaction(rpc, hash), receiptOf(rpc, hash)])
  if (!tx.ok) return tx
  return { ok: true, value: { tx: tx.value, receipt: receipt.ok ? receipt.value : null } }
}

/**
 * One transaction: what was sent, and what happened to it.
 *
 * Three states, and the page names them: not seen (the hash is unknown here),
 * pending (the client has it and no block does), included (a receipt says
 * what it did). Lesson two of the walkthroughs, as a page.
 */
export function Tx({ hash }: { hash: string }) {
  const { feed, head } = useChain()
  const rpc = feed?.rpc ?? ''
  const found = usePoll(() => readTx(rpc, hash), 30_000, [rpc, hash], feed !== undefined)
  const headNumber = head.value?.number
  const unsettled = found.value === null || found.value?.tx === null || found.value?.receipt === null
  const refresh = found.refresh

  // A transaction still moving — unknown, pending, or included without its
  // receipt yet — is asked about again as each block arrives.
  useEffect(() => {
    if (unsettled && headNumber !== undefined) refresh()
  }, [unsettled, headNumber, refresh])

  const title = `Transaction ${shortHash(hash, 10)}`

  if (!feed) {
    return (
      <>
        <PageHead title={title} />
        <Empty>This page needs a chain. Start either mode and it will fill in on its own.</Empty>
      </>
    )
  }
  if (found.loading) {
    return (
      <>
        <PageHead title={title} />
        <Empty pulse>asking…</Empty>
      </>
    )
  }
  if (!found.value) {
    return (
      <>
        <PageHead title={title} />
        <Empty>No answer from the chain{found.error ? ` — ${found.error}` : ''}.</Empty>
      </>
    )
  }

  const { tx, receipt } = found.value
  if (!tx) {
    return (
      <>
        <PageHead title={title} lede={<span className="mono">{hash}</span>} />
        <Empty>
          Not seen here. The client has neither mined nor pooled this hash — it may
          belong to another chain, or never have been sent. This page will fill in
          if it turns up.
        </Empty>
      </>
    )
  }

  const state = tx.blockNumber === undefined ? 'pending' : receipt ? (receipt.status ? 'succeeded' : 'reverted') : 'included'
  const kind =
    state === 'succeeded' ? 'pill-agree' : state === 'reverted' ? 'pill-wrong' : 'pill-working'

  return (
    <>
      <PageHead title={title} lede={<span className="mono">{hash}</span>} />
      <section className="panel">
        <div className="panel-head">
          <h2>What was sent</h2>
          <span className={`pill ${kind}`}>
            <span className="dot" />
            {state}
          </span>
        </div>
        <div className="panel-body">
          <dl className="kv">
            <dt>block</dt>
            <dd>
              {tx.blockNumber === undefined ? (
                <span className="faint">in the pool, not yet in a block</span>
              ) : (
                <>
                  <BlockLink number={tx.blockNumber} />
                  {tx.index !== undefined && ` · position ${tx.index}`}
                </>
              )}
            </dd>
            <dt>from</dt>
            <dd>
              <Address value={tx.from} /> <span className="faint">{tx.from}</span>
            </dd>
            <dt>to</dt>
            <dd>
              {tx.to ? (
                <>
                  <Address value={tx.to} /> <span className="faint">{tx.to}</span>
                </>
              ) : (
                <span className="faint">none — this creates a contract</span>
              )}
            </dd>
            <dt>value</dt>
            <dd>{formatEther(tx.value, 18)} ETH</dd>
            <dt>nonce</dt>
            <dd>{tx.nonce}</dd>
            <dt>gas</dt>
            <dd>
              {withCommas(tx.gas)} offered
              {receipt && ` · ${withCommas(receipt.gasUsed)} used`}
            </dd>
            <dt>fee</dt>
            <dd>
              {tx.maxFeePerGas !== undefined
                ? `up to ${formatGwei(tx.maxFeePerGas)}, tip up to ${formatGwei(tx.maxPriorityFeePerGas ?? 0n)}`
                : tx.gasPrice !== undefined
                  ? `${formatGwei(tx.gasPrice)}, legacy pricing`
                  : '—'}
              {receipt?.effectiveGasPrice !== undefined && ` · paid ${formatGwei(receipt.effectiveGasPrice)}`}
            </dd>
            <dt>type</dt>
            <dd>{tx.type === undefined ? '—' : typeName(tx.type)}</dd>
            <dt>input</dt>
            <dd>
              {tx.input === '0x' ? (
                <span className="faint">none — a plain transfer</span>
              ) : (
                <>
                  {(tx.input.length - 2) / 2} bytes · selector {tx.input.slice(0, 10)}
                  {describeCall(tx.to, tx.input) && (
                    <span className="faint"> · {describeCall(tx.to, tx.input)}</span>
                  )}
                </>
              )}
            </dd>
            {receipt?.contractAddress && (
              <>
                <dt>created</dt>
                <dd>{receipt.contractAddress}</dd>
              </>
            )}
          </dl>
          <details>
            <summary className="panel-note">what the client said</summary>
            <pre className="wire">{JSON.stringify(tx.raw, null, 2)}</pre>
          </details>
        </div>
      </section>
      {receipt && <Logs logs={receipt.logs} />}
    </>
  )
}

function typeName(type: number): string {
  switch (type) {
    case 0:
      return '0 · legacy'
    case 1:
      return '1 · access list'
    case 2:
      return '2 · EIP-1559'
    case 3:
      return '3 · blob'
    default:
      return String(type)
  }
}

/**
 * What the transaction did, in the words of the contracts that saw it.
 *
 * The three genesis contracts' events are decoded by name; anything else is
 * shown as the topics and data it is. Amounts are shown with eighteen
 * decimals, which every genesis contract uses and a stranger might not.
 */
function Logs({ logs }: { logs: Log[] }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{logs.length === 0 ? 'No events' : `${logs.length} event${logs.length === 1 ? '' : 's'}`}</h2>
      </div>
      {logs.length > 0 && (
        <div className="panel-body">
          <ol className="steps">
            {logs.map((log) => {
              const decoded = decodeLog(log)
              const emitter = label(log.address)
              return (
                <li key={log.logIndex} className="step">
                  <div className="step-head">
                    <span className="step-title">
                      {decoded ? decoded.event : 'an event this page cannot name'}
                      {emitter && <span className="faint"> · {emitter}</span>}
                    </span>
                    <span className="mono panel-note">{shortHash(log.address, 10)}</span>
                  </div>
                  {decoded ? (
                    <Decoded log={decoded} known={emitter !== undefined} />
                  ) : (
                    <pre className="wire">
                      {log.topics.map((topic, i) => `topic ${i}  ${topic}`).join('\n')}
                      {'\n'}data     {log.data}
                    </pre>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </section>
  )
}

function Decoded({ log, known }: { log: DecodedLog; known: boolean }) {
  return (
    <dl className="kv" style={{ marginTop: '0.4rem' }}>
      {log.args.map((arg) => (
        <Row key={arg.name} name={arg.name}>
          {arg.kind === 'address' ? (
            <>
              <Address value={arg.value} /> <span className="faint">{arg.value}</span>
            </>
          ) : (
            <>
              {formatUnits(arg.value, 18, 18)}
              {!known && <span className="faint"> · eighteen decimals assumed</span>}
            </>
          )}
        </Row>
      ))}
    </dl>
  )
}

function Row({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  )
}

function Empty({ children, pulse = false }: { children: ReactNode; pulse?: boolean }) {
  return (
    <section className="panel">
      <div className="panel-body">
        <span className={pulse ? 'faint pulse' : 'dim'}>{children}</span>
      </div>
    </section>
  )
}
