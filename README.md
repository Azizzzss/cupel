# Cupel

A local Ethereum lab. One command gives you a real chain, running in seconds,
with nothing to sync and nothing to download.

> A **cupel** is the porous bone-ash vessel used in fire assay. You heat an alloy
> inside it; the base metals oxidise into the walls, and what remains is the pure
> metal. It is the tool for finding out what something is actually made of.

```bash
cupel up
```

```
  Cupel v0.1.0
  ---------------------------------------------------
  RPC          http://127.0.0.1:8545
  Chain id     31337
  Head         0 (0x9b7c14…3f21)
  Block time   1s

  Accounts (10000 ETH each)
  (0) 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
      0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  ...

  Producing blocks. Ctrl-C to stop.
```

Point `cast`, `forge`, MetaMask or `viem` at `127.0.0.1:8545` and work.

## Why this exists

Every tool nearby is built for a different job. Anvil and Hardhat Node give you
an instant chain for unit tests — one node, no network, nothing around it.
Kurtosis spins up multi-client devnets so client teams can test *clients*.
eth-docker and Sedge run production nodes for stakers.

None of them is a place to **learn**: somewhere you spin up a real chain and
immediately have an explorer, a faucet, working oracle feeds, and a shelf of
annotated ERC implementations already deployed — so you can watch an `approve()`
race actually happen instead of reading about it.

That is what Cupel is being built into. See [the design document](docs/design.md)
for the full seven-phase plan.

> **Status: phase D, verified.** A chain comes up in about eight seconds with
> the reference contracts already deployed, behind a gateway that routes,
> caches and reports on itself, alongside a signing service that holds a key
> under a policy. Still to come: the multi-client network, the oracle and the
> explorer.

## The interesting part

Since the merge, **an execution client cannot make a block on its own.** Geth
will accept transactions, gossip them and answer queries, then sit at the same
block forever, because deciding *when* a block happens is the consensus layer's
job. Geth's own documentation is blunt about it: *"geth is not able to seal
Ethash or Clique blocks. It only works in PoS mode and in concert with a
consensus client."*

Running a full beacon client to get one block a second in a lab is
disproportionate. So Cupel ships [its own block producer](crates/producer): the
smallest honest thing on the other end of the Engine API.

Each block is four authenticated calls:

| Call | Purpose |
|---|---|
| `engine_forkchoiceUpdatedV3` + attributes | build on this head, with this timestamp → returns a payload id |
| `engine_getPayloadV3` | collect the block the client built |
| `engine_newPayloadV3` | hand it back for validation |
| `engine_forkchoiceUpdatedV3` | adopt it as canonical |

**It is a block producer, not a consensus client.** There are no attestations,
no fork choice and no real finality — every block is declared final immediately,
because with a single producer there is nothing to disagree with. Anything that
depends on reorgs or genuine finality needs the multi-client network in phase E,
not this.

## The contract library

Three contracts exist at block zero on every Cupel chain, at addresses whose
last digits name the standard:

| | Address | |
|---|---|---|
| `Token` | `0x…c0de0020` | ERC-20 with EIP-2612 permits. Anyone may mint. |
| `Vault` | `0x…c0de4626` | ERC-4626 vault over `Token`, rounding on display. |
| `Weth` | `0x…c0de0009` | Wrapped ether. |

```bash
cast call 0x00000000000000000000000000000000c0de0020 'name()(string)'   # "Cupel Token"
cast send 0x00000000000000000000000000000000c0de0020 'mint(address,uint256)' $YOU 1000e18
```

**They are not deployed by a transaction.** Their runtime bytecode is written
into the genesis file, so they exist at block zero, at addresses chosen in
advance, with nothing to run first and nothing that can fail halfway. The cost
is that constructors never execute, so every contract is written to need no
constructor state — supply starts at zero and anyone may mint, and the vault's
asset address is a constant rather than an argument.

Read them for the comments as much as the code. Each one marks something that
has cost real money, and [the tests](contracts/test) perform the attacks rather
than describing them:

- **The approve race.** Changing a non-zero allowance to another non-zero value
  is two states with a gap. `test_approveRace_spenderTakesBothAllowances` has a
  spender front-run the change and take **150** where the owner never intended
  more than 100 at any moment.
- **The ERC-4626 inflation attack.** An attacker seeds an empty vault with one
  share, donates assets straight to it so that share's price rockets, and the
  next depositor's stake is divided by the inflated price and rounded down.
  `test_inflationAttack_victimLosesValueToTheAttacker` walks the whole thing:
  the victim pays 2000 and redeems 1500, and the difference is the attacker's.
  You can reproduce it live in four `cast send` calls.
- **Permit replay, expiry and cross-chain reuse**, and why the EIP-712 domain
  carries a chain id.

```bash
cd contracts && forge test
```

No submodules and no network fetch — the cheatcode interface is declared
locally, so a fresh clone tests with nothing installed.

To change a contract, edit it, `forge build`, then `cupel genesis` to rewrite
the allocation and `cupel reset` for a chain that carries it. The generated
genesis is committed, so a clone needs Solidity only to *change* a contract, not
to run one.

## The gateway

Everything points at the gateway on `8545`; the gateway points at the nodes.
That one indirection buys what a bare node cannot give you.

**Requests are routed by what they need, not just by what is up.** Each upstream
declares whether it keeps history, serves `debug_`/`trace_`, and serves
`txpool_`. Resolution is capability, then health, then weight — capability first
so that a request nothing can serve produces one clear error rather than a
confusing failure from a node that was never a candidate. Whether a call needs
history is judged from its *arguments*: `eth_getBalance` at `latest` asks for
nothing special, the same call at block `0x5` needs an archive node.

