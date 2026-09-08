# Changelog

Every phase of the [roadmap](README.md#roadmap) ships as a tagged release, and
so does substantial work that is not a phase. The minor version tracked the
phase letter through `0.5.0` — A to E — and stops doing so at `0.6.0`, which is
the walkthroughs rather than phase F.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- **A control room.** `cupel up` and `cupel network up` now print a second
  address alongside the RPC: a page showing the head, the last twelve blocks as
  they arrive, what the gateway's upstreams are doing, and — in network mode —
  what each of the three consensus clients calls the head, the justified epoch
  and the finalised one.

  The agreement panel reports four outcomes rather than two, because a client
  that is unreachable, one on a chain that has not finalised yet, one that is
  merely behind by some epochs, and one that genuinely disagrees at the same
  epoch are different situations and only the last is alarming.

  It also produces blocks. The button runs the same four Engine API calls the
  producer runs once a second, with a copy kept of every request and response,
  and shows them in order with what each is for — keyed by method *and*
  occurrence, since `forkchoiceUpdated` appears twice and the two calls do
  different jobs.

  Everything else on the page is read straight from the clients by the browser.
  Producing a block is the exception: it needs an authenticated call to a port
  bound to localhost, so there is one endpoint, `POST /api/produce`, holding the
  head under a lock for the whole sequence — each call names the parent, so two
  producers sharing a head would have the second build on a block the first had
  already replaced.

  The page is compiled into the binary with `rust-embed`, so a release carries
  its own front end and running Cupel never needs a JavaScript toolchain.

### Fixed

- **No browser could call the gateway.** A JSON-RPC request carries
  `content-type: application/json`, which is never a simple request, so a
  browser asks permission first — and the route accepted only POST, so the
  preflight got `405 Method Not Allowed` and the real call was never sent. Every
  browser client had been unable to reach the gateway since it was written,
  while `cast` and `forge` worked perfectly, because neither of them asks
  permission. The README had been recommending `viem` against it the whole time.

  Separately, the `Access-Control-Allow-Origin` header was set by the JSON-RPC
  handler alone, so `/health` and `/metrics` returned correct bodies that
  browsers dropped unread. It is a response layer now — one place, every route,
  nothing for a third handler to forget. The test for it needed the router
  extracted first: the test module had been building its own copy of the routes,
  which is exactly how a layer goes missing from the real one while the suite
  stays green.

- **Teku sent no CORS headers either.** `--rest-api-host-allowlist` is a Host
  header allowlist and not the same idea; without `--rest-api-cors-origins` Teku
  answers `curl` perfectly and a page throws the answer away. Three clients,
  three spellings of one concept: Lighthouse has `--http-allow-origin`, Prysm
  `--http-cors-domain`, Teku this.

- **The committed bundle was never committed.** `ui/dist` is compiled into the
  binary, and a bare `dist/` in the root ignore file — plus Vite's scaffolded
  `ui/.gitignore`, either alone sufficient — kept it out of the repository while
  a comment directly above the rule explained why it was in. Nothing failed
  locally, because the working tree had the files; the first machine to find out
  would have been CI, on all four jobs at once, with `#[derive(RustEmbed)] folder
  '.../ui/dist' does not exist`. There is a `ui` job now that lints, typechecks,
  rebuilds the bundle from source and fails if it differs from what is
  committed — the same check genesis and the diagrams already get.

- **The walkthrough about slots stated the slot time from memory.** Walkthrough
  3 reads the head slot, the epoch and the proposer duties off the running
  chain, and then printed "6 seconds, so an epoch is 3 minutes 12" from a string
  in the source — wrong on both counts, in the one lesson whose entire subject
  is how a chain divides time. It now asks the chain for `SECONDS_PER_SLOT` and
  `SLOTS_PER_EPOCH` and derives every duration from them, so the lesson cannot
  disagree with the thing it is describing.

- **The devnet's slot time was never six seconds.** `SECONDS_PER_SLOT=6` was
  passed to the genesis generator from the first day of network mode and the
  generator does not template that value, so the key was simply absent from the
  config it produced and all three clients used the mainnet preset's twelve. The
  chain was correct throughout. Nothing errored. The only symptom was that
  finality arrived twice as late as the banner, the design document and CI's
  arithmetic all said it would — and CI's finality window was set from the wrong
  number, so the job failed with "no finalised epoch" on a chain that was going
  to finalise nine minutes later.

  Writing the key in by hand is not a fix: Lighthouse validates the config
  against the preset compiled into it and refuses to start with *YAML
  configuration incompatible with spec constants for mainnet*. Six-second slots
  need minimal-preset binaries. So the number is twelve everywhere now, `init`
  checks the generated config against what the code assumes rather than trusting
  it, and CI asks the running chain what it is using and fails if it disagrees —
  because the failure being guarded against was never a wrong value, it was a
  value nobody wrote and nobody missed.

- The banner printed `http://127.0.0.1:8545` whatever `--bind` was given. That
  is true for `0.0.0.0`, where localhost still reaches the socket, and a lie for
  any other address.

- **Metrics never worked on plain Linux Docker.** Prometheus scraped the clients
  through `host.docker.internal`, which gives a container a route to the host
  and nothing more: the ports are published on `127.0.0.1`, so the scrape
  arrived on the bridge address where nothing was listening. Every target was
  refused and every panel drew an empty box — indistinguishable, on a lab chain,
  from a quiet one. Docker Desktop's port proxy made it work anyway, which is
  why it went unnoticed for three phases.

  The clients are now scraped by container name over the network Cupel already
  created, which is both correct and one hop shorter; `cupel observe` attaches
  Prometheus to whichever of the two networks exists, because compose treats an
  external network it cannot find as an error and which one exists depends on
  the mode. The gateway is the one target that genuinely runs on the host, and
  `cupel up --bind 0.0.0.0` now makes it reachable. The signer is deliberately
  not covered by that flag.

- **The dashboard check waited for the wrong thing.** `up` appears as soon as
  Prometheus has *attempted* a scrape and is `0` when the target refused, so
  waiting for the series to exist was waiting for the first failure. Every panel
  was then empty for a reason that had nothing to do with the panels, and the
  output was twenty identical failures naming the wrong culprit. It now waits
  for targets that are up, prints which are up and which are down before judging
  anything, and sends a request through the gateway first — per-method counters
  do not exist until something has been through it, and block production talks
  to the node directly.

Phase F: a Chainlink oracle.

---

## [0.6.0] — The way in

Five phases built the apparatus. This is the first release aimed at somebody
using it rather than at the thing working.

### Added

- **Guided walkthroughs — `cupel lab`.** Numbered lessons that do real work
  against a running chain and narrate it: the four Engine API calls that make a
  block, printed request and response; the three states a transaction passes
  through and which question distinguishes them; slots, epochs and what has to
  happen twice before a block is final; and the same question asked of three
  clients at once. Nothing is simulated and nothing is pre-recorded — with no
  chain up, a walkthrough fails, which is the honest outcome.

  The prose lives in `crates/cupel/src/lab.rs` beside the code that produces the
  output, because a lesson kept in a separate document drifts from the thing it
  describes and there is no way to notice.

- **The producer can narrate itself.** `Config::record_exchanges` makes
  `produce_block` keep a copy of each Engine API call in `Produced::exchanges`,
  so walkthrough 1 shows the real sequence rather than a reimplementation of it
  standing next to a lesson about it. Off by default: producing a block is the
  hot path and a payload can be large, so the copies are made only when
  something intends to read them.

- **Release binaries.** A tag builds `cupel` for Linux, macOS on both
  architectures, and Windows, smoke-tests each one, and attaches them to the
  release with checksums and notes lifted from this file. Docker is needed
  either way, but asking somebody to install Rust before they can look at a
  block is a tax with nothing behind it.

- **The architecture diagrams live in the repository**, one file per theme so
  GitHub picks the right one, generated by `docs/make-diagrams.py` and checked
  in CI against it — a diagram edited by hand and not regenerated is a picture
  of a system that no longer exists.

- **A third dashboard, *Cupel — execution*.** Prometheus had been scraping geth
  since phase C and almost nothing read the result: two metrics out of the 899
  the node exposes. This is the node's own view — head with the safe and
  finalised markers trailing it, the transaction pool, Engine API latency and
  call rate, JSON-RPC, peers, state cache, disk — in both modes, told apart by a
  `node` label rather than by a separate dashboard.

  The panel that earns it is **Transactions geth refused**. A transaction paying
  under `--miner.gasprice` is accepted into the pool, returns a hash, and is then
  skipped by the payload builder for ever; nothing errors and nothing logs, so
  the only symptom is a transaction pending while empty blocks keep coming.
  `txpool_underpriced` is where that says so, and now it is on a screen.

- **Metrics in lab mode.** `compose/lab.yml` had no `--metrics` flags at all, so
  the default one-command mode exposed nothing and the `cupel-execution` scrape
  job existed only for the devnet. geth now serves metrics on `6060` there,
  scraped as a fourth target in the same job, labelled `lab`. Port `6060` rather
  than `6061` because the first devnet node holds `6061`, and the README promises
  both modes can run at once — a clash would have surfaced as a Docker bind
  error saying nothing about Cupel.

- **CI checks every dashboard panel against a live Prometheus.**
  [`check-dashboards.sh`](.github/scripts/check-dashboards.sh) pulls every
  `expr` out of every dashboard, asks a real Prometheus scraping a real chain,
  and fails on any that returns no series. Both the lab and network jobs run it,
  in their own mode, with an explicit skip-list for panels whose emptiness is a
  property of the mode rather than a fault.

  This exists because a dashboard cannot fail loudly. Rename a metric upstream
  and the panel does not error — it draws an empty box, which on a lab chain
  looks exactly like a quiet one. Both well-known community geth dashboards died
  this way and still render: the EF devops fork is InfluxDB-only and last revised
  in 2021, so `chain_execution`, `chain_validation`, `chain_write` and
  `trie_memcache_*` are all gone from geth 1.17; the other needs a JSON-RPC
  exporter last touched in 2019, before the merge. Neither was imported, and this
  check is what stops the same rot starting here.

### Changed

- **Reframed around the machinery rather than its failure modes.** The project
  is for showing how Ethereum works — the Engine API handshake that produces a
  block, three clients arriving at the same finalised chain, a network forming
  from a single bootnode — and the writing now leads with that. The Solidity
  tests are unchanged in what they run and renamed for what they demonstrate:
  `test_allowance_isReplacedNotAdjusted` rather than `test_approveRace_…`,
  `test_shares_anInflatedPriceRoundsTheNextDepositDown` rather than
  `test_inflationAttack_…`. An allowance being a standing permission and a share
  price being a ratio with a remainder are facts about the standards; they read
  better as such.

Phase F: a Chainlink oracle.

---

## [0.5.1] — Phase E, made reliable

Everything found by running the devnet rather than reading it. `v0.5.0` shipped
the phase; this is what it took to make three clients agree on one chain
repeatedly rather than once.

### Fixed

- **Three peering failures, one symptom.** Teku found nobody through discovery,
  so `up` began handing out node 1's address alongside its ENR. Given that
  address, Prysm dialled it over TCP instead of finding node 1 over QUIC and the
  connection half-opened — node 1 listed the peer as connected while Prysm
  counted none. Given the same address, Teku connected properly and received
  gossip perfectly, and never joined the gossip mesh, so every message it
  published went nowhere. Prysm now gets the bootnode record alone; Teku gets a
  QUIC address. Every time, blocks propagated flawlessly and no slot was missed —
  a block only has to reach the network once — while attestations, which need a
  mesh, did not. The chain looked healthy and never justified.

- The workspace version had stayed at `0.1.0` through four tagged releases, so
  `cupel --version` reported `0.1.0` on every one of them. Bumping it belongs in
  the same commit as the tag.
- **`network up` was not idempotent.** It re-read node 1's ENR every time and
  wrote it back, and an ENR's sequence number moves constantly — so compose saw
  changed configuration for nodes 2 and 3 and recreated them. Recreating a
  consensus client drops every peer it had. Running the command twice therefore
  took the consensus layer apart. The identity is now fetched only when it is
  not already known, which is correct because node 1 keeps its key, address and
  ports across restarts and a stale sequence number still bootstraps.
- **A gateway that failed to bind still announced its address.** `serve` bound
  the port inside a spawned task, so the error went to a `JoinHandle` nobody
  read and the banner promised an RPC on 8545 regardless. The address even
  answered — because what held it was another Cupel, serving a different chain,
  which is a considerably worse outcome than a connection refused. Both the
  gateway and the signer now take their port before anything announces it, and
  say which port and what to stop when they cannot.
- **The chain runs Electra, not Fulu.** It was generated at the tip because the
  generator defaults there, and that cost client interop. Fulu splits blob data
  into a hundred and twenty-eight column subnets; three nodes cannot cover that
  by stake, so every node had to custody everything and subscribe to roughly two
  hundred gossip topics. At that size the subscription exchange between clients
  broke: Teku held a healthy connection to Lighthouse, received gossip
  perfectly, and believed its peer was subscribed to nothing — so all seventeen
  blocks it proposed and every attestation from its twenty-one validators were
  published into the void. The chain still finalised, on the other two nodes'
  67.19%, which is how close that came to going unnoticed. On Electra, with no
  supernodes, Teku's failed publishes go from a hundred and forty-seven to zero.

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
