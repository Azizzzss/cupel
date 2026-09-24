// Talking to the chain.
//
// The browser reaches every client directly: geth runs with `--http.corsdomain
// '*'`, and each beacon node with its own equivalent, so there is no proxy in
// the way and nothing to keep in sync. It also means the network tab shows the
// real JSON-RPC and Beacon API traffic, which for this project is a feature
// rather than an implementation detail.

import { hexToNumber } from '../lib/hex'
import { json, result, rpc, type Answer } from './transport'

export type { Answer } from './transport'

/** A JSON-RPC endpoint and the consensus client paired with it, if any. */
export interface NodeTarget {
  name: string
  rpc: string
  /** The same node's WebSocket, for `newHeads`; absent where none is published. */
  ws?: string
  beacon?: string
  /** Which execution client answers on `rpc`, where the page knows. */
  execution?: string
  consensus?: string
}

/**
 * Whether this page was opened on the machine running Cupel.
 *
 * It matters because the two kinds of address here are reachable from
 * different places. The gateway and the control room listen wherever `--bind`
 * put them, so a page opened from another machine can reach them at the host it
 * came from. The clients cannot be reached that way at all: Docker publishes
 * every client port on 127.0.0.1, so from anywhere else those panels can only
 * ever say "not answering".
 */
export const VIEWING_LOCALLY = ['', 'localhost', '127.0.0.1', '[::1]'].includes(
  window.location.hostname,
)

/** The gateway, at the host this page was served from. */
export const GATEWAY = `http://${VIEWING_LOCALLY ? '127.0.0.1' : window.location.hostname}:8545`

/**
 * Lab mode: one node behind the gateway, driven by a producer on the host.
 *
 * The socket is the node's own, not the gateway's — the gateway speaks HTTP
 * only — and it is published on 127.0.0.1 like every client port, so it is
 * offered only when the page is opened on the machine running Cupel.
 */
export const LAB: NodeTarget[] = [
  { name: 'lab', rpc: GATEWAY, ws: VIEWING_LOCALLY ? 'ws://127.0.0.1:8547' : undefined },
]

/**
 * Network mode: three nodes, two execution clients, three consensus clients.
 *
 * Mirrors `NODES` in `crates/cupel/src/network.rs`, and a Rust test reads this
 * file to check the pairings agree.
 */
export const NETWORK: NodeTarget[] = [
  {
    name: 'node1',
    rpc: 'http://127.0.0.1:8555',
    ws: 'ws://127.0.0.1:8558',
    beacon: 'http://127.0.0.1:5052',
    execution: 'geth',
    consensus: 'Lighthouse',
  },
  {
    name: 'node2',
    rpc: 'http://127.0.0.1:8556',
    ws: 'ws://127.0.0.1:8559',
    beacon: 'http://127.0.0.1:5152',
    execution: 'geth',
    consensus: 'Prysm',
  },
  {
    name: 'node3',
    rpc: 'http://127.0.0.1:8557',
    ws: 'ws://127.0.0.1:8560',
    beacon: 'http://127.0.0.1:5252',
    execution: 'Reth',
    consensus: 'Teku',
  },
]

export type Mode = 'lab' | 'network' | 'none'

/* ---------------------------------------------------------- execution layer */

export interface ExecutionHead {
  number: number
  hash: string
  transactions: number
  timestamp: number
  gasUsed: number
}

function asHead(block: Record<string, unknown>): ExecutionHead {
  return {
    number: hexToNumber(block.number) ?? 0,
    hash: String(block.hash ?? ''),
    transactions: Array.isArray(block.transactions) ? block.transactions.length : 0,
    timestamp: hexToNumber(block.timestamp) ?? 0,
    gasUsed: hexToNumber(block.gasUsed) ?? 0,
  }
}

async function headAt(rpcUrl: string, tag: string): Promise<Answer<ExecutionHead>> {
  const answer = await rpc(rpcUrl, 'eth_getBlockByNumber', [tag, false])
  if (!answer.ok) return answer
  const block = result(answer)
  if (!block || typeof block !== 'object') return { ok: false, reason: 'refused' }
  return { ok: true, value: asHead(block as Record<string, unknown>) }
}

export function executionHead(rpcUrl: string): Promise<Answer<ExecutionHead>> {
  return headAt(rpcUrl, 'latest')
}

export function blockByNumber(rpcUrl: string, number: number): Promise<Answer<ExecutionHead>> {
  return headAt(rpcUrl, `0x${number.toString(16)}`)
}

export async function chainId(rpcUrl: string): Promise<Answer<number>> {
  const answer = await rpc(rpcUrl, 'eth_chainId')
  if (!answer.ok) return answer
  const id = hexToNumber(result(answer))
  return id === undefined ? { ok: false, reason: 'refused' } : { ok: true, value: id }
}