**An upstream that stops answering leaves the rotation and comes back on its
own.** Two consecutive failed probes take it out — one is usually a blip, and
removing a node on the first makes the gateway flap under load. A failed request
counts as evidence too, so a node that dies between probes is noticed
immediately rather than at the next tick.

```bash
docker stop cupel-geth
curl -s localhost:8545/health          # 503, up: false
curl -s -X POST localhost:8545 -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}'
# {"error":{"code":-32003,"message":"no healthy upstream is available"}}
docker start cupel-geth                # health recovers by itself
```

The chain keeps running through this. Block production reports that it stalled,
retries, re-reads the head — a restarted node has its own idea of where the
chain is — and resumes on its own.

**Only provably immutable answers are cached.** A block identified by hash
cannot change; a block identified by `latest` changes every second. The rule is
narrow by design, because getting it wrong does not show up as a slow gateway,
it shows up as a client being told something false.

**Expensive methods have their own rate limit.** `eth_call`, gas estimation, log
queries and tracing cost a node far more than a balance lookup, and a loop
issuing them is the usual way a local node becomes unresponsive.

## Policy signing

Clients sign for themselves — `cast` and MetaMask hold their own keys and never
ask anything else. The signer on `:8550` is for the other case: an *application*
that needs to send transactions, and therefore needs a key it cannot be trusted
with. The faucet is the obvious example, and it is what phase G will use.

A policy turns "this process was compromised" into "this process was
compromised and could still only send one ether to two known addresses before
the rate limit stopped it".

```bash
curl -s localhost:8550/policy    # what the key is held under
curl -s localhost:8550/audit     # what it has decided lately
```

```
value 100000000000000000000 exceeds the ceiling of 1000000000000000000 wei
this key may not deploy contracts
no key held for 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
rate limit reached: 10 signatures per 60s
```

The rules are a per-transaction value ceiling, a gas ceiling, an optional
recipient allowlist, a blocklist that beats it, whether the key may deploy at
all, and both a **count and a spending budget** per window — a rate limit alone
still permits ten transactions of the maximum size, and the budget is what
bounds the total loss.

**Every decision is recorded, approvals included.** A log holding only refusals
answers "what was blocked", and the question after an incident is always "what
was signed". Entries are one JSON object per line in `data/audit.log`, opened in
append mode so a restart cannot truncate the history.

A refused request does not consume the budget, or a flood of rejected requests
would become a way to deny service to legitimate ones.

> **Why not Clef?** It was the obvious thing to integrate, and it no longer
> exists — `cmd/clef` has been removed from go-ethereum and the binary is absent
> from the `alltools` image, though [the documentation
> page](https://geth.ethereum.org/docs/tools/clef/introduction) still describes
> it as current (last edited December 2022). Rather than pin an ancient geth to
> run a deleted tool, the policy engine is implemented here and the signing
> primitives come from `alloy`: borrow the cryptography, own the rules.

## Monitoring

```bash
cupel observe        # Prometheus and Grafana, provisioned, no login
cupel observe --down
```

Grafana on `:3000` comes up with the dashboard already wired: upstreams
answering, request rate split by ok/failed/rejected, cache hit ratio, health
over time, and traffic by method. The metrics come from the gateway rather than
from geth, deliberately — what matters in a lab is what clients experienced, not
what the node thinks of itself.

```bash
curl -s localhost:8545/metrics
```

## Commands

| | |
|---|---|
| `cupel up` | start the chain and produce blocks until Ctrl-C |
| `cupel up --block-time 5` | slower blocks |
| `cupel up --keep` | leave the container running after exit |
| `cupel down` | stop the chain, keep its data |
| `cupel reset` | stop the chain and delete its data |
| `cupel status` | is it up, and where has it got to |
| `cupel contracts` | list the reference contracts and their addresses |
| `cupel genesis` | rewrite the genesis allocation from the compiled contracts |
| `cupel observe` | start Prometheus and Grafana against the gateway |

The signer runs alongside the chain on `:8550`; the gateway on `:8545`.

## Requirements

- Docker, with the daemon running
- A stable Rust toolchain, 1.91 or newer

```bash
cargo build --release
./target/release/cupel up
```

## Design notes

**Lab mode has no history, and that is the point.** A node joining mainnet must
download and verify ~1.2 TB before it can answer anything. Cupel creates a chain
at block zero instead — nothing to sync, nothing to store, usable in seconds.
The trade is that the chain is empty: no Uniswap, no USDC, no mainnet state.

**The Engine API is authenticated, and bound to localhost.** Anything that can
reach port 8551 with the shared secret can dictate what the chain contains. The
secret is generated on first run and never committed.

**The archive node is deliberate.** `--gcmode archive` keeps historical state, so
`eth_getBalance` at an old block works. On a chain this small it costs nothing,
and being able to query the past is worth a great deal in a teaching tool.

**Only `VALID` counts as success.** `SYNCING` and `ACCEPTED` are legitimate
answers from a client that is catching up on a real network. Here they mean
something is wrong, and treating them as success would silently stall the chain
while appearing to work.

**`--miner.gasprice` is the flag that decides whether anything gets mined**, and
it fails silently. Geth's payload builder drops any transaction offering a
smaller tip than this, so the transaction is accepted into the pool, reported as
pending, and then never included — blocks keep coming, all of them empty, and
nothing anywhere reports an error. Worse, geth *refuses* a value of zero: it
logs `Sanitizing invalid miner gas price provided=0 updated=1,000,000` and
raises the floor to 0.001 gwei. One wei is the lowest it will honour.

The matching trap is `--gpo.ignoreprice`. Lower it and geth's fee oracle starts
suggesting a tip beneath its own miner floor, so clients faithfully build
transactions the node will never mine. Cupel leaves it alone.

## Licence

Dual-licensed under [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at your
option.
