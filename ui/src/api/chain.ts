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

/** Lab mode: one node behind the gateway, driven by a producer on the host. */
export const LAB: NodeTarget[] = [{ name: 'lab', rpc: GATEWAY }]

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

/**
 * Fetch and parse, reporting the two ways that can fail separately.
 *
 * `accept` names statuses that are answers rather than refusals. The gateway's
 * `/health` returns 503 with a full body when every upstream is down — correct
 * for a load balancer, and exactly the moment the panel most needs to show
 * which upstreams are down. Treating every non-2xx as a refusal turned that
 * into "the gateway is not running".
 */
async function json(
  url: string,
  init?: RequestInit,
  accept: number[] = [],
): Promise<Answer<unknown>> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: abort.signal })
    if (!response.ok && !accept.includes(response.status)) return { ok: false, reason: 'refused' }
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
  /** From the same response as `finalized`, so the pair always belongs together. */
  finalizedRoot: string
  /** Undefined where the client did not say, rather than a number made up here. */
  peers: number | undefined
  secondsPerSlot: number | undefined
  slotsPerEpoch: number | undefined
  genesisTime: number | undefined
}

function asNumber(value: unknown): number {
  return typeof value === 'string' ? (Number.parseInt(value, 10) || 0) : 0
}

/** A number the client reported, or undefined if it reported none. */
function reported(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export async function beaconState(beacon: string): Promise<Answer<BeaconState>> {
  const [syncing, checkpoints, peers, spec, genesis] = await Promise.all([
    json(`${beacon}/eth/v1/node/syncing`),
    json(`${beacon}/eth/v1/beacon/states/head/finality_checkpoints`),
    json(`${beacon}/eth/v1/node/peer_count`),
    json(`${beacon}/eth/v1/config/spec`),
    json(`${beacon}/eth/v1/beacon/genesis`),
  ])
  // Finality is what this state is for, so a client that will not say where it
  // is has not answered — rather than reading as a chain at epoch zero.
  if (!syncing.ok) return syncing
  if (!checkpoints.ok) return checkpoints

  const data = (v: Answer<unknown>) =>
    v.ok ? ((v.value as { data?: Record<string, unknown> }).data ?? {}) : {}

  const sync = data(syncing)
  const finality = data(checkpoints) as Record<string, { epoch?: string; root?: string }>
  const specData = data(spec)

  return {
    ok: true,
    value: {
      headSlot: asNumber(sync.head_slot),
      syncing: sync.is_syncing === true,
      justified: asNumber(finality.current_justified?.epoch),
      finalized: asNumber(finality.finalized?.epoch),
      finalizedRoot: String(finality.finalized?.root ?? ''),
      peers: reported(data(peers).connected),
      // Asked for rather than assumed — and undefined when the answer did not
      // come. The comment here used to say that, directly above `|| 12` and
      // `|| 32`, so a failed request produced mainnet's numbers presented as
      // this chain's: the exact failure the comment was warning about.
      secondsPerSlot: reported(specData.SECONDS_PER_SLOT),
      slotsPerEpoch: reported(specData.SLOTS_PER_EPOCH),
      genesisTime: reported(data(genesis).genesis_time),
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

export async function gatewayHealth(
  gateway = GATEWAY,
): Promise<Answer<{ healthy: number; total: number; upstreams: Upstream[] }>> {
  const answer = await json(`${gateway}/health`, undefined, [503])
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
 * Which mode is running.
 *
 * Asked of the process that served this page first, because it knows. Guessing
 * from which fixed port answered misread a devnet started detached beside a lab
 * — the gateway on 8545 answers in both modes, and the network clients answer
 * whether or not anything is fronting them — and it could not work at all for a
 * page opened from another machine, where none of those ports are reachable.
 *
 * The probe is kept as a fallback, for a dev server started with nothing behind
 * it and a page opened from a file.
 */
export async function detectMode(control: string): Promise<Mode> {
  const told = await json(`${control}/api/mode`)
  if (told.ok) {
    const mode = (told.value as { mode?: unknown }).mode
    if (mode === 'lab' || mode === 'network') return mode
  }

  const [network, lab] = await Promise.all([
    chainId(NETWORK[0].rpc),
    chainId(LAB[0].rpc),
  ])
  if (network.ok) return 'network'
  if (lab.ok) return 'lab'
  return 'none'
}