/* ---------------------------------------------------------- consensus layer */

export interface BeaconState {
  headSlot: number
  syncing: boolean
  justified: number
  finalized: number
  /** From the same response as `finalized`, so the pair always belongs together. */
  finalizedRoot: string
  /** Undefined where the client did not say, rather than a number made up here. */
  peers: number | undefined
  secondsPerSlot: number | undefined
  slotsPerEpoch: number | undefined
  genesisTime: number | undefined
}

function asNumber(value: unknown): number {
  return typeof value === 'string' ? Number.parseInt(value, 10) || 0 : 0
}

/** A number the client reported, or undefined if it reported none. */
function reported(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

const data = (v: Answer<unknown>): Record<string, unknown> =>
  v.ok ? ((v.value as { data?: Record<string, unknown> }).data ?? {}) : {}

interface Constants {
  secondsPerSlot: number | undefined
  slotsPerEpoch: number | undefined
  genesisTime: number | undefined
}

const constants = new Map<string, Constants>()

/**
 * The slot time, the epoch length and the genesis time.
 *
 * Asked for rather than assumed — and undefined when the answer did not come.
 * The comment here used to say that, directly above `|| 12` and `|| 32`, so a
 * failed request produced mainnet's numbers presented as this chain's: the
 * exact failure the comment was warning about.
 *
 * None of the three ever changes, so a complete answer is kept per client and
 * two of the five requests a reading used to cost stop being made.
 */
async function chainConstants(beacon: string): Promise<Constants> {
  const known = constants.get(beacon)
  if (known) return known
  const [spec, genesis] = await Promise.all([
    json(`${beacon}/eth/v1/config/spec`),
    json(`${beacon}/eth/v1/beacon/genesis`),
  ])
  const found: Constants = {
    secondsPerSlot: reported(data(spec).SECONDS_PER_SLOT),
    slotsPerEpoch: reported(data(spec).SLOTS_PER_EPOCH),
    genesisTime: reported(data(genesis).genesis_time),
  }
  if (
    found.secondsPerSlot !== undefined &&
    found.slotsPerEpoch !== undefined &&
    found.genesisTime !== undefined
  ) {
    constants.set(beacon, found)
  }
  return found
}

export async function beaconState(beacon: string): Promise<Answer<BeaconState>> {
  const [syncing, checkpoints, peers, timing] = await Promise.all([
    json(`${beacon}/eth/v1/node/syncing`),
    json(`${beacon}/eth/v1/beacon/states/head/finality_checkpoints`),
    json(`${beacon}/eth/v1/node/peer_count`),
    chainConstants(beacon),
  ])
  // Finality is what this state is for, so a client that will not say where it
  // is has not answered — rather than reading as a chain at epoch zero.
  if (!syncing.ok) return syncing
  if (!checkpoints.ok) return checkpoints

  const sync = data(syncing)
  const finality = data(checkpoints) as Record<string, { epoch?: string; root?: string }>

  return {
    ok: true,
    value: {
      headSlot: asNumber(sync.head_slot),
      syncing: sync.is_syncing === true,
      justified: asNumber(finality.current_justified?.epoch),
      finalized: asNumber(finality.finalized?.epoch),
      finalizedRoot: String(finality.finalized?.root ?? ''),
      peers: reported(data(peers).connected),
      ...timing,
    },
  }
}

/* -------------------------------------------------------------- the gateway */

export interface Upstream {
  name: string
  up: boolean
  forwarded: number
  errors: number
}

export interface GatewayHealth {
  healthy: number
  total: number
  upstreams: Upstream[]
}

export async function gatewayHealth(gateway = GATEWAY): Promise<Answer<GatewayHealth>> {
  const answer = await json(`${gateway}/health`, undefined, [503])
  if (!answer.ok) return answer
  const body = answer.value as Partial<GatewayHealth>
  return {
    ok: true,
    value: {
      healthy: body.healthy ?? 0,
      total: body.total ?? 0,
      upstreams: body.upstreams ?? [],
    },
  }
}

/* ------------------------------------------------------------ mode detection */

/**
 * Which mode is running, guessed from which fixed port answers.
 *
 * The process that served this page knows what it is, and the page asks it
 * first — see `api/control`. This is the fallback for a page with no control
 * room behind it: a dev server started with nothing behind it, or a file. It
 * misreads a devnet started detached beside a lab, because the gateway on 8545
 * answers in both modes and the network clients answer whether or not anything
 * is fronting them, which is why it is the fallback and not the rule.
 */
export async function probeMode(): Promise<Mode> {
  const [network, lab] = await Promise.all([chainId(NETWORK[0].rpc), chainId(LAB[0].rpc)])
  if (network.ok) return 'network'
  if (lab.ok) return 'lab'
  return 'none'
}
