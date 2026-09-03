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
| `--bootnodes enode://…` | `--miner.etherbase` |
| `--nat extip:` | `--miner.threads` |
| `--netrestrict` | `"ethash": {}` |
| `admin.nodeInfo.enr` · `admin.peers` | `difficulty` as a mining knob |
| | `bootnode -genkey` / `-nodekey` |

The last row is a correction this plan needed after phase E: the `bootnode`
binary has been removed from go-ethereum and is not in the `alltools` image, so
every guide that starts with `bootnode -genkey` — geth's own included — no
longer runs. `devp2p discv4 listen` does the same job and takes the node key as
a hex string rather than a file.

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
                | bootnode     |  devp2p discv4 listen:
                | discovery    |  no chain, no rpc
                +--------------+
   a free 172.x.0.0/24 - --netrestrict - --nat extip: per node
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
2. **`--netrestrict` maps onto the bridge subnet**, so nodes only ever peer
   inside the network Cupel created. The subnet itself is chosen at generation
   time from what Docker has not already allocated: a fixed one collided with an
   unrelated project on the first machine this ran on, and Docker's error for
   that names no culprit.
3. **The bootnode is `devp2p discv4 listen`.** The plan said to use a normal
   geth node, on the strength of geth's own documentation calling `cmd/bootnode`
   a developer tool. Both halves are now out of date: `bootnode` has been
   removed from go-ethereum entirely and is absent from the `alltools` image,
   and `devp2p discv4 listen` is what replaced it — a discovery node that holds
   no chain and answers no RPC, which is exactly what a bootnode should be.

### Ports

| Port | Service | Exposed |
|---|---|---|
| 8545 | Gateway — the only RPC anything should point at | yes |
| 8546 | geth JSON-RPC, per node | internal |
| 8551 | Engine API, JWT authenticated | internal |
| 30303 | devp2p, per node | internal |
| 8550 | Policy signer | internal |
| 8555–8557 | Network mode: each node's JSON-RPC | yes |
| 5052 / 5152 / 5252 | Network mode: each beacon API | yes |
| 6061–6063, 6071–6073 | Network mode: execution and consensus metrics | yes |
| 9000 | Consensus p2p, per node | internal |
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

## What phase E actually cost

Two of the risks below were written before starting and both were right, so they
are worth keeping score against.

**"Three consensus clients means three sets of flags"** — understated, if
anything. Each client failed on its first run, in a way particular to it and for
reasons that had nothing to do with consensus:

| | Failure | Cause |
|---|---|---|
| Lighthouse | refused to start | `--datadir` and `--validators-dir` are mutually exclusive; the keystore directory *is* the data directory, because it holds the slashing protection database |
| Teku | crash loop, stack trace about a log appender | runs as an unprivileged user, and a named volume mounted where the image creates no directory arrives owned by root |
| Teku, again | `keystore file … already in use` | it writes a `.lock` beside each key and a container that is killed rather than stopped leaves them behind, so every restart after a crash reports a lock rather than the crash |
| Prysm | refused to start | `--accept-terms-of-use` |
| Prysm, again | a chain that never justified | dialled a `/tcp/` static peer instead of finding node 1 over QUIC, and the TCP connection half-opened — no error, no missed blocks, no attestations |

**"Post-merge genesis is the fiddliest single step"** — right about the
difficulty, wrong about the remedy. The plan said to lift the configuration from
Kurtosis. Better: use the generator Kurtosis itself calls,
`ethpandaops/ethereum-genesis-generator`, which produces the execution genesis,
the beacon state, the fork schedule and the validator keys as one consistent
set. It has no `latest` tag, which forces a pin — an inconvenience that turns
out to be the right behaviour.

Two things it does not do for you:

- **Genesis is stamped with `GENESIS_TIMESTAMP`, and the default is zero.** A
  chain beginning in 1970 is not obviously wrong from the file; it is obvious
  from every client spending its first minutes walking three hundred million
  empty slots.
- **The execution genesis `timestamp` is written in decimal.** geth accepts both
  (`HexOrDecimal64`), so it is correct — but reading it as hex, which the `0x`
  everywhere else trains you to do, produces a number a hundred times too large
  and a convincing false alarm.

**And one the plan did not anticipate: peering is per-client, and the fix for one
broke another.** Teku found nobody through discovery — it sat isolated with the
correct bootnode record in its configuration while the chain was a node short of
the two thirds it needs. So `network up` began handing out node 1's libp2p
address alongside its ENR, and Teku connected.

Giving the same address to Prysm broke Prysm. `CL_STATIC_PEER` is a `/tcp/`
multiaddr, because that is the form every client's static-peer flag accepts.
Given one, Prysm dialled it over TCP instead of finding node 1 over QUIC through
discovery, and that TCP connection half-opened: node 1 listed the peer as
connected while Prysm's own registry recorded it as disconnected and every one
of its transport counters read zero.

The symptom was not an error. Blocks propagated perfectly — no missed slots, all
three clients agreeing on every block — because a block only has to reach the
network once. Attestations did not, because a client with no peer in a gossip
mesh publishes into nothing. So the chain ran flawlessly and never justified, and
the only signal was a number that stayed at zero.

Prysm therefore gets the bootnode record and nothing else, Teku gets both, and
each keeps the path it can actually use. The general lesson is the uncomfortable
one: **three clients means three peering stories, and a change that fixes one can
silently disable another in a way that still looks healthy.**

## Budget

| Stage | Memory | Disk | Containers |
|---|---|---|---|
| Lab mode, phases A–D | ~1.5 GB | negligible | 5 |
| Network mode, phase E | ~6 GB | ~2 GB | 9 |
| + Phase F | ~7 GB | +2 GB | 13 |
| + Phase G | ~11 GB | +5 GB | 16 |

## Risks

- **Scope creep is the real threat, not difficulty.** Every phase is achievable.
  The failure mode is starting E and F before A–D ship. Tag a release at every
  boundary.
- ~~**Post-merge genesis is the fiddliest single step.**~~ Landed, and the
  remedy was better than the one planned — see above.
- ~~**Three consensus clients means three sets of flags.**~~ Landed, and worse
  than written: every one of the three failed on its first run, none of them for
  a reason to do with consensus.
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
6. **Genesis is generated, not committed.** `config/network/` holds validator
   keys and a beacon state stamped with the moment it was made; none of it is
   meaningful a day later, and `cupel network init` rebuilds it in under a
   minute. The lab genesis is committed for the opposite reason: it never
   changes unless a contract does, and committing it is what lets a clone bring
   a chain up with no Solidity toolchain installed.
7. **Both modes carry the same contracts.** Network genesis takes their bytecode
   from the committed lab genesis rather than recompiling, so the two cannot
   drift and neither needs Foundry to start.
