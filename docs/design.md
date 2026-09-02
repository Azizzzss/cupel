# Cupel — design

A local Ethereum network you bring up with one command: real geth nodes finding
each other through a bootnode, real signing, real monitoring, and a shelf of
annotated reference contracts already deployed and waiting to be taken apart.

## The gap

| Neighbour | Built for | Why it isn't this |
|---|---|---|
| Anvil · Hardhat Node | Fast unit tests | One node, no consensus, no services around it |
| Kurtosis | Client teams testing clients | A test harness, not a place to learn contracts |
| eth-docker · Sedge | Staking operations | Points at mainnet; nothing to experiment on |
| Blockscout · Otterscan | Viewing a chain | A component to integrate, not a stack |

Nobody packages a chain as a **laboratory** — somewhere you spin up a real
network in one command and immediately have an explorer, a faucet, working
oracle price feeds, and heavily annotated ERC implementations already on chain.

## What geth can and cannot do

Geth's private-network guide now opens with a warning: *"this article is
outdated. By now geth is not able to seal Ethash or Clique blocks. It only works
in PoS mode and in concert with a consensus client."* Clique has been deprecated
since v1.14 and is *"not an option anymore."*

But those warnings are about **consensus**. The **networking** half of that page
still works exactly as written, and that half is the entire peer-to-peer story.

| Still valid — use verbatim | Dead — ignore |
|---|---|
| `--networkid` | `"clique": { period, epoch }` |
| `genesis.json` → `alloc` | `extraData` signer encoding |
| `geth init --datadir` | `--mine` |
| `bootnode -genkey` / `-nodekey` | `--miner.etherbase` |
| `--bootnodes enode://…?discport=` | `--miner.threads` |
| `--nat extip:` | `"ethash": {}` |
| `--netrestrict` | `difficulty` as a mining knob |
| `admin.nodeInfo.enr` · `admin.peers` | |

**The detail most setups get wrong:** post-merge there are *two* peer networks.
Execution nodes gossip **transactions** over devp2p; **blocks** travel on the
consensus network and reach geth locally through the Engine API. A cluster of
geth nodes wired together with a bootnode is real and useful — but on its own it
will never produce a block.

## Two tiers, one networking model

```
LAB MODE — cupel up
   cast · forge · MetaMask · viem
              |
   +----------v-----------+
   | gateway        :8545 |
   +----------+-----------+
              |
   +----------v-----------+  :8551  +----------------------+
   | geth           :8546 |<------->| block producer       |
   | execution            |   jwt   | engine api driver    |
   +----------------------+         +----------------------+
   instant - no sync - no disk


NETWORK MODE — cupel up --network
   +--------------------------------------+
   | gateway                         :8545 |
   +----+--------------+--------------+----+
        |              |              |
   +----v-----+  +-----v----+  +------v---+
   | node-1   |  | node-2   |  | node-3   |
   | geth     |  | geth     |  | geth     |
   | + light- |  | + prysm  |  | + teku   |
   |   house  |  |          |  |          |
   +----+-----+  +-----+----+  +------+---+
        +--------------+--------------+
                       | devp2p + discv5
                +------v-------+
                | bootnode     |  a regular geth node,
                | discovery    |  not cmd/bootnode
                +--------------+
   172.20.0.0/24 - --netrestrict - --nat extip: per node
```

Three *different* consensus clients is deliberate. A supermajority-client bug is
one of Ethereum's live risks, and a heterogeneous devnet where three independent
implementations agree on one chain is a far better demonstration than three
identical nodes.

## Own the hard parts, integrate the rest

A project that is only compose files and Grafana JSON reads as configuration,
not engineering. This is the line.

**Written here**

- **Control-plane CLI** — brings the network up, gates on health rather than
  sleeping, deploys and seeds, tears down cleanly
- **Engine API block producer** — `forkchoiceUpdated` → `getPayload` →
  `newPayload` on a timer; removes the consensus-client dependency from lab mode
- **Policy signer** — a held key behind value ceilings, recipient lists, and
  windowed count and spend limits, with an append-only audit log. Replaces Clef,
  which has been removed from go-ethereum
- **RPC gateway** — capability-aware routing, failover, circuit breaking,
  per-method rate limits, caching, metrics
- **Contract library** — annotated ERC implementations with Foundry tests, each
  demonstrating a real pitfall
- **Dashboards and alert rules** — fed by metrics the gateway emits

**Integrated**

geth · Lighthouse, Prysm, Teku · alloy (signing primitives) · Chainlink ·
Prometheus, Grafana · Blockscout · Postgres

## Gateway: a list and a capability set, never a singleton

Even with one upstream today, upstreams are modelled as a list with declared
capabilities. Sixty lines now; saves a rewrite the moment a second node exists,
which in network mode is immediately.

