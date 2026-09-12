import { shortHash } from '../lib/format'
import { label } from '../lib/known'

/**
 * An address, by name when the page knows one.
 *
 * The four development accounts and the three genesis contracts are named;
 * everything else is shown short, with the whole thing a hover away.
 */
export function Address({ value }: { value?: string }) {
  if (!value) return <span className="faint">—</span>
  const known = label(value)
  return (
    <span className="mono" title={value}>
      {known ? <span className="tag">{known}</span> : shortHash(value, 10)}
    </span>
  )
}

export function BlockLink({ number }: { number: number }) {
  return (
    <a className="plain mono tnum" href={`#/block/${number}`}>
      #{number}
    </a>
  )
}

export function TxLink({ hash }: { hash: string }) {
  return (
    <a className="plain mono" href={`#/tx/${hash}`} title={hash}>
      {shortHash(hash, 10)}
    </a>
  )
}
