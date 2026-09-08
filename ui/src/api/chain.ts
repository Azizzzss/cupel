// Talking to the chain.
//
// The browser reaches every client directly: geth runs with `--http.corsdomain
// '*'`, and each beacon node with its own equivalent, so there is no proxy in
// the way and nothing to keep in sync. It also means the network tab shows the
// real JSON-RPC and Beacon API traffic, which for this project is a feature
// rather than an implementation detail.

/** A JSON-RPC endpoint and the consensus client paired with it, if any. */
export interface NodeTarget {
  name: string
  rpc: string
  beacon?: string
  consensus?: string
}

/** Lab mode: one node behind the gateway, driven by a producer on the host. */
export const LAB: NodeTarget[] = [
  { name: 'lab', rpc: 'http://127.0.0.1:8545' },
]

/** Network mode: three execution clients, three different consensus clients. */
export const NETWORK: NodeTarget[] = [
  {
    name: 'node1',
    rpc: 'http://127.0.0.1:8555',
    beacon: 'http://127.0.0.1:5052',
    consensus: 'Lighthouse',
  },
  {
    name: 'node2',
    rpc: 'http://127.0.0.1:8556',
    beacon: 'http://127.0.0.1:5152',
    consensus: 'Prysm',
  },
  {
    name: 'node3',
    rpc: 'http://127.0.0.1:8557',
    beacon: 'http://127.0.0.1:5252',
    consensus: 'Teku',
  },
]

export type Mode = 'lab' | 'network' | 'none'

/** Everything a request can be, including the two ways it can fail. */
export type Answer<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unreachable' | 'refused' }

const TIMEOUT_MS = 2500

async function json(url: string, init?: RequestInit): Promise<Answer<unknown>> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: abort.signal })
    if (!response.ok) return { ok: false, reason: 'refused' }
    return { ok: true, value: await response.json() }
  } catch {
    // A client that is not running and a client that is starting up look
    // identical from here, and both are ordinary in a lab.
    return { ok: false, reason: 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

async function rpc(url: string, method: string, params: unknown[] = []) {
  return json(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

function hexToNumber(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Number.parseInt(value, 16)
  return Number.isFinite(parsed) ? parsed : undefined
}

/* ---------------------------------------------------------- execution layer */

export interface ExecutionHead {
  number: number
  hash: string
  transactions: number
  timestamp: number
  gasUsed: number
}

export async function executionHead(rpcUrl: string): Promise<Answer<ExecutionHead>> {
  const answer = await rpc(rpcUrl, 'eth_getBlockByNumber', ['latest', false])
  if (!answer.ok) return answer
  const block = (answer.value as { result?: Record<string, unknown> }).result
  if (!block) return { ok: false, reason: 'refused' }
  return {
    ok: true,
    value: {
      number: hexToNumber(block.number) ?? 0,
      hash: String(block.hash ?? ''),
      transactions: Array.isArray(block.transactions) ? block.transactions.length : 0,
      timestamp: hexToNumber(block.timestamp) ?? 0,
      gasUsed: hexToNumber(block.gasUsed) ?? 0,
    },
  }
}

export async function blockByNumber(
  rpcUrl: string,
  number: number,
): Promise<Answer<ExecutionHead>> {
  const answer = await rpc(rpcUrl, 'eth_getBlockByNumber', [
    `0x${number.toString(16)}`,
    false,
  ])
  if (!answer.ok) return answer
  const block = (answer.value as { result?: Record<string, unknown> }).result
  if (!block) return { ok: false, reason: 'refused' }
  return {
    ok: true,
    value: {
      number: hexToNumber(block.number) ?? 0,
      hash: String(block.hash ?? ''),
      transactions: Array.isArray(block.transactions) ? block.transactions.length : 0,
      timestamp: hexToNumber(block.timestamp) ?? 0,
      gasUsed: hexToNumber(block.gasUsed) ?? 0,
    },
  }
}

export async function chainId(rpcUrl: string): Promise<Answer<number>> {
  const answer = await rpc(rpcUrl, 'eth_chainId')
  if (!answer.ok) return answer
  const id = hexToNumber((answer.value as { result?: unknown }).result)
  return id === undefined ? { ok: false, reason: 'refused' } : { ok: true, value: id }
}

/* ---------------------------------------------------------- consensus layer */

export interface BeaconState {
  headSlot: number
  syncing: boolean
  justified: number
  finalized: number
  peers: number
  secondsPerSlot: number
  slotsPerEpoch: number
  genesisTime: number
}

function asNumber(value: unknown): number {
  return typeof value === 'string' ? (Number.parseInt(value, 10) || 0) : 0
}

export async function beaconState(beacon: string): Promise<Answer<BeaconState>> {
  const [syncing, checkpoints, peers, spec, genesis] = await Promise.all([
    json(`${beacon}/eth/v1/node/syncing`),
    json(`${beacon}/eth/v1/beacon/states/head/finality_checkpoints`),
    json(`${beacon}/eth/v1/node/peer_count`),
    json(`${beacon}/eth/v1/config/spec`),
    json(`${beacon}/eth/v1/beacon/genesis`),
  ])
  if (!syncing.ok) return syncing

  const data = (v: Answer<unknown>) =>
    v.ok ? ((v.value as { data?: Record<string, unknown> }).data ?? {}) : {}

  const sync = data(syncing)
  const finality = data(checkpoints) as Record<string, { epoch?: string }>
  const specData = data(spec)

  return {
    ok: true,
    value: {
      headSlot: asNumber(sync.head_slot),
      syncing: sync.is_syncing === true,
      justified: asNumber(finality.current_justified?.epoch),
      finalized: asNumber(finality.finalized?.epoch),
      peers: asNumber(data(peers).connected),
      // Asked for rather than assumed. Hard-coding these is exactly how the
      // control plane spent two releases claiming six-second slots on a chain
      // that was running twelve.
      secondsPerSlot: asNumber(specData.SECONDS_PER_SLOT) || 12,
      slotsPerEpoch: asNumber(specData.SLOTS_PER_EPOCH) || 32,
      genesisTime: asNumber(data(genesis).genesis_time),
    },
  }
}

/** The finalised beacon block root, which is what "do they agree" means. */
export async function finalizedRoot(beacon: string): Promise<Answer<string>> {
  const answer = await json(`${beacon}/eth/v1/beacon/headers/finalized`)
  if (!answer.ok) return answer
  const root = (answer.value as { data?: { root?: string } }).data?.root
  return root ? { ok: true, value: root } : { ok: false, reason: 'refused' }
}

/* -------------------------------------------------------------- the gateway */

export interface Upstream {
  name: string
  up: boolean
  forwarded: number
  errors: number
}

export async function gatewayHealth(
  gateway = 'http://127.0.0.1:8545',
): Promise<Answer<{ healthy: number; total: number; upstreams: Upstream[] }>> {
  const answer = await json(`${gateway}/health`)
  if (!answer.ok) return answer
  const body = answer.value as {
    healthy?: number
    total?: number
    upstreams?: Upstream[]
  }
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
 * Which mode is running, decided by asking rather than by being told.
 *
 * The control room is a static page: it can be opened from a file, from the
 * `cupel` binary, or from a dev server, and in every case the answer to "what
 * is up" is the same question put to the same ports.
 */
export async function detectMode(): Promise<Mode> {
  const [network, lab] = await Promise.all([
    chainId(NETWORK[0].rpc),
    chainId(LAB[0].rpc),
  ])
  if (network.ok) return 'network'
  if (lab.ok) return 'lab'
  return 'none'
}
