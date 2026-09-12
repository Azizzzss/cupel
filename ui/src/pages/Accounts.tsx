import { useEffect, useState } from 'react'
import { Address } from '../components/Entity'
import { StaleNote } from '../components/Stale'
import { formatEther, formatUnits } from '../lib/format'
import { staleClass } from '../lib/freshness'
import { PageHead } from '../shell/PageHead'
import { useChain } from '../store/context'
import { useAccounts, useContracts, type ContractReading } from '../store/useKnown'
import { useFreshness } from '../usePoll'

/**
 * The four accounts and the three contracts, as the chain sees them.
 *
 * The banner prints the accounts and the README lists the contracts; this is
 * the same shelf with live numbers on it, read while the page is open and not
 * otherwise.
 */
export function Accounts() {
  const { feed } = useChain()
  const rpc = feed?.rpc ?? ''
  const enabled = feed !== undefined
  const accounts = useAccounts(rpc, enabled)
  const contracts = useContracts(rpc, enabled)
  const accountsAge = useFreshness(accounts)
  const contractsAge = useFreshness(contracts)

  return (
    <>
      <PageHead
        title="Accounts and contracts"
        lede="Four funded accounts every development tool already knows, and three contracts that have been at the same addresses since block zero."
      />

      <section className="panel">
        <div className="panel-head">
          <h2>The accounts</h2>
          <span className="panel-note">10,000 ETH each at genesis · keys are public, for local use only</span>
        </div>
        <div className={staleClass(accountsAge, 'panel-body scroll-x')}>
          {!enabled ? (
            <span className="dim">This page needs a chain. Start either mode and it will fill in on its own.</span>
          ) : !accounts.value ? (
            <span className={accounts.loading ? 'faint pulse' : 'faint'}>
              {accounts.loading ? 'asking…' : 'no answer from the chain'}
            </span>
          ) : (
            <table className="plain">
              <thead>
                <tr>
                  <th>#</th>
                  <th>address</th>
                  <th>balance</th>
                  <th>nonce</th>
                  <th>key</th>
                </tr>
              </thead>
              <tbody>
                {accounts.value.map((account) => (
                  <tr key={account.address}>
                    <td className="num faint">{account.index}</td>
                    <td className="num">
                      <span className="mono" title={account.address}>
                        {account.address}
                      </span>
                    </td>
                    <td className="num">
                      {account.balance === undefined ? '—' : `${formatEther(account.balance, 4)} ETH`}
                    </td>
                    <td className="num">{account.nonce ?? '—'}</td>
                    <td>
                      <Key value={account.key} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <StaleNote freshness={accountsAge} />
          <p className="panel-note" style={{ margin: 0 }}>
            The nonce counts transactions sent; it is what a wallet needs to know to
            send the next one. Account 2 is the treasury the policy signer holds.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>The contracts</h2>
          <span className="panel-note">placed in genesis as bytecode — no deployment, no constructor, addresses that never move</span>
        </div>
        <div className={staleClass(contractsAge, 'panel-body')}>
          {!enabled ? (
            <span className="dim">Nothing to read until a chain is running.</span>
          ) : !contracts.value ? (
            <span className={contracts.loading ? 'faint pulse' : 'faint'}>
              {contracts.loading ? 'calling…' : 'no answer from the chain'}
            </span>
          ) : (
            <div className="grid grid-2">
              {contracts.value.map((contract) => (
                <Contract key={contract.address} reading={contract} />
              ))}
            </div>
          )}
          <StaleNote freshness={contractsAge} />
        </div>
      </section>
    </>
  )
}

function Contract({ reading }: { reading: ContractReading }) {
  const decimals = reading.decimals ?? 18
  const amount = (value: bigint | undefined) =>
    value === undefined ? '—' : `${formatUnits(value, decimals, 4)}${reading.symbol ? ` ${reading.symbol}` : ''}`
  return (
    <div className="panel" style={{ boxShadow: 'none' }}>
      <div className="panel-head">
        <h2>{reading.name}</h2>
        <span className="panel-note mono">{reading.title ?? '—'}</span>
      </div>
      <div className="panel-body">
        <dl className="kv">
          <dt>address</dt>
          <dd className="wrap">{reading.address}</dd>
          <dt>symbol</dt>
          <dd>
            {reading.symbol ?? '—'}
            {reading.decimals !== undefined && <span className="faint"> · {reading.decimals} decimals</span>}
          </dd>
          <dt>total supply</dt>
          <dd>{amount(reading.totalSupply)}</dd>
          {reading.kind === 'vault' && (
            <>
              <dt>asset</dt>
              <dd>
                <Address value={reading.asset} />
              </dd>
              <dt>holds</dt>
              <dd>{reading.totalAssets === undefined ? '—' : `${formatUnits(reading.totalAssets, 18, 4)} of it`}</dd>
            </>
          )}
        </dl>
        <p className="panel-note" style={{ margin: 0 }}>
          {reading.blurb}
          {reading.kind === 'weth' && ' Its supply is the ether it holds, not a number it keeps.'}
          {reading.kind === 'erc20' && ' Minting is how you get supply to play with.'}
        </p>
      </div>
    </div>
  )
}

/**
 * A private key, hidden until asked for.
 *
 * These four are published in every development tool and printed by the
 * banner on every start; a wallet needs one pasted in, which is what the
 * copy button is for. Hidden by default all the same, so a screen shared in
 * a call does not show them without a click.
 */
function Key({ value }: { value: string }) {
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      // No clipboard on a plain-http origin from another machine: reveal it
      // instead, and the reader can select it.
      setShown(true)
    }
  }

  return (
    <span className="row" style={{ gap: '0.4rem', flexWrap: 'nowrap' }}>
      <button className="button" type="button" onClick={() => setShown((s) => !s)}>
        {shown ? 'hide' : 'reveal'}
      </button>
      <button className="button" type="button" onClick={copy}>
        {copied ? 'copied' : 'copy'}
      </button>
      {shown && (
        <span className="mono faint" style={{ fontSize: '0.75rem' }}>
          {value}
        </span>
      )}
    </span>
  )
}