```rust
struct Upstream {
    name:         String,
    url:          Url,
    weight:       u32,
    health:       HealthState,   // from a background prober
    capabilities: Capabilities,
}

struct Capabilities {
    archive:   bool,   // can answer historical state
    trace:     bool,   // debug_ / trace_ namespaces
    tx_pool:   bool,   // txpool_ namespace
    max_batch: usize,
}
```

Routing resolves in a fixed order: **method policy, then health, then weight.** A
historical `eth_getBalance` demands `archive`; `debug_traceTransaction` demands
`trace`. When no healthy upstream has the capability the client gets a precise
error rather than a confusing failure from a node that could never have answered.

Explicitly **not** built: dynamic plugin loading, protocol translation for
non-JSON-RPC backends, per-chain adapter traits. The abstraction is over the list
and the capabilities — never over the protocol.

## Networking: three details that decide whether the mesh forms

1. **`--nat extip:` is mandatory inside Docker.** Without it geth advertises its
   container-internal address, peers dial back to something unroutable, and the
   mesh silently never forms.
2. **`--netrestrict` maps onto the bridge subnet.** `--netrestrict 172.20.0.0/24`
   means nodes only ever peer inside the network Cupel created.
3. **The bootnode is a normal geth node.** Geth's docs are explicit that
   `cmd/bootnode` is a developer tool and a regular node should be used for
   anything real.

### Ports

| Port | Service | Exposed |
|---|---|---|
| 8545 | Gateway — the only RPC anything should point at | yes |
| 8546 | geth JSON-RPC, per node | internal |
| 8551 | Engine API, JWT authenticated | internal |
| 30303 | devp2p, per node | internal |
| 8550 | Policy signer | internal |
| 5052 | Consensus client beacon API | internal |
| 3000 | Grafana | yes |
| 4000 | Blockscout | yes |
| 6688 | Chainlink node UI | yes |
| 8080 | Faucet | yes |

## Phases

Lettered in dependency order. Every phase ends at something demoable and gets a
tag — that discipline is what stops month seven from being "still not demoable."

| | Scope | Demo | Weight |
|---|---|---|---|
| **A** | Control plane and block producer | one command, a chain making blocks, cast connects | light |
| **B** | Contract library — ERC-20/Permit, 721, 1155, 4626, UUPS, WETH, Multicall3 | `cupel contracts`, then call any of them | light |
| **C** | Gateway and observability | kill an upstream, watch failover on the dashboard | light |
| **D** | Policy signing — a key held behind a rules engine | a transaction refused by policy, and the log proving why | light |
| **E** | The real network — 3 clients, bootnode, both discovery layers | three clients reaching finality; stop one, the rest continue | heavy |
| **F** | Oracle — Chainlink node, LINK, Operator, a job | a contract reads an off-chain price | heavy |
| **G** | Explorer and faucet | click through your own blocks in a browser | medium |

## Budget

| Stage | Memory | Disk | Containers |
|---|---|---|---|
| Lab mode, phases A–D | ~1.5 GB | negligible | 5 |
| Network mode, phase E | ~6 GB | 10–20 GB | 11 |
| + Phase F | ~7 GB | +2 GB | 13 |
| + Phase G | ~11 GB | +5 GB | 16 |

## Risks

- **Scope creep is the real threat, not difficulty.** Every phase is achievable.
  The failure mode is starting E and F before A–D ship. Tag a release at every
  boundary.
- **Post-merge genesis is the fiddliest single step.** Terminal total difficulty
  at zero, fork timestamps, matching validator keys, a JWT shared with each
  consensus client. Lift the configuration from Kurtosis' `ethereum-package`
  rather than deriving it — borrow the config, own the orchestration.
- **Three consensus clients means three sets of flags.** Client diversity is the
  point, but Lighthouse, Prysm and Teku disagree about almost every CLI
  convention. Get one working end to end before adding the second.
- **Chainlink is more work than it looks.** The node is the easy half; a deployed
  LINK token, an Operator contract, funded jobs and an external adapter are the
  other.
- **Blockscout is hungry.** An Elixir indexer plus its own Postgres. It stays
  opt-in rather than part of the default bring-up.
- **Run everything from the WSL filesystem.** Docker Desktop uses the WSL2
  backend, so containers are Linux regardless; bind-mounting from `/mnt/c` is
  slow enough to be noticeable.

## Decisions taken

1. **Name — Cupel.** Checked against collisions; the previous candidate
   (Crucible) is CMU SEI's virtual-environment framework, which occupies almost
   exactly this description.
2. **Scope — all seven phases**, protected by a release at every boundary.
3. **Consensus — real clients, three of them.** Lab mode uses the block producer
   written here; network mode runs Lighthouse, Prysm and Teku side by side.
4. **Gateway — upstreams are a list with capabilities** from the first commit,
   without any plugin machinery.
5. **Private until phase B lands**, then public.
