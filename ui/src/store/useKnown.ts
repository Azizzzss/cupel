import { balance, call, nonce } from '../api/execution'
import type { Answer } from '../api/transport'
import { SELECTOR, decodeAddress, decodeString, decodeUint, encodeCall } from '../lib/abi'
import { CONTRACTS, DEV_ACCOUNTS, type ContractKind } from '../lib/known'
import { usePoll, type Poll } from '../usePoll'

/**
 * The accounts and the contracts, read from the chain.
 *
 * Balances and nonces are one request each; a contract's supply is one
 * `eth_call` with a hand-rolled selector, and its name, symbol and decimals —
 * constants in every genesis contract — are asked for once and kept.
 */

export interface AccountReading {
  index: number
  address: string
  key: string
  balance?: bigint
  nonce?: number
}

export interface ContractReading {
  name: string
  address: string
  kind: ContractKind
  blurb: string
  /** What the contract calls itself, from `name()`. */
  title?: string
  symbol?: string
  decimals?: number
  totalSupply?: bigint
  /** The vault's underlying token. */
  asset?: string
  /** What the vault holds of it. */
  totalAssets?: bigint
}

async function readAccounts(rpc: string): Promise<Answer<AccountReading[]>> {
  const readings = await Promise.all(
    DEV_ACCOUNTS.map(async (account, index) => {
      const [held, sent] = await Promise.all([
        balance(rpc, account.address),
        nonce(rpc, account.address),
      ])
      return {
        index,
        address: account.address,
        key: account.key,
        balance: held.ok ? held.value : undefined,
        nonce: sent.ok ? sent.value : undefined,
      }
    }),
  )
  return readings.some((reading) => reading.balance !== undefined)
    ? { ok: true, value: readings }
    : { ok: false, reason: 'unreachable' }
}

interface Identity {
  title?: string
  symbol?: string
  decimals?: number
}

const identities = new Map<string, Identity>()

async function identity(rpc: string, address: string): Promise<Identity> {
  const key = `${rpc} ${address}`
  const known = identities.get(key)
  if (known) return known
  const [title, symbol, decimals] = await Promise.all([
    call(rpc, address, encodeCall(SELECTOR.name)),
    call(rpc, address, encodeCall(SELECTOR.symbol)),
    call(rpc, address, encodeCall(SELECTOR.decimals)),
  ])
  const places = decimals.ok ? decodeUint(decimals.value) : undefined
  const found: Identity = {
    title: title.ok ? decodeString(title.value) : undefined,
    symbol: symbol.ok ? decodeString(symbol.value) : undefined,
    decimals: places === undefined || places > 255n ? undefined : Number(places),
  }
  if (found.title !== undefined && found.symbol !== undefined && found.decimals !== undefined) {
    identities.set(key, found)
  }
  return found
}

const nothing = Promise.resolve<Answer<string> | undefined>(undefined)

async function readContracts(rpc: string): Promise<Answer<ContractReading[]>> {
  const readings = await Promise.all(
    CONTRACTS.map(async (contract) => {
      const vault = contract.kind === 'vault'
      const [id, supply, asset, assets] = await Promise.all([
        identity(rpc, contract.address),
        call(rpc, contract.address, encodeCall(SELECTOR.totalSupply)),
        vault ? call(rpc, contract.address, encodeCall(SELECTOR.asset)) : nothing,
        vault ? call(rpc, contract.address, encodeCall(SELECTOR.totalAssets)) : nothing,
      ])
      return {
        ...contract,
        ...id,
        totalSupply: supply.ok ? decodeUint(supply.value) : undefined,
        asset: asset?.ok ? decodeAddress(asset.value) : undefined,
        totalAssets: assets?.ok ? decodeUint(assets.value) : undefined,
      }
    }),
  )
  return readings.some((reading) => reading.totalSupply !== undefined)
    ? { ok: true, value: readings }
    : { ok: false, reason: 'unreachable' }
}

export function useAccounts(rpc: string, enabled: boolean): Poll<AccountReading[]> {
  return usePoll(() => readAccounts(rpc), 2000, [rpc], enabled)
}

export function useContracts(rpc: string, enabled: boolean): Poll<ContractReading[]> {
  return usePoll(() => readContracts(rpc), 2000, [rpc], enabled)
}
