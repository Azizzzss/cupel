# Changelog

Every phase of the [roadmap](README.md#roadmap) ships as a tagged release, and
so does substantial work that is not a phase. The minor version tracked the
phase letter through `0.5.0` — A to E — and stops doing so at `0.6.0`, which is
the walkthroughs rather than phase F.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- **`cupel traffic`: a chain with something happening on it.** Every picture of
  an idle chain is the same flat line, so this sends what a used one carries —
  ether payments, token mints and transfers, vault deposits and redemptions,
  wrapping and unwrapping ether — from development accounts 0, 1 and 3 at once,
  in bursts of none to five every second or two. Blocks stand tall or stay
  empty, and gas varies because the work does. Account 2 never sends: it is the
  signer's key, and its audit log stays about the signer.

  Now and then it does, on purpose, the two things people are most surprised
  by: a transaction that reverts, which is still mined and still pays for its
  gas, and one sent with a nonce too far ahead, which is accepted, parks in
  `queued` and runs only once the gap in front of it is filled. Each is
  explained the first time it happens. `--clean` turns both off, and a clean run
  exits non-zero if anything reverted or was accepted and never included — the
  second being how geth reports a tip below its floor, which is not at all. At
  the end it asks for every receipt and says what became of each transaction.

  Everything is signed locally and sent raw, so it needs no Foundry, and it
  works against either chain: `--rpc http://127.0.0.1:8555` sends to a devnet
  node directly. It replaces the throwaway script that fed the 3D page.

- **The chain as a solid object.** A page that draws the block window in three
  dimensions: one box per block, running away from the camera in the order they
  were made, as tall as the gas each used, orange where a block carried
  transactions and grey where it was empty. Point at a block for its number,
  transactions and gas; click it to open the block page. In network mode a
  marker floats above the block each client calls the head, and a client whose
  head is outside the window is drawn at the end of the lane and named as ahead
  or behind rather than placed on a block the page never fetched.

  Nothing in the scene is ornament — the length is the window, the heights are
  gas, the colour is whether anything was in the block. The height scale climbs
  in round steps and the legend prints the number it has reached: scaled
  straight to the busiest block in view, every box grows the moment that block
  falls out of a window that moves every second, and a block that has not
  changed appears to have.

  three.js is larger than the rest of the interface put together, so the page is
  loaded on its own and only a reader who opens it pays to parse it. The binary
  carries it either way.

### Fixed

- **The control room fetched its own typefaces over the internet.** The page
  linked fonts.googleapis.com for IBM Plex and Fraunces. It is compiled into a
  binary and served from localhost, and this project exists to run a chain on a
  laptop with no network — so offline, which is most of the point, every heading
  fell back to Georgia and every table to the system sans, with nothing to say
  why. Six woff2 files travel with it now, latin only, and a test asserts the
  page names no font host and that each file is served as `font/woff2`.

- **The check that starts a chain from a download tripped over the chain
  already running.** It stopped the previous step's container and then tried to
  bind 8545, which that step's *process* was still holding — the thing its own
  error message says `cupel down` cannot help with. It had never run on CI
  before, because the commits that added it had not been pushed.

- **A downloaded binary could not start a chain.** The archive holds a binary,
  a README and two licences; every command except `--version` went looking for
  `compose/lab.yml` in the working directory or a parent, found none, and said
  "could not find a Cupel checkout". The point of publishing binaries is that
  trying Cupel should not need a toolchain, and what shipped needed a git
  clone instead of a Rust one.

  The binary carries what it reads now — the three compose files, the lab
  genesis, and the Prometheus and Grafana configuration `cupel observe` mounts
  — and writes them into a directory of its own the first time it runs, named
  by `CUPEL_HOME` or chosen from where the platform keeps application data. A
  checkout still wins wherever there is one, so editing a compose file works
  exactly as before. The Engine API secret is deliberately not carried: it is
  generated per chain, and one compiled into a release would be the same
  secret on every machine that downloaded it. `cupel genesis` is the one
  command that still needs a checkout, because it rebuilds the allocation from
  Foundry artifacts, and it now says so instead of failing on a missing path.

  The release's own smoke test could not have caught this. It runs the binary
  inside the checkout, where the file it wants is always a directory up, so it
  passed for four releases while every download failed. Two checks replace it:
  the release unpacks its own archive somewhere with no checkout above it, and
  CI starts a whole chain that way, which is also what proves the mounts in the
  carried compose file resolve against the directory it was written to.

- **The release never checked the version it was publishing.** The step titled
  "It runs, and it is the version on the tag" printed `cupel --version` and
  compared it with nothing. A tag placed on a commit whose `Cargo.toml` still
  held the previous number would have published a binary that disagreed with
  the release it was attached to. It compares them now and refuses.

- **Publishing did not wait for CI.** `v0.7.0` published while CI on its own
  commit was red. Building four binaries proves they compile and run; it says
  nothing about the devnet reaching finality or the committed bundle matching
  its source. The publish job now waits for the CI run on the tagged commit,
  and refuses to publish a commit CI rejected.

### Changed

- The workflows use current actions again: checkout v7, setup-node v7,
  upload-artifact v7, download-artifact v8 and action-gh-release v3. GitHub was
  forcing the old ones onto Node 24 and warning about it on every run.

---

## [0.7.0] — The control room

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

- **The control room, second pass.** A strip across the top with the vitals —
  mode, chain id, the head as it ticks, the clock in network mode, the gateway,
  the binary's version, and how old the oldest answer on the page is — and
  pages down the side: Overview, Blocks, Accounts, Gateway, Consensus in
  network mode, the walkthrough in lab mode. Routes live in the hash, because
  the bundle refers to its assets relatively so the binary can mount it
  anywhere, and a path with a second segment would resolve them under it. A
  page the running mode does not have says so; a hash nothing lives at gets a
  page too; a page that throws is the only thing that goes.

  Every block number opens the block — the header as the client sent it, the
  transactions in full — and every transaction opens what was sent, what it
  cost and what happened, with the genesis contracts' events decoded by name
  and everything else shown as the topics and data it is. Bounded on purpose:
  fifty blocks, fifty more on request, five hundred at most. The recent
  window, not an explorer; the explorer is phase G. The accounts page shows
  the four development accounts with live balances and nonces, their keys
  behind a click, and the three contracts with names, symbols and supplies
  read by hand-rolled `eth_call`. The addresses are mirrored from the Rust
  side and a Rust test reads the TypeScript to check the two agree.

  Nothing pretends to be current. Every source remembers when it last
  succeeded; a panel keeps its numbers across a failed request and, three
  intervals later, greys them and says when they were last true. Stopping geth
  no longer leaves a page that looks like a chain making blocks, and a node
  whose last answer is too old counts as not answering in the verdict — never
  as a silent vote for whichever root it last reported.

  Push instead of poll. The page subscribes to `newHeads` over geth's
  WebSocket and to each beacon node's event stream, and fetches the moment a
  block is announced — over HTTP, through the gateway in lab mode, so the
  socket is a doorbell and not a data path. Polling stretches while a socket
  is open and never stops, so a dead-but-open socket cannot freeze the page.
  Each panel says "live" or "polling"; a tab brought back from the background
  asks everything at once.

  Tests, for the first time: Vitest over the arithmetic — verdicts, slot
  maths, ABI and log decoding, block and transaction parsing, formatting,
  routes, freshness, the two wire formats — run in CI beside the lint and type
  checks. A theme switch that remembers itself, and a tab title that mirrors
  the head.

### Changed

- `GET /api/mode` carries the binary's version beside the mode, and the strip
  shows it: the page is compiled into the binary, so it is exactly as old as
  the process serving it.
- Network-mode geth publishes a WebSocket per node, on 8558–8560, for the
  control room's `newHeads` subscription; lab mode's has been on 8547 all
  along. A test reads the compose file to check the flags and the ports are
  there. The three execution containers are recreated on the next `up`; their
  chains persist.

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

- **The control room asked the wrong questions.** Which mode was running was
  guessed from which fixed port answered, which misread a devnet started beside
  a lab and could not work from another machine; the process serving the page
  knows, so there is `GET /api/mode` and the page asks it first. Under `npm run
  dev` the produce button reported failure after making a real block, because
  the page called the control room cross-origin and the control room sends no
  CORS headers; Vite proxies `/api` now. "Gateway not running" appeared when
  every upstream was down, because `/health` answers 503 with a full body and
  any non-2xx read as a refusal. The agreement panel could call clients that
  agreed a disagreement, because the finalised epoch and root came from two
  requests made at different moments; both come from one response now. The
  clock read Lighthouse alone, so stopping node1 — the lab's own demonstration
  — stopped the clock; a failed spec request produced mainnet's slot numbers
  labelled as this chain's; and a chain that never finalised said "first one
  about now away" for ever. Missing numbers are undefined, the clock says it
  was not told rather than inventing one, and finality that has stalled is
  called stalled. A page opened from another machine now says why the client
  panels are empty: the clients are published on 127.0.0.1 only.

- **Stopping the node the demo names did not stop finality.** Sixty-four
  validators across three nodes is 22 / 21 / 21, and justification needs more
  than two thirds — 43. Losing node1 leaves 42 and finality stops; losing node2
  or node3 leaves 43 and it carries on, a tenth of a percent above the line.
  Five places told the reader to stop `cupel-el2` and watch finality stop,
  and it did not. The split, the threshold and the node whose absence matters
  are computed now, the banner and walkthrough 3 read them, and a test derives
  the answer from the split and checks the named container against it. The
  uneven split is the better lesson: the threshold counts validators, not
  nodes.

- **Four checks that could not fail.** The slot-time guard read a key the
  pinned generator never writes, took its fallback of twelve, compared twelve
  with twelve and passed; it reads both spellings now, in milliseconds. The
  walkthrough guard test searched a file for a string the test itself
  contained; the guard moved to where it cannot be forgotten and the test
  checks behaviour instead. `tsc --noEmit` in `ui/` type-checked zero files,
  because the tsconfig is a solution file; CI runs `tsc -b`. The dashboard
  checker counted skipped panels as resolved and could report "all resolved"
  having asked Prometheus nothing; it fails when nothing was verified.

- **Ctrl-C during a block could be dropped**, because the shutdown future was
  rebuilt inside the loop and `select!` drops the losers — on Windows the
  process ended and left the container running with nothing driving it. It is
  built once and pinned. `--bind localhost` and `--block-time 0` panicked
  after the container was up; clap refuses both before anything starts.
  `--bind` now reaches the metrics line and network mode, `--detach` says it
  skips the control room too, `cupel status` exits non-zero when nothing
  answers, and the port-taken message suggests Ctrl-C rather than a command
  that cannot free the port.

- **The walkthroughs were a second producer on a chain that already had one.**
  Walkthroughs 1 and 2 drove the Engine API themselves beside `cupel up`'s own
  producer, two producers naming the same parent — a reorg at best, stalled
  production at worst, and four successful-looking calls either way. They ask
  the process that holds the lock, through `/api/produce`, so the walkthrough
  narrates the block that actually happened. Walkthrough 4 no longer calls a
  node that did not answer "a slot behind", or two clients at different epochs
  a disagreement; walkthrough 2 no longer blames a null receipt on a fee that
  could never be too low. The network walkthroughs ask every client whether
  the devnet is up, not only node1.

- **One blob transaction stopped lab production for good.** `newPayloadV3`
  takes the versioned hashes of the payload's blobs and the producer always
  sent none, so a payload with a blob transaction was rejected, the transaction
  stayed in the pool, and every later attempt failed the same way. The hashes
  are computed from the commitments in the `getPayloadV3` answer, as EIP-4844
  says, and an end-to-end test against a stand-in Engine API fails with the
  old empty list. A 401 from the Engine API now says what it most likely means
  instead of "error decoding response body", and the producer's default RPC is
  the node, not the gateway.

- **The gateway cached answers that change.** A pending transaction looked up
  by hash, a receipt before finality, a block by number — all cacheable only on
  a chain that cannot reorganise, which network mode can. What is cached now is
  what is immutable without assuming finality: properties of the chain, and
  blocks by hash. Filters were created on one node and polled on another, so
  every filter-based subscription failed with "filter not found" on a healthy
  devnet; node-local methods go to one node now. And a null result — "not
  mined yet" — no longer counts as a failed request.

- **The signer signed transactions other than the ones it was asked for.** The
  spending budget counted value alone, so any number of zero-value
  transactions at any fee fitted inside a budget of one wei; it counts value
  plus the whole gas limit at the maximum fee. Quantities were guessed at — a
  decimal gas limit parsed as hex, unparseable values silently defaulted, a
  missing nonce became zero — and each signed something other than what was
  requested. A quantity is 0x-prefixed hex that fits its field or the request
  is refused naming the field; nonce and gas limit are required; a tip above
  the fee cap is refused here. Audit entries record the maximum fee and the
  worst-case cost the decision was made on.

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
