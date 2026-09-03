# Changelog

Every phase of the [roadmap](README.md#roadmap) ships as a tagged release. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

Phase F: a Chainlink oracle.

---

## [0.5.0] — Phase E: the multi-client network

`cupel network up`: nine containers, three consensus clients, sixty-four
validators and a chain that finalises.

### Added

- **Network mode** — a discovery bootnode, three geth nodes, and Lighthouse,
  Prysm and Teku each driving one of them. Validators split 22/21/21, so no
  single node can finalise alone.
- **Generated devnet** — genesis, beacon state and validator keys from
  ethPandaOps' generator, pinned to `6.2.1`, with the fork schedule active from
  block zero.
- `cupel network up` / `init` / `down` / `reset` / `status`. Status queries all
  three nodes and prints their block, slot, justified and finalised epochs and
  peer count side by side, because three clients agreeing is the thing worth
  showing — and because a client with no peers is the failure this mode actually
  produces, invisible in every other number on the line.
- **Prometheus scrapes both layers** of all three nodes, and a second Grafana
  dashboard, *Cupel — network*, graphs what they each say. Targets that are down
  in lab mode report as down, which is the honest answer.

### Notes

- **`bootnode` no longer exists.** It has been removed from go-ethereum and is
  absent from the `alltools` image. `devp2p discv4 listen` replaces it — the
  same job, and still a discovery-only node holding no chain.
- **Genesis is stamped at generation time, and regenerated only when there is no
  chain to resume.** Left at the generator's default the chain starts in 1970
  and every client walks three hundred million empty slots first; regenerated
  unconditionally, a restart would silently replace the chain under the data.
- **Peering is per-client, and each needs a different answer.** Teku found nobody
  through discovery and sat isolated, so `up` hands out node 1's libp2p address
  alongside its ENR. Giving the same address to Prysm broke Prysm: it dialled the
  `/tcp/` multiaddr instead of finding node 1 over QUIC, and that connection
  half-opened — node 1 listed the peer as connected while Prysm counted none.
  Blocks still propagated, so nothing looked wrong; attestations did not, so the
  chain never justified. Prysm gets the bootnode record and nothing else.
- **The subnet is chosen, not fixed.** A hard-coded one collided with an
  unrelated project, and Docker's error for that names no culprit. Ranges Docker
  allocates itself and the range WSL uses for its own interface are both skipped.
- Nodes 2 and 3 cannot start until node 1 has an ENR to give them, which is a
  dependency on a value produced by a container compose started — and most of
  the reason the control plane exists.
- **geth serves Prometheus at `/debug/metrics/prometheus`, not `/metrics`.** The
  wrong path gives a target that answers, scrapes clean, and yields nothing.
- The three consensus clients agree on `beacon_head_slot` and
  `beacon_finalized_epoch`, and on nothing about peer counts — not the metric
  name and not the semantics. Shown per client rather than reconciled.

### Fixed

- The workspace version had stayed at `0.1.0` through four tagged releases, so
  `cupel --version` reported `0.1.0` on all of them. It is `0.5.0` now, and
  bumping it belongs in the same commit as the tag.
- **`network up` was not idempotent.** It re-read node 1's ENR every time and
  wrote it back, and an ENR's sequence number moves constantly — so compose saw
  changed configuration for nodes 2 and 3 and recreated them. Recreating a
  consensus client drops every peer it had. Running the command twice therefore
  took the consensus layer apart. The identity is now fetched only when it is
  not already known, which is correct because node 1 keeps its key, address and
  ports across restarts and a stale sequence number still bootstraps.
- **Teku custodied a seventh of the data columns the other two expected.** It
  advertised `custody_group_count: 21` against Lighthouse's and Prysm's 128,
  because `--p2p-subscribe-all-custody-subnets-enabled` is separate from
  `--p2p-subscribe-all-subnets-enabled`. With it set, the chain went from a
  missed slot every ten or so to none at all.

---

## [0.4.0] — Phase D: policy signing

A signing service on `:8550` holding a key that callers cannot use freely.

### Added

- **Policy engine** — per-transaction value and gas ceilings, an optional
  recipient allowlist, a blocklist that beats it, whether the key may deploy,
  and both a count and a spending budget per window.
- **Audit log** — one JSON object per line in `data/audit.log`, opened in append
  mode. Approvals are recorded as well as refusals.
- `/policy` and `/audit` endpoints, and `eth_accounts` / `eth_signTransaction`.

### Notes

- **Clef was the plan and no longer exists.** `cmd/clef` has been removed from
  go-ethereum and the binary is absent from the `alltools` image, while its
  documentation page still describes it as current (last edited December 2022).
  The policy engine is implemented here instead; signing primitives come from
  `alloy`.
- A refused request does not consume the budget, or a flood of rejected requests
  would become a way to deny service to legitimate ones.
- Denial beats permission on the recipient lists — the other ordering means
  adding an address to a blocklist silently does nothing when it is also
  allowlisted.

---

## [0.3.0] — Phase C: the gateway

Everything now points at the gateway on `8545`; geth moved to `8546` behind it.

### Added

- **Capability-aware routing** — upstreams declare archive, trace and txpool
  support; resolution is capability → health → weight.
- **Health detection with automatic recovery** — two consecutive failed probes
  remove a node, a successful one restores it, and a failed request counts as
  evidence.
- **An immutable-response cache** — only answers that cannot change, never
  anything naming `latest`, `pending`, `safe` or `finalized`.
- **Per-method rate limits**, stricter for `eth_call`, gas estimation, log
  queries and tracing.
- **Prometheus metrics** and `cupel observe`, bringing up Prometheus and Grafana
  with the datasource and dashboard provisioned.

### Fixed

- Block production returned its error, which unwound `cupel up` and took the
  gateway down with it — so stopping the node made the gateway unreachable,
  exactly backwards. Production now reports the stall, retries, and re-reads the
  head, because a restarted node has its own idea of where the chain is.

---

## [0.2.0] — Phase B: the contract library

### Added

- `Token` (ERC-20 with EIP-2612 permits), `Vault` (ERC-4626) and `Weth`, at
  fixed addresses whose last digits name the standard.
- Foundry tests that **perform** the approve race and the ERC-4626 inflation
  attack rather than describing them, plus permit replay, expiry and
  cross-chain reuse.
- `cupel contracts` and `cupel genesis`.

### Notes

- Contracts are placed in genesis as runtime bytecode, never deployed by a
  transaction, so they exist before the first block and their addresses never
  move. The cost is that constructors never run, so every contract is written to
  need no constructor state.
- The Foundry cheatcode interface is declared locally — no submodules, no
  network fetch, so a fresh clone tests with nothing installed.

---

## [0.1.0] — Phase A: control plane and block producer

### Added

- `cupel up` / `down` / `reset` / `status`, with health-gated startup and clean
  teardown.
- An **Engine API block producer** — `forkchoiceUpdated` → `getPayload` →
  `newPayload` → `forkchoiceUpdated`, four authenticated calls per block. It is
  a block producer, not a consensus client: no attestations, no fork choice, no
  real finality.
- A post-merge genesis from block zero with four prefunded development accounts.

### Fixed

- Blocks were produced but always empty, with transactions accepted into the
  pool and never included — no error anywhere. `--miner.gasprice` is the gate,
  and geth *refuses* a value of zero, logging `Sanitizing invalid miner gas
  price provided=0 updated=1,000,000`. One wei is the lowest it honours.
- `--gpo.ignoreprice` made it worse: geth's own fee oracle then suggested a tip
  beneath its own miner floor, so clients built transactions the node would
  never mine.

### Notes

- Only `VALID` counts as success from the Engine API. `SYNCING` and `ACCEPTED`
  are legitimate on a real network and mean something is wrong here.
- The JWT is regenerated per call, because the `iat` claim is only accepted
  within a narrow window either side of the node's clock.
