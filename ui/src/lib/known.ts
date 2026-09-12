/**
 * Addresses the page knows by name.
 *
 * Two lists that exist in Rust as well, mirrored here because the page has no
 * way to ask for them and no need to: neither ever changes. A test on the
 * Rust side reads this file and checks every address appears in it.
 */

/**
 * The four development accounts.
 *
 * Mirrors `DEV_ACCOUNTS` in `crates/cupel/src/main.rs` — same order, same
 * keys. Published keys, for local use only; the banner prints them on every
 * start, and pasting one into a wallet is what a development account is for.
 */
export const DEV_ACCOUNTS = [
  {
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  },
  {
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  },
  {
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  },
  {
    address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    key: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  },
] as const

export type ContractKind = 'erc20' | 'vault' | 'weth'

/**
 * The genesis contracts.
 *
 * Mirrors `CONTRACTS` in `crates/cupel/src/contracts.rs`. They are placed in
 * genesis as runtime bytecode, so the addresses are fixed for ever and the
 * trailing digits name the standard.
 */
export const CONTRACTS: readonly {
  name: string
  address: string
  kind: ContractKind
  blurb: string
}[] = [
  {
    name: 'Token',
    address: '0x00000000000000000000000000000000c0de0020',
    kind: 'erc20',
    blurb: 'ERC-20 with EIP-2612 permits. Anyone may mint.',
  },
  {
    name: 'Vault',
    address: '0x00000000000000000000000000000000c0de4626',
    kind: 'vault',
    blurb: 'ERC-4626 vault over Token, rounding on display.',
  },
  {
    name: 'Weth',
    address: '0x00000000000000000000000000000000c0de0009',
    kind: 'weth',
    blurb: 'Wrapped ether. Send it ether, get an ERC-20 balance.',
  },
]

/** A name for an address the page knows, whatever its case; undefined for strangers. */
export function label(address: string | undefined): string | undefined {
  if (!address) return undefined
  const wanted = address.toLowerCase()
  const account = DEV_ACCOUNTS.findIndex((a) => a.address.toLowerCase() === wanted)
  if (account >= 0) return `account ${account}`
  return CONTRACTS.find((c) => c.address === wanted)?.name
}
