//! Real transactions, in bursts, so blocks have something in them.
//!
//! A chain nobody uses makes empty blocks, and every picture of an empty chain
//! looks the same: flat gas, no events, nothing waiting. This sends what a busy
//! chain carries — payments, mints, transfers, vault deposits and redemptions,
//! wrapping and unwrapping ether — from three accounts at once, in bursts of
//! uneven size, so some blocks stand tall and some stay empty.
//!
//! It also does, now and then and on purpose, the two things people are most
//! surprised by. A transaction that reverts still lands in a block and still
//! pays for its gas. And a transaction sent with a nonce too far ahead is
//! accepted, then waits in the pool as `queued` until the gap in front of it is
//! filled. `--clean` turns both off.
//!
//! Everything is signed here with the published development keys and sent as
//! raw transactions, so nothing needs Foundry, the signer, or an unlocked
//! account. Account 2 never sends: it is the signer's key, and keeping it out
//! keeps its audit log about the signer.

use std::collections::HashMap;
use std::fmt;
use std::time::{Duration, Instant};

use alloy::consensus::{SignableTransaction, TxEip1559, TxEnvelope};
use alloy::eips::eip2718::Encodable2718;
use alloy::primitives::{Address, Bytes, TxKind, U256, keccak256};
use alloy::signers::SignerSync;
use alloy::signers::local::PrivateKeySigner;
use anyhow::{Context, Result, bail};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde_json::{Value, json};

use crate::contracts;

/// Who sends. Account 2 is the signer's own key and stays out of it.
const SENDERS: [usize; 3] = [0, 1, 3];

/// One ether, and one whole token: both have eighteen decimals.
const UNIT: u64 = 1_000_000_000_000_000_000;

/// What each sender mints for itself before the bursts begin, so transfers
/// and deposits have something to move.
const STARTING_TOKENS: u64 = 1_000_000;

/// The tip on every transaction. The base fee is read from the chain each
/// burst; the tip is what the sender adds so a producer has a reason to take it.
const TIP: u128 = 1_000_000_000;

/// How to run.
#[derive(Debug, Clone)]
pub(crate) struct Options {
    /// The JSON-RPC to send to.
    pub(crate) rpc: String,
    /// Stop after this long. Until Ctrl-C when absent.
    pub(crate) duration: Option<Duration>,
    /// The most transactions in one burst.
    pub(crate) burst: u32,
    /// No deliberate reverts and no nonce gaps.
    pub(crate) clean: bool,
}

// ---------------------------------------------------------------- calldata

/// The first four bytes of the hash of a function's signature.
///
/// Computed rather than written out, because a wrong constant fails silently —
/// the call lands on the fallback, or on nothing, and reverts with no reason.
/// The tests pin these against the selectors every ABI tool agrees on.
fn selector(signature: &str) -> [u8; 4] {
    let hash = keccak256(signature.as_bytes());
    [hash[0], hash[1], hash[2], hash[3]]
}

/// One 32-byte ABI word.
fn address_word(address: Address) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address.as_slice());
    word
}

fn uint_word(value: U256) -> [u8; 32] {
    value.to_be_bytes::<32>()
}

/// Calldata for a function whose arguments are all static words — which is
/// every call this module makes, and the reason it needs no ABI library.
fn calldata(signature: &str, words: &[[u8; 32]]) -> Bytes {
    let mut data = Vec::with_capacity(4 + 32 * words.len());
    data.extend_from_slice(&selector(signature));
    for word in words {
        data.extend_from_slice(word);
    }
    data.into()
}

fn tokens(whole: u64) -> U256 {
    U256::from(whole) * U256::from(UNIT)
}

/// Hundredths of an ether, so amounts vary without anyone reading wei.
fn centi_ether(hundredths: u64) -> U256 {
    U256::from(hundredths) * U256::from(UNIT / 100)
}

fn contract(name: &str) -> Address {
    contracts::CONTRACTS
        .iter()
        .find(|c| c.name == name)
        .and_then(|c| c.address.parse().ok())
        .unwrap_or_else(|| panic!("{name} is in the contract library with a valid address"))
}

// ------------------------------------------------------------------- calls

