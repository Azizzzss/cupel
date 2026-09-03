# Contributing

## Getting set up

```bash
git clone https://github.com/Azizzzss/cupel && cd cupel
cargo build
cargo run -p cupel -- up
```

You need Docker running and Rust 1.91 or newer. Foundry is only needed to
*change* a contract — the compiled bytecode is committed, so running the lab
needs no Solidity toolchain.

For the multi-client devnet:

```bash
cargo run -p cupel -- network up
cargo run -p cupel -- network status
```

That pulls four more images the first time. Once up it is lighter than it
sounds: nine containers taking 1.2 GB of memory between them, of which Teku is
641 MB. `config/network/` is generated and ignored;
never commit it, and never edit it by hand — `cupel network init` overwrites the
lot.

## Before opening a pull request

```bash
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test --workspace

cd contracts && forge fmt && forge test
```

CI runs all of that, plus an integration job that brings a real chain up and
uses it. If you changed a contract, also run `cupel genesis` and commit the
result — CI fails if the committed genesis does not match the compiled
contracts, because a chain running last week's bytecode is exactly the kind of
thing that goes unnoticed.

## What a change should look like

**Explain why, not what.** The code says what it does. Comments and commit
messages are for the reasoning that is not recoverable from reading it — why a
threshold is two rather than one, why a check runs before another, what breaks
if the order changes. Most of the comments in this repository exist because
something was surprising.

**Tests demonstrate behaviour.** The Solidity tests perform the attacks they are
about; the Rust tests assert on the specific reason a thing was refused, not
merely that it was. A test named `it_works` teaches nobody anything.

**Prefer a narrow rule to a clever one.** The response cache holds only what is
provably immutable. The policy engine's default is deliberately tight. Both
could be looser and faster; both would then be wrong in ways that surface as a
client being told something false.

**Own the parts that decide behaviour; integrate the rest.** geth, Lighthouse,
Prysm, Teku, Prometheus, Grafana, the genesis generator and `alloy` are
dependencies. The control plane, the block producer, the gateway, the policy
engine and the contracts are written here, because those are what make Cupel a
lab rather than a directory of compose files.

**A comment on a client flag should say what breaks without it.** Most of the
flags in `compose/network.yml` are there because something failed in a way that
did not name them — a lock file that reports a crash three restarts ago, a
gas price floor that turns into empty blocks and no error. Those comments are
the most valuable thing in the file.

## Commit messages

A subject line under about seventy characters, then a blank line, then prose
explaining the reasoning. If a change fixes something subtle, say what the
symptom looked like — the person who next hits it will be searching for the
symptom, not the fix.

Conventional prefixes (`feat:`, `fix:`, `docs:`) are used but not enforced.

## Phases and releases

Work follows the [roadmap](README.md#roadmap), one phase at a time, and every
phase ends at something demoable and gets a tag. That discipline is deliberate:
it is what stops a long project from being permanently almost-finished.

Bump `version` in the workspace `Cargo.toml` in the same commit as the tag.
Through phases A to D it was not, so `cupel --version` reported `0.1.0` on every
one of them — a small lie, and the kind that is only ever noticed by someone
trying to work out which build they are running.

If you want to work on a later phase before an earlier one lands, say so in an
issue first — the phases are in dependency order for a reason.
