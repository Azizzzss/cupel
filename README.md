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

> **Status: phase A, verified.** `cupel up` brings a chain online in about eight
> seconds, produces blocks on a timer, and `cast send` lands a transfer that
> moves real balances. Historical state queries work. Everything else in the
> plan — the contract library, the gateway, policy signing, the multi-client
> network, the oracle and the explorer — is not built yet.

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

## Commands

| | |
|---|---|
| `cupel up` | start the chain and produce blocks until Ctrl-C |
| `cupel up --block-time 5` | slower blocks |
| `cupel up --keep` | leave the container running after exit |
| `cupel down` | stop the chain, keep its data |
| `cupel reset` | stop the chain and delete its data |
| `cupel status` | is it up, and where has it got to |

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