/// What kind of transaction, for the tally at the end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum Kind {
    Setup,
    Pay,
    Mint,
    Transfer,
    Deposit,
    Redeem,
    Wrap,
    Unwrap,
    Revert,
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Kind::Setup => "setup",
            Kind::Pay => "ether payment",
            Kind::Mint => "Token.mint",
            Kind::Transfer => "Token.transfer",
            Kind::Deposit => "Vault.deposit",
            Kind::Redeem => "Vault.redeem",
            Kind::Wrap => "Weth.deposit",
            Kind::Unwrap => "Weth.withdraw",
            Kind::Revert => "a deliberate revert",
        })
    }
}

/// One transaction, before it has a nonce or a fee.
#[derive(Debug, Clone)]
struct Call {
    kind: Kind,
    /// What is printed: the function and whatever makes this one distinct.
    label: String,
    to: Address,
    value: U256,
    input: Bytes,
    /// Set by hand rather than estimated. Estimating a transaction built to
    /// revert fails, which is the node being helpful; the whole point here is
    /// to send it anyway and watch it land.
    gas: u64,
}

/// What a sender has done that later calls depend on.
///
/// Counted as sent, not as confirmed. A redemption sent after a deposit shares
/// its sender's nonce sequence, so it cannot run before the deposit does; if
/// the deposit reverted, the redemption reverts too, which is what would
/// happen to anyone.
#[derive(Debug, Default, Clone, Copy)]
struct Holdings {
    deposits: u32,
    redeems: u32,
    wraps: u32,
    unwraps: u32,
}

/// Pick the next call for `from`, given what it has already sent.
fn pick(rng: &mut impl Rng, from: usize, held: &Holdings, clean: bool) -> Call {
    let token = contract("Token");
    let vault = contract("Vault");
    let weth = contract("Weth");
    let me = account(from);

    // Weights, not a script: the mix should look like a chain with users on
    // it, where transfers dominate and nobody unwraps what they never wrapped.
    let can_redeem = held.deposits > held.redeems;
    let can_unwrap = held.wraps > held.unwraps;
    let table: [(Kind, u32); 8] = [
        (Kind::Pay, 14),
        (Kind::Mint, 12),
        (Kind::Transfer, 26),
        (Kind::Deposit, 14),
        (Kind::Redeem, if can_redeem { 8 } else { 0 }),
        (Kind::Wrap, 12),
        (Kind::Unwrap, if can_unwrap { 6 } else { 0 }),
        (Kind::Revert, if clean { 0 } else { 4 }),
    ];
    let total: u32 = table.iter().map(|(_, w)| w).sum();
    let mut roll = rng.random_range(0..total);
    let kind = table
        .iter()
        .find(|(_, weight)| {
            if roll < *weight {
                true
            } else {
                roll -= weight;
                false
            }
        })
        .map(|(kind, _)| *kind)
        .unwrap_or(Kind::Transfer);

    match kind {
        Kind::Pay => {
            let to = someone_else(rng, from);
            let amount = rng.random_range(1..=100);
            Call {
                kind,
                label: format!("{kind} → #{to}, {} ETH", hundredths(amount)),
                to: account(to),
                value: centi_ether(amount),
                input: Bytes::new(),
                gas: 21_000,
            }
        }
        Kind::Mint => {
            let amount = rng.random_range(1..=1_000);
            Call {
                kind,
                label: format!("{kind}, {amount} CUP"),
                to: token,
                value: U256::ZERO,
                input: calldata(
                    "mint(address,uint256)",
                    &[address_word(me), uint_word(tokens(amount))],
                ),
                gas: 100_000,
            }
        }
        Kind::Transfer => {
            let to = someone_else(rng, from);
            let amount = rng.random_range(1..=50);
            Call {
                kind,
                label: format!("{kind} → #{to}, {amount} CUP"),
                to: token,
                value: U256::ZERO,
                input: calldata(
                    "transfer(address,uint256)",
                    &[address_word(account(to)), uint_word(tokens(amount))],
                ),
                gas: 100_000,
            }
        }
        Kind::Deposit => {
            let amount = rng.random_range(1..=100);
            Call {
                kind,
                label: format!("{kind}, {amount} CUP"),
                to: vault,
                value: U256::ZERO,
                input: calldata(
                    "deposit(uint256,address)",
                    &[uint_word(tokens(amount)), address_word(me)],
                ),
                gas: 200_000,
            }
        }
        Kind::Redeem => Call {
            kind,
            // One share at a time, and every deposit buys at least one, so a
            // sender never redeems more than it has been sent.
            label: format!("{kind}, 1 share"),
            to: vault,
            value: U256::ZERO,
            input: calldata(
                "redeem(uint256,address,address)",
                &[uint_word(tokens(1)), address_word(me), address_word(me)],
            ),
            gas: 200_000,
        },
        Kind::Wrap => {
            let amount = rng.random_range(1..=50);
            Call {
                kind,
                label: format!("{kind}, {} ETH", hundredths(amount)),
                to: weth,
                value: centi_ether(amount),
                input: calldata("deposit()", &[]),
                gas: 100_000,
            }
        }
        Kind::Unwrap => Call {
            kind,
            // The smallest wrap, so every unwrap is covered by one before it.
            label: format!("{kind}, 0.01 ETH"),
            to: weth,
            value: U256::ZERO,
            input: calldata("withdraw(uint256)", &[uint_word(centi_ether(1))]),
            gas: 100_000,
        },
        Kind::Revert => {
            if rng.random_bool(0.5) {
                Call {
                    kind,
                    label: "Token.burn of more than it holds — reverts on purpose".into(),
                    to: token,
                    value: U256::ZERO,
                    input: calldata("burn(uint256)", &[uint_word(U256::MAX)]),
                    gas: 60_000,
                }
            } else {
                Call {
                    kind,
                    label: "Vault.deposit of nothing — refused, reverts on purpose".into(),
                    to: vault,
                    value: U256::ZERO,
                    input: calldata(
                        "deposit(uint256,address)",
                        &[uint_word(U256::ZERO), address_word(me)],
                    ),
                    gas: 60_000,
                }
            }
        }
        Kind::Setup => unreachable!("setup is never picked at random"),
    }
}

