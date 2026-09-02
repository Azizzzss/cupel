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

**Own the parts that decide behaviour; integrate the rest.** geth, Prometheus,
Grafana and `alloy` are dependencies. The control plane, the block producer, the
gateway, the policy engine and the contracts are written here, because those are
what make Cupel a lab rather than a directory of compose files.

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

If you want to work on a later phase before an earlier one lands, say so in an
issue first — the phases are in dependency order for a reason.