/// The two calls each sender makes first: tokens to move, and the vault's
/// permission to take them. A deposit is `transferFrom` underneath, so without
/// the approval every deposit would revert.
fn setup_calls(from: usize) -> [Call; 2] {
    let token = contract("Token");
    let vault = contract("Vault");
    [
        Call {
            kind: Kind::Setup,
            label: format!("Token.mint, {STARTING_TOKENS} CUP to start with"),
            to: token,
            value: U256::ZERO,
            input: calldata(
                "mint(address,uint256)",
                &[
                    address_word(account(from)),
                    uint_word(tokens(STARTING_TOKENS)),
                ],
            ),
            gas: 100_000,
        },
        Call {
            kind: Kind::Setup,
            label: "Token.approve, the vault may take any amount".into(),
            to: token,
            value: U256::ZERO,
            input: calldata(
                "approve(address,uint256)",
                &[address_word(vault), uint_word(U256::MAX)],
            ),
            gas: 100_000,
        },
    ]
}

fn hundredths(amount: u64) -> String {
    format!("{}.{:02}", amount / 100, amount % 100)
}

fn account(index: usize) -> Address {
    crate::DEV_ACCOUNTS[index]
        .0
        .parse()
        .expect("the development addresses are valid")
}

/// Another development account, any of the four — the signer's included, since
/// receiving is harmless.
fn someone_else(rng: &mut impl Rng, from: usize) -> usize {
    let others: Vec<usize> = (0..crate::DEV_ACCOUNTS.len())
        .filter(|i| *i != from)
        .collect();
    others[rng.random_range(0..others.len())]
}

// ----------------------------------------------------------------- senders

/// A nonce left empty on purpose, and when to fill it.
#[derive(Debug, Clone, Copy)]
struct Gap {
    nonce: u64,
    bursts_left: u32,
}

#[derive(Debug)]
struct Sender {
    index: usize,
    key: PrivateKeySigner,
    /// The next nonce to use. Tracked here rather than asked for each time:
    /// through the gateway on the devnet, consecutive questions can land on
    /// different nodes whose pools have not heard of each other's transactions
    /// yet, and a nonce read from the wrong one is a replacement, not a send.
    nonce: u64,
    gap: Option<Gap>,
    held: Holdings,
}

// --------------------------------------------------------------------- rpc

/// A JSON-RPC endpoint with a timeout, so a node that stops answering is
/// reported rather than waited on for ever.
#[derive(Debug)]
struct Rpc {
    url: String,
    client: reqwest::Client,
}

impl Rpc {
    fn new(url: &str) -> Result<Self> {
        Ok(Self {
            url: url.to_string(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()?,
        })
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let response: Value = self
            .client
            .post(&self.url)
            .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
            .send()
            .await
            .with_context(|| format!("{} did not answer", self.url))?
            .json()
            .await
            .with_context(|| {
                format!(
                    "{} answered {method} with something other than JSON",
                    self.url
                )
            })?;
        if let Some(error) = response.get("error").filter(|e| !e.is_null()) {
            let message = error["message"].as_str().unwrap_or_default();
            bail!("{method}: {message}");
        }
        Ok(response["result"].clone())
    }

    async fn quantity(&self, method: &str, params: Value) -> Result<u64> {
        let value = self.call(method, params).await?;
        quantity(&value).with_context(|| format!("{method} returned {value}, not a quantity"))
    }
}

fn quantity(value: &Value) -> Option<u64> {
    u64::from_str_radix(value.as_str()?.trim_start_matches("0x"), 16).ok()
}

/// Whether a refusal means the nonce held here has drifted from the node's.
///
/// These are the messages geth uses; the fix for each is the same, which is to
/// ask the node again rather than to keep sending into a sequence it has moved
/// past.
fn nonce_trouble(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "nonce too low",
        "already known",
        "replacement transaction underpriced",
        "nonce too high",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

/// Sign a call and encode it the way `eth_sendRawTransaction` wants it.
fn sign(
    key: &PrivateKeySigner,
    chain_id: u64,
    nonce: u64,
    base_fee: u128,
    call: &Call,
) -> Result<String> {
    let transaction = TxEip1559 {
        chain_id,
        nonce,
        gas_limit: call.gas,
        // Twice the base fee leaves room for it to rise before inclusion;
        // whatever is not needed is never charged.
        max_fee_per_gas: base_fee * 2 + TIP,
        max_priority_fee_per_gas: TIP,
        to: TxKind::Call(call.to),
        value: call.value,
        input: call.input.clone(),
        access_list: Default::default(),
    };
    let signature = key.sign_hash_sync(&transaction.signature_hash())?;
    let mut raw = Vec::new();
    TxEnvelope::Eip1559(transaction.into_signed(signature)).encode_2718(&mut raw);
    Ok(format!("0x{}", hex::encode(raw)))
}

// -------------------------------------------------------------------- run

/// What was sent, kept so the end can say what became of it.
#[derive(Debug)]
struct Sent {
    hash: String,
    kind: Kind,
}

/// Send until Ctrl-C or the deadline, then say what happened to it all.
pub(crate) async fn run(options: Options) -> Result<()> {
    let rpc = Rpc::new(&options.rpc)?;
    let chain_id = rpc
        .quantity("eth_chainId", json!([]))
        .await
        .with_context(|| {
            format!(
                "nothing is answering at {} — start a chain with `cupel up` or \
             `cupel network up`, then run this in another terminal",
                options.rpc
            )
        })?;

    let mut senders = Vec::new();
    for index in SENDERS {
        let key: PrivateKeySigner = crate::DEV_ACCOUNTS[index]
            .1
            .parse()
            .context("a development key did not parse")?;
        let nonce = rpc
            .quantity(
                "eth_getTransactionCount",
                json!([crate::DEV_ACCOUNTS[index].0, "pending"]),
            )
            .await?;
        senders.push(Sender {
            index,
            key,
            nonce,
            gap: None,
            held: Holdings::default(),
        });
    }

    println!();
    println!("  Traffic → {}  (chain {chain_id})", options.rpc);
    println!("  ---------------------------------------------------");
    println!(
        "  Accounts #{}, #{} and #{} send; #2 is the signer's and stays out.",
        SENDERS[0], SENDERS[1], SENDERS[2]
    );
    if options.clean {
        println!("  --clean: every transaction is meant to succeed.");
    } else {
        println!("  Now and then a revert and a nonce gap, on purpose. --clean stops them.");
    }
    match options.duration {
        Some(duration) => println!("  Stops after {}s, or at Ctrl-C.", duration.as_secs()),
        None => println!("  Ctrl-C to stop."),
    }
    println!();

    let mut rng = StdRng::from_os_rng();
    let mut sent: Vec<Sent> = Vec::new();
    let mut refused = 0u32;
    let mut unreachable = false;
    let mut explained_revert = false;
    let started = Instant::now();

    let shutdown = tokio::signal::ctrl_c();
    tokio::pin!(shutdown);

    // The setup goes first, as its own burst.
    let base_fee = latest_base_fee(&rpc).await.unwrap_or(1_000_000_000);
    for sender in &mut senders {
        for call in setup_calls(sender.index) {
            let nonce = sender.nonce;
            if send(&rpc, chain_id, base_fee, sender, nonce, &call, &mut sent).await? {
                sender.nonce += 1;
            } else {
                refused += 1;
            }
        }
    }

    loop {
        if options.duration.is_some_and(|d| started.elapsed() >= d) {
            break;
        }
        let pause = Duration::from_millis(rng.random_range(700..=2_500));
        tokio::select! {
            _ = tokio::time::sleep(pause) => {}
            _ = &mut shutdown => break,
        }

        let base_fee = match latest_base_fee(&rpc).await {
            Ok(fee) => {
                if unreachable {
                    println!("  … the chain is answering again");
                    unreachable = false;
                    // Whatever was in flight when it went away may or may not
                    // have survived, so start again from what the node knows.
                    resync(&rpc, &mut senders).await;
                }
                fee
            }
            Err(error) => {
                if !unreachable {
                    eprintln!("  … the chain stopped answering ({error:#}); waiting for it");
                    unreachable = true;
                }
                continue;
            }
        };

        // Gaps first: one that is due is filled before anything else goes,
        // and a sender with one open sends nothing else until it is.
        for sender in &mut senders {
            let Some(mut gap) = sender.gap else { continue };
            gap.bursts_left = gap.bursts_left.saturating_sub(1);
            if gap.bursts_left > 0 {
                sender.gap = Some(gap);
                continue;
            }
            let call = pick(&mut rng, sender.index, &sender.held, true);
            print_line(
                sender.index,
                gap.nonce,
                &format!("{}  — fills the gap", call.label),
            );
            if send(
                &rpc, chain_id, base_fee, sender, gap.nonce, &call, &mut sent,
            )
            .await?
            {
                note(&mut sender.held, call.kind);
                println!(
                    "            nonce {} is here, so {} can run: both leave `queued` together",
                    gap.nonce,
                    gap.nonce + 1
                );
            } else {
                refused += 1;
                resync_one(&rpc, sender).await;
            }
            sender.gap = None;
        }

        let burst = rng.random_range(0..=options.burst);
        for _ in 0..burst {
            let free: Vec<usize> = (0..senders.len())
                .filter(|i| senders[*i].gap.is_none())
                .collect();
            if free.is_empty() {
                break;
            }
            let sender = &mut senders[free[rng.random_range(0..free.len())]];

            // A gap, rarely: skip a nonce, send the one after it, and leave
            // the hole for a couple of bursts.
            let opening_gap = !options.clean && rng.random_ratio(1, 45) && sender.gap.is_none();
            let nonce = if opening_gap {
                sender.nonce + 1
            } else {
                sender.nonce
            };

            let call = pick(&mut rng, sender.index, &sender.held, options.clean);
            let label = if opening_gap {
                format!("{}  — skips nonce {}", call.label, sender.nonce)
            } else {
                call.label.clone()
            };
            print_line(sender.index, nonce, &label);
            if call.kind == Kind::Revert && !explained_revert {
                println!(
                    "            it will still be mined, and still pay for the gas it \
                     burns — a revert undoes effects, not inclusion"
                );
                explained_revert = true;
            }
            if send(&rpc, chain_id, base_fee, sender, nonce, &call, &mut sent).await? {
                note(&mut sender.held, call.kind);
                if opening_gap {
                    println!(
                        "            accepted, and parked in `queued`: nothing from #{} can \
                         run until nonce {} arrives",
                        sender.index, sender.nonce
                    );
                    sender.gap = Some(Gap {
                        nonce: sender.nonce,
                        bursts_left: rng.random_range(2..=4),
                    });
                    sender.nonce += 2;
                } else {
                    sender.nonce += 1;
                }
            } else {
                refused += 1;
                resync_one(&rpc, sender).await;
            }
        }
    }

    // A gap still open at the end would strand everything behind it, so fill
    // it on the way out rather than leave the pool holding transactions that
    // can never run.
    if let Ok(base_fee) = latest_base_fee(&rpc).await {
        for sender in &mut senders {
            if let Some(gap) = sender.gap.take() {
                let call = pick(&mut rng, sender.index, &sender.held, true);
                print_line(
                    sender.index,
                    gap.nonce,
                    &format!("{}  — fills the gap before stopping", call.label),
                );
                if !send(
                    &rpc, chain_id, base_fee, sender, gap.nonce, &call, &mut sent,
                )
                .await?
                {
                    refused += 1;
                }
            }
        }
    }

    let tally = summarise(&rpc, &sent, refused).await;
    verdict(options.clean, tally, refused)
}

/// Send one call. `Ok(false)` when the node refused it — which is reported
/// and survived — and `Err` only for something that cannot be carried on from.
async fn send(
    rpc: &Rpc,
    chain_id: u64,
    base_fee: u128,
    sender: &Sender,
    nonce: u64,
    call: &Call,
    sent: &mut Vec<Sent>,
) -> Result<bool> {
    let raw = sign(&sender.key, chain_id, nonce, base_fee, call)?;
    match rpc.call("eth_sendRawTransaction", json!([raw])).await {
        Ok(hash) => {
            sent.push(Sent {
                hash: hash.as_str().unwrap_or_default().to_string(),
                kind: call.kind,
            });
            Ok(true)
        }
        Err(error) => {
            let message = format!("{error:#}");
            eprintln!("            refused: {message}");
            if nonce_trouble(&message) {
                eprintln!(
                    "            (asking the node for #{}'s nonce again)",
                    sender.index
                );
            }
            Ok(false)
        }
    }
}

fn note(held: &mut Holdings, kind: Kind) {
    match kind {
        Kind::Deposit => held.deposits += 1,
        Kind::Redeem => held.redeems += 1,
        Kind::Wrap => held.wraps += 1,
        Kind::Unwrap => held.unwraps += 1,
        _ => {}
    }
}

async fn resync(rpc: &Rpc, senders: &mut [Sender]) {
    for sender in senders {
        sender.gap = None;
        resync_one(rpc, sender).await;
    }
}

/// Ask the node where a sender's nonce is. Only ever done for a sender with no
/// gap open: with one, the node's answer is the gap itself, and filling it by
/// accident would end the demonstration early.
async fn resync_one(rpc: &Rpc, sender: &mut Sender) {
    if sender.gap.is_some() {
        return;
    }
    if let Ok(nonce) = rpc
        .quantity(
            "eth_getTransactionCount",
            json!([crate::DEV_ACCOUNTS[sender.index].0, "pending"]),
        )
        .await
    {
        sender.nonce = nonce;
    }
}

async fn latest_base_fee(rpc: &Rpc) -> Result<u128> {
    let block = rpc
        .call("eth_getBlockByNumber", json!(["latest", false]))
        .await?;
    // Seven wei is the protocol's floor; a chain this quiet sits on it.
    Ok(u128::from(
        quantity(&block["baseFeePerGas"]).unwrap_or(7).max(7),
    ))
}

fn print_line(from: usize, nonce: u64, label: &str) {
    println!("  #{from}  n{nonce:<5} {label}");
}

/// What became of everything that was sent.
///
/// The accepted-is-not-included lesson, measured: a hash came back for every
/// one of these, and the receipts say which actually ran.
async fn summarise(rpc: &Rpc, sent: &[Sent], refused: u32) -> Tally {
    // Wait for the last bursts to land, but not for ever. A lab block is a
    // second away and a devnet one twelve, with the odd missed slot; half a
    // minute covers both, and whatever is still out after that is reported as
    // what it is — accepted and not included.
    let mut outcome: Vec<Option<bool>> = vec![None; sent.len()];
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut announced = false;
    loop {
        for (tx, slot) in sent.iter().zip(outcome.iter_mut()) {
            if slot.is_some() {
                continue;
            }
            if let Ok(receipt) = rpc
                .call("eth_getTransactionReceipt", json!([tx.hash]))
                .await
                && !receipt.is_null()
            {
                *slot = Some(receipt["status"].as_str() == Some("0x1"));
            }
        }
        let out = outcome.iter().filter(|o| o.is_none()).count();
        if out == 0 || Instant::now() >= deadline {
            break;
        }
        if !announced {
            println!("\n  waiting for the last {out} to land in a block…");
            announced = true;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    let mut by_kind: HashMap<Kind, (u32, u32, u32)> = HashMap::new();
    let mut tally = Tally::default();
    for (tx, result) in sent.iter().zip(&outcome) {
        let entry = by_kind.entry(tx.kind).or_default();
        match result {
            Some(true) => {
                tally.included += 1;
                entry.0 += 1;
            }
            Some(false) => {
                tally.reverted += 1;
                entry.1 += 1;
            }
            None => {
                tally.waiting += 1;
                entry.2 += 1;
            }
        }
    }
    let Tally {
        included,
        reverted,
        waiting,
    } = tally;

    println!();
    println!("  ---------------------------------------------------");
    println!(
        "  {} sent: {included} succeeded, {reverted} reverted, {waiting} not in a block yet",
        sent.len()
    );
    if refused > 0 {
        println!("  {refused} refused by the node and never accepted");
    }
    println!();
    let mut kinds: Vec<_> = by_kind.into_iter().collect();
    kinds.sort();
    for (kind, (ok, failed, pending)) in kinds {
        let mut parts = Vec::new();
        if ok > 0 {
            parts.push(format!("{ok} ok"));
        }
        if failed > 0 {
            parts.push(format!("{failed} reverted"));
        }
        if pending > 0 {
            parts.push(format!("{pending} waiting"));
        }
        println!("  {:<22} {}", kind.to_string(), parts.join(", "));
    }
    println!();
    if waiting > 0 {
        println!(
            "  Every one of these got a hash back from the node. The ones still \
             waiting are accepted and not included — the next block may take them."
        );
        println!();
    }
    tally
}

/// What became of the transactions that were accepted.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Tally {
    included: u32,
    reverted: u32,
    waiting: u32,
}

/// Whether a run did what it was asked to.
///
/// A clean run makes a promise — every transaction is meant to succeed — and a
/// broken one should say so with its exit status rather than in a tally
/// nobody reads. A revert there means a wrong selector, a missing approval or
/// a gas limit too low; a transaction never included means the fee is below
/// what the node will mine, which geth reports to nobody. The ordinary run
/// reverts on purpose and only fails when nothing landed at all.
fn verdict(clean: bool, tally: Tally, refused: u32) -> Result<()> {
    if tally.included == 0 {
        bail!(
            "nothing that was sent succeeded — the chain accepted transactions and ran none of them"
        );
    }
    if clean {
        if tally.reverted > 0 {
            bail!(
                "{} transactions reverted in a --clean run, where every one is meant to succeed",
                tally.reverted
            );
        }
        if tally.waiting > 0 {
            bail!(
                "{} transactions were accepted and never included — is the tip below the node's \
                 minimum? geth drops those into the pool without a word",
                tally.waiting
            );
        }
        if refused > 0 {
            bail!("the node refused {refused} transactions in a --clean run");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors_match_the_ones_every_tool_agrees_on() {
        // External anchors, not self-consistency: these are the values in
        // every ABI database, and a typo in a signature string would not match.
        let cases = [
            ("transfer(address,uint256)", "a9059cbb"),
            ("approve(address,uint256)", "095ea7b3"),
            ("mint(address,uint256)", "40c10f19"),
            ("burn(uint256)", "42966c68"),
            ("deposit()", "d0e30db0"),
            ("withdraw(uint256)", "2e1a7d4d"),
            ("deposit(uint256,address)", "6e553f65"),
            ("redeem(uint256,address,address)", "ba087652"),
        ];
        for (signature, expected) in cases {
            assert_eq!(hex::encode(selector(signature)), expected, "{signature}");
        }
    }

    #[test]
    fn calldata_is_a_selector_then_padded_words() {
        let to: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
            .parse()
            .unwrap();
        let data = calldata(
            "transfer(address,uint256)",
            &[address_word(to), uint_word(U256::from(1u64))],
        );
        assert_eq!(
            hex::encode(&data),
            concat!(
                "a9059cbb",
                "00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8",
                "0000000000000000000000000000000000000000000000000000000000000001",
            )
        );
        assert_eq!(calldata("deposit()", &[]).len(), 4);
    }

    #[test]
    fn the_signer_account_never_sends() {
        assert!(!SENDERS.contains(&crate::TREASURY));
    }

    #[test]
    fn clean_traffic_never_reverts_on_purpose() {
        let mut rng = StdRng::seed_from_u64(7);
        let held = Holdings {
            deposits: 5,
            wraps: 5,
            ..Default::default()
        };
        for _ in 0..5_000 {
            assert_ne!(pick(&mut rng, 0, &held, true).kind, Kind::Revert);
        }
    }

    #[test]
    fn nobody_redeems_or_unwraps_what_they_never_put_in() {
        let mut rng = StdRng::seed_from_u64(11);
        let held = Holdings::default();
        for _ in 0..5_000 {
            let kind = pick(&mut rng, 1, &held, false).kind;
            assert!(!matches!(kind, Kind::Redeem | Kind::Unwrap), "{kind}");
        }
    }

    #[test]
    fn every_kind_turns_up_given_the_chance() {
        let mut rng = StdRng::seed_from_u64(3);
        let held = Holdings {
            deposits: 10,
            wraps: 10,
            ..Default::default()
        };
        let mut seen = std::collections::HashSet::new();
        for _ in 0..5_000 {
            seen.insert(pick(&mut rng, 3, &held, false).kind);
        }
        for kind in [
            Kind::Pay,
            Kind::Mint,
            Kind::Transfer,
            Kind::Deposit,
            Kind::Redeem,
            Kind::Wrap,
            Kind::Unwrap,
            Kind::Revert,
        ] {
            assert!(seen.contains(&kind), "{kind} never came up");
        }
    }

    #[test]
    fn a_payment_never_goes_to_its_sender() {
        let mut rng = StdRng::seed_from_u64(5);
        for from in SENDERS {
            for _ in 0..500 {
                assert_ne!(someone_else(&mut rng, from), from);
            }
        }
    }

    #[test]
    fn deposits_are_approved_for_the_vault_they_go_to() {
        // A deposit is transferFrom underneath. Approving any other address
        // — or approving the vault on a different token — makes every
        // deposit revert, and the traffic would look fine while doing it.
        let [mint, approve] = setup_calls(0);
        assert_eq!(mint.to, contract("Token"));
        assert_eq!(approve.to, contract("Token"));
        assert_eq!(&approve.input[4..36], &address_word(contract("Vault")));
    }

    #[test]
    fn the_node_s_nonce_complaints_are_recognised() {
        assert!(nonce_trouble(
            "eth_sendRawTransaction: nonce too low: next nonce 5, tx nonce 4"
        ));
        assert!(nonce_trouble("already known"));
        assert!(nonce_trouble("replacement transaction underpriced"));
        assert!(!nonce_trouble("insufficient funds for gas * price + value"));
    }

    #[test]
    fn a_signed_transaction_recovers_to_its_sender() {
        let key: PrivateKeySigner = crate::DEV_ACCOUNTS[1].1.parse().unwrap();
        let call = setup_calls(1)[0].clone();
        let raw = sign(&key, 31337, 4, 7, &call).unwrap();
        let bytes = hex::decode(raw.trim_start_matches("0x")).unwrap();
        // Type 2, as EIP-1559 says, and it recovers to the account it claims.
        assert_eq!(bytes[0], 0x02);
        use alloy::eips::eip2718::Decodable2718;
        let envelope = TxEnvelope::decode_2718(&mut bytes.as_slice()).unwrap();
        let signed = envelope.as_eip1559().expect("an EIP-1559 transaction");
        let recovered = signed
            .signature()
            .recover_address_from_prehash(&signed.signature_hash())
            .unwrap();
        assert_eq!(recovered, account(1));
        assert_eq!(signed.tx().nonce, 4);
        assert_eq!(signed.tx().chain_id, 31337);
    }

    #[test]
    fn a_clean_run_fails_loudly_and_an_ordinary_one_expects_reverts() {
        let fine = Tally {
            included: 40,
            reverted: 0,
            waiting: 0,
        };
        let with_reverts = Tally {
            included: 40,
            reverted: 2,
            waiting: 0,
        };
        let stuck = Tally {
            included: 40,
            reverted: 0,
            waiting: 3,
        };
        let nothing = Tally {
            included: 0,
            reverted: 0,
            waiting: 12,
        };

        assert!(verdict(true, fine, 0).is_ok());
        assert!(verdict(true, with_reverts, 0).is_err());
        // The gotcha that cost an hour once: accepted, never mined, no error.
        let said = verdict(true, stuck, 0).unwrap_err().to_string();
        assert!(said.contains("never included"), "{said}");
        assert!(verdict(true, fine, 1).is_err());

        // Reverts are the point of an ordinary run, and so is the odd refusal.
        assert!(verdict(false, with_reverts, 1).is_ok());
        assert!(verdict(false, stuck, 0).is_ok());
        assert!(verdict(false, nothing, 0).is_err());
    }

    #[test]
    fn amounts_print_as_people_read_them() {
        assert_eq!(hundredths(1), "0.01");
        assert_eq!(hundredths(150), "1.50");
        assert_eq!(hundredths(100), "1.00");
    }
}
