//! Guided walkthroughs: the machinery, narrated while it runs.
//!
//! Each walkthrough performs real work against a running chain and prints what
//! it sent and what came back. Nothing here is a simulation and nothing is
//! pre-recorded — if the chain is not up, the walkthrough fails, which is the
//! honest outcome.
//!
//! The prose is deliberately in the code rather than in a separate document.
//! A lesson that drifts from the thing it describes is worse than no lesson,
//! and the only reliable way to keep them together is to make them one file.

use std::time::Duration;

use alloy::consensus::{SignableTransaction, TxEip1559, TxEnvelope};
use alloy::eips::eip2718::Encodable2718;
use alloy::primitives::{Bytes, TxKind, U256};
use alloy::signers::SignerSync;
use alloy::signers::local::PrivateKeySigner;
use anyhow::{Context, Result, bail};
use cupel_producer::{Config, Exchange, Producer};
use serde_json::Value;

use crate::network;

/// One walkthrough.
struct Walkthrough {
    /// How it is selected: `cupel lab 1`.
    number: u8,
    /// One line, as it appears in the list.
    title: &'static str,
    /// What the reader will end up understanding.
    teaches: &'static str,
    /// Which chain it needs.
    mode: Mode,
}

/// Which chain a walkthrough runs against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// The single node from `cupel up`.
    Lab,
    /// The devnet from `cupel network up`.
    Network,
}

impl Mode {
    fn how_to_start(self) -> &'static str {
        match self {
            Mode::Lab => "cupel up",
            Mode::Network => "cupel network up --detach",
        }
    }
}

const WALKTHROUGHS: &[Walkthrough] = &[
    Walkthrough {
        number: 1,
        title: "How a block is made",
        teaches: "The four authenticated calls between an execution client and \
                  whatever is telling it to build. This is the conversation the \
                  merge created, and it is normally invisible.",
        mode: Mode::Lab,
    },
    Walkthrough {
        number: 2,
        title: "Where a transaction waits",
        teaches: "That a transaction is accepted long before it is included, \
                  and that those are different states with different answers \
                  from the node.",
        mode: Mode::Lab,
    },
    Walkthrough {
        number: 3,
        title: "Slots, epochs and finality",
        teaches: "The units consensus is measured in, and what has to happen \
                  before a block stops being reversible.",
        mode: Mode::Network,
    },
    Walkthrough {
        number: 4,
        title: "Three clients, one chain",
        teaches: "That agreement is a result rather than an assumption — ask \
                  three independent implementations the same question and \
                  compare what they say.",
        mode: Mode::Network,
    },
];

/// Print the list of walkthroughs.
pub(crate) fn list() {
    println!();
    println!("  Walkthroughs");
    println!("  ---------------------------------------------------");
    for walk in WALKTHROUGHS {
        let mode = match walk.mode {
            Mode::Lab => "lab",
            Mode::Network => "network",
        };
        println!("  {}  {:<28} [{mode}]", walk.number, walk.title);
    }
    println!();
    println!("  cupel lab 1        run the first one");
    println!();
}

/// Run one walkthrough by number.
pub(crate) async fn run(root: &std::path::Path, number: u8) -> Result<()> {
    let walk = WALKTHROUGHS
        .iter()
        .find(|w| w.number == number)
        .with_context(|| format!("there is no walkthrough {number}; `cupel lab` lists them"))?;

    heading(walk);
    match number {
        1 => how_a_block_is_made(root).await,
        2 => where_a_transaction_waits(root).await,
        3 => slots_epochs_and_finality().await,
        4 => three_clients_one_chain().await,
        _ => unreachable!("the walkthrough was found by number"),
    }
}

// ------------------------------------------------------------ walkthrough 1

/// The Engine API handshake, one block's worth.
async fn how_a_block_is_made(root: &std::path::Path) -> Result<()> {
    let producer = lab_producer(root)?;

    say(
        "Since the merge an execution client does not decide when a block \
         happens. It executes transactions and answers questions; something \
         else has to ask it for a block. That request goes over a separate \
         port, authenticated with a shared secret, and it is the only way in.",
    );

    let head = producer
        .current_head()
        .await
        .context("the node is not answering — is `cupel up` running?")?;

    field("Chain head before", &format!("block {}", head.number));
    field("Engine API", crate::ENGINE_URL);
    field(
        "Authenticated by",
        "a 32-byte secret in config/genesis/jwt.hex",
    );

    say(
        "The token is regenerated for every call. Its `iat` claim is only \
         accepted within a narrow window either side of the node's clock, so a \
         token cached for a minute starts being rejected.",
    );

    let produced = producer
        .produce_block(&head)
        .await
        .context("the block was not produced")?;
    let exchanges = &produced.exchanges;
    if exchanges.len() != 4 {
        bail!(
            "expected four Engine API calls, saw {} — the producer has changed",
            exchanges.len()
        );
    }

    step(1, "Ask for a block");
    say(
        "`engine_forkchoiceUpdatedV3` does two jobs at once. It states which \
         block is the head, and — when payload attributes are attached — asks \
         the client to start building the next one. The client answers with a \
         payload id, which is a receipt for work it has started, not a block.",
    );
    show(&exchanges[0], &["payloadStatus", "status"], &["payloadId"]);

    step(2, "Wait, then collect it");
    say(
        "The client does not build the block immediately. It returns an empty \
         one straight away and fills it in on a timer — which is why collecting \
         too early yields a chain of empty blocks, with the transactions still \
         sitting in the pool and no error anywhere. `engine_getPayloadV3` \
         collects whatever has been assembled under that payload id.",
    );
    show(
        &exchanges[1],
        &["executionPayload", "blockNumber"],
        &["executionPayload", "gasUsed"],
    );

    step(3, "Hand it back to be checked");
    say(
        "The client has now built a block but has not verified or stored it. \
         `engine_newPayloadV3` gives it back to be executed and validated. Only \
         `VALID` counts: `SYNCING` and `ACCEPTED` are legitimate answers on a \
         real network and here mean something is wrong.",
    );
    show(&exchanges[2], &["status"], &["latestValidHash"]);

    step(4, "Adopt it");
    say("A validated block is still not the head. The second \
         `engine_forkchoiceUpdatedV3` — with no attributes this time, so it is \
         not asking for another block — moves the head onto it. Here safe and \
         finalized move with the head too, because a single producer has \
         nothing to disagree with. On a real network they lag behind by design.");
    show(&exchanges[3], &["payloadStatus", "status"], &["payloadId"]);

    field(
        "Chain head after",
        &format!("block {}", produced.head.number),
    );
    field("Transactions in it", &produced.transactions.to_string());
    field("Gas used", &produced.gas_used.to_string());
    field(
        "Time in the client",
        &format!(
            "{:.1?} across four calls",
            exchanges.iter().map(|e| e.elapsed).sum::<Duration>()
        ),
    );

    closing(&[
        "Four calls, one block. That is the whole of it.",
        "The producer doing this in `cupel up` is 500 lines, and it is not a \
         consensus client: it never attests, never chooses between two chains, \
         and its `finalized` is a convenient fiction. Walkthrough 3 runs the \
         real thing.",
        "Source: crates/producer/src/lib.rs",
    ]);
    Ok(())
}

// ------------------------------------------------------------ walkthrough 2

/// Accepted, pending, included — three different states.
async fn where_a_transaction_waits(root: &std::path::Path) -> Result<()> {
    let producer = lab_producer(root)?;

    say(
        "Sending a transaction and having it take effect are two events, and \
         what sits between them is a state the node will tell you about if you \
         ask the right question. This walkthrough sends one and asks.",
    );

    let head = producer
        .current_head()
        .await
        .context("the node is not answering — is `cupel up` running?")?;
    field("Chain head", &format!("block {}", head.number));

    step(1, "Send it");
    say(
        "A transfer between two of the development accounts, signed locally and \
         submitted with `eth_sendRawTransaction`. The node answers with a hash \
         immediately — which means it accepted the transaction into its pool, \
         and nothing more than that.",
    );

    let hash = send_a_transfer().await?;
    field("Transaction hash", &short(&hash));

    step(2, "Ask where it is");
    say(
        "`eth_getTransactionByHash` finds it. Look at `blockNumber`: it is null. \
         The node knows about the transaction and will tell you its contents, \
         and it has not put it in a block.",
    );
    let quoted = format!("\"{hash}\"");
    let tx = rpc(crate::NODE_RPC_URL, "eth_getTransactionByHash", &[&quoted]).await?;
    field(
        "blockNumber",
        &match tx.get("blockNumber") {
            Some(Value::Null) | None => "null — not in a block yet".to_string(),
            Some(other) => summarise(other),
        },
    );

    say(
        "`eth_getTransactionReceipt` is the sharper question. A receipt is proof \
         of execution, so there cannot be one yet — and the node returns null \
         rather than an error. This is the check to write in code: a hash back \
         from the node means accepted, not done.",
    );
    let receipt = rpc(crate::NODE_RPC_URL, "eth_getTransactionReceipt", &[&quoted]).await?;
    field(
        "Receipt",
        if receipt.is_null() {
            "null — nothing has executed"
        } else {
            "present"
        },
    );

    step(3, "Look in the pool");
    say(
        "`txpool_status` counts what the node is holding. Pending means ready to \
         be included; queued means waiting on something, usually a nonce gap \
         where an earlier transaction from the same account has not arrived.",
    );
    let pool = rpc(crate::NODE_RPC_URL, "txpool_status", &[]).await?;
    field("Pending", &summarise(&pool["pending"]));
    field("Queued", &summarise(&pool["queued"]));

    step(4, "Make a block, and ask again");
    say(
        "Nothing about the transaction changes until somebody asks for a block. \
         That is walkthrough 1's four calls, run once.",
    );
    let produced = producer.produce_block(&head).await?;
    field("New head", &format!("block {}", produced.head.number));
    field("Transactions in it", &produced.transactions.to_string());

    let receipt = rpc(crate::NODE_RPC_URL, "eth_getTransactionReceipt", &[&quoted]).await?;
    if receipt.is_null() {
        say(
            "The receipt is still null. That happens when the transaction paid \
             less than the client's floor — the same failure the README \
             describes under --miner.gasprice, with no error attached to it.",
        );
    } else {
        field("Block", &summarise(&receipt["blockNumber"]));
        field(
            "Status",
            &format!("{} (1 is success)", summarise(&receipt["status"])),
        );
        field("Gas used", &summarise(&receipt["gasUsed"]));
    }

    closing(&[
        "Accepted, pending, included. A hash is the first of those, and code \
         that treats it as the last is the commonest bug in anything that sends \
         transactions.",
        "On a real network there is a fourth state after inclusion — finalised — \
         and walkthrough 3 is about that one.",
    ]);
    Ok(())
}

// ------------------------------------------------------------ walkthrough 3

/// What the beacon chain is counting.
async fn slots_epochs_and_finality() -> Result<()> {
    let beacon = network::NODES[0].beacon;
    require_network(beacon).await?;

    say(
        "Lab mode has no consensus: a producer on the host asks for a block \
         whenever it feels like it. A real chain divides time into fixed slots, \
         groups slots into epochs, and decides by vote which blocks are \
         permanent. This walkthrough reads those numbers off a running devnet.",
    );

    step(1, "Where the chain is");
    let syncing = get(&format!("{beacon}/eth/v1/node/syncing")).await?;
    let slot: u64 = syncing["data"]["head_slot"]
        .as_str()
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    field("Head slot", &slot.to_string());
    field("Epoch", &format!("{} — 32 slots each", slot / 32));
    field("Slot length", "6 seconds, so an epoch is 3 minutes 12");
    say(
        "A slot is a fixed opportunity for exactly one validator to propose. It \
         passes whether or not they do — a missed slot leaves a gap in the slot \
         numbers and no gap in the chain.",
    );

    step(2, "Who was supposed to propose");
    say(
        "Duties are assigned in advance from the state, so every validator knows \
         which slots are theirs before the epoch begins.",
    );
    let epoch = slot / 32;
    let duties = get(&format!(
        "{beacon}/eth/v1/validator/duties/proposer/{epoch}"
    ))
    .await?;
    if let Some(list) = duties["data"].as_array() {
        for duty in list.iter().take(5) {
            field(
                "Proposer",
                &format!(
                    "slot {} → validator {}",
                    duty["slot"].as_str().unwrap_or("?"),
                    duty["validator_index"].as_str().unwrap_or("?")
                ),
            );
        }
        field("Assigned this epoch", &format!("{} slots", list.len()));
    }

    step(3, "What the votes decided");
    say(
        "Every validator attests each epoch, voting for the chain it sees. When \
         more than two thirds of the stake votes for the same checkpoint, that \
         epoch is justified. When the epoch after it is justified too, the first \
         becomes finalised — reversing it would then mean burning a third of all \
         the stake on the network.",
    );
    let checkpoints = get(&format!(
        "{beacon}/eth/v1/beacon/states/head/finality_checkpoints"
    ))
    .await?;
    field(
        "Justified epoch",
        checkpoints["data"]["current_justified"]["epoch"]
            .as_str()
            .unwrap_or("?"),
    );
    field(
        "Finalised epoch",
        checkpoints["data"]["finalized"]["epoch"]
            .as_str()
            .unwrap_or("?"),
    );
    say(
        "Finality trails the head by roughly two epochs — about six minutes on \
         this chain, about thirteen on mainnet. That gap is not latency waiting \
         to be optimised away; it is how long collecting the votes takes.",
    );

    step(4, "The threshold, in this network's numbers");
    field("Validators", "64, split 22 / 21 / 21 across three nodes");
    field("Needed to finalise", "more than 2/3, so more than 42");
    field("Any two nodes", "43 of 64, which is 67.19%");
    field("With one node down", "exactly at the line, and it stops");
    say(
        "Which is why stopping any single node here stops finality without \
         stopping block production. The chain keeps growing and stops becoming \
         permanent. Three nodes holding a third each cannot survive losing one — \
         that is the two thirds threshold being a threshold, at a scale where \
         you can watch it happen.",
    );

    closing(&[
        "Slots are time. Epochs are the accounting period. Justification is a \
         supermajority agreeing, and finality is that happening twice in a row.",
        "Walkthrough 4 asks all three clients whether they agree about it.",
    ]);
    Ok(())
}

// ------------------------------------------------------------ walkthrough 4

/// Independent implementations, one answer.
async fn three_clients_one_chain() -> Result<()> {
    require_network(network::NODES[0].beacon).await?;

    say(
        "Ethereum has no reference implementation. Lighthouse is Rust, Prysm is \
         Go, Teku is Java: different teams, different codebases, one \
         specification. That they agree is a property of the network rather than \
         of any program in it — and it is checkable rather than assumed.",
    );

    step(1, "Ask each the same question");
    say(
        "The beacon API is standardised, so one request goes to all three and \
         the answers should be identical.",
    );
    println!("      client       finalised epoch   finalised block root");
    println!("      ------------------------------------------------------------");
    let mut roots = Vec::new();
    for node in network::NODES {
        let checkpoints = get(&format!(
            "{}/eth/v1/beacon/states/head/finality_checkpoints",
            node.beacon
        ))
        .await
        .unwrap_or(Value::Null);
        let header = get(&format!("{}/eth/v1/beacon/headers/finalized", node.beacon))
            .await
            .unwrap_or(Value::Null);
        let epoch = checkpoints["data"]["finalized"]["epoch"]
            .as_str()
            .unwrap_or("—");
        let root = header["data"]["root"].as_str().unwrap_or("—");
        roots.push(root.to_string());
        println!(
            "      {:<12} {:>15}   {}",
            node.consensus,
            epoch,
            short(root)
        );
    }
    println!();
    field(
        "Verdict",
        if roots.iter().all(|r| r == &roots[0]) && roots[0] != "—" {
            "one root, three clients — they agree"
        } else {
            "the clients disagree, which is worth investigating"
        },
    );

    step(2, "And the execution layer underneath");
    say(
        "Each beacon node drives its own geth. If consensus agrees then the \
         execution chain under it must agree too: same block, same hash.",
    );
    println!("      node     finalised block   hash");
    println!("      ------------------------------------------------------------");
    let mut hashes = Vec::new();
    for node in network::NODES {
        let block = rpc(
            node.rpc,
            "eth_getBlockByNumber",
            &["\"finalized\"", "false"],
        )
        .await
        .unwrap_or(Value::Null);
        let hash = block["hash"].as_str().unwrap_or("—");
        hashes.push(hash.to_string());
        println!(
            "      {:<8} {:>15}   {}",
            node.name,
            block["number"]
                .as_str()
                .and_then(|h| u64::from_str_radix(h.trim_start_matches("0x"), 16).ok())
                .map_or_else(|| "—".to_string(), |n| n.to_string()),
            short(hash)
        );
    }
    println!();
    field(
        "Verdict",
        if hashes.iter().all(|h| h == &hashes[0]) && hashes[0] != "—" {
            "one block, three execution clients"
        } else {
            "the execution clients disagree"
        },
    );

    step(3, "Why this is the point");
    say(
        "A bug in a client that more than a third of the network runs can stop \
         the chain finalising. A bug in one that more than two thirds run can \
         finalise something wrong. That is the argument for client diversity, \
         and on a network of three you can hold the whole of it in view.",
    );
    say(
        "It is also why the validators here are split 22 / 21 / 21 rather than \
         all given to one node: a finalised epoch on this chain required at \
         least two independent implementations to have agreed.",
    );

    closing(&[
        "Three programs, written separately, arriving at the same block.",
        "`cupel network status` prints this whenever you want it.",
    ]);
    Ok(())
}

// ------------------------------------------------------------------ plumbing

/// A producer pointed at the lab node, recording what it sends.
///
/// `record_exchanges` is what makes walkthrough 1 possible: there is one
/// implementation of how a block gets made, and it can narrate itself rather
/// than being reimplemented beside a lesson about it and drifting.
fn lab_producer(root: &std::path::Path) -> Result<Producer> {
    let secret = crate::read_jwt_secret(root)?
        .context("no Engine API secret yet — start the chain with `cupel up` first")?;
    Ok(Producer::new(Config {
        engine_url: crate::ENGINE_URL.to_string(),
        rpc_url: crate::NODE_RPC_URL.to_string(),
        jwt_secret: secret,
        fee_recipient: crate::DEV_ACCOUNTS[0].0.to_string(),
        record_exchanges: true,
        ..Config::default()
    }))
}

/// Sign and submit a small transfer between two development accounts.
///
/// Written out here rather than borrowed from the signer crate, because the
/// signer evaluates a policy before it will sign and this is a lesson about
/// transactions rather than about policy. It is also the shortest honest
/// answer to "what is in a transaction": these nine fields and a signature
/// over them.
async fn send_a_transfer() -> Result<String> {
    let from = crate::DEV_ACCOUNTS[0];
    let to = crate::DEV_ACCOUNTS[1].0;
    let key: PrivateKeySigner = from
        .1
        .parse()
        .context("the development private key did not parse")?;

    let nonce = hex_u64(
        &rpc(
            crate::NODE_RPC_URL,
            "eth_getTransactionCount",
            &[from.0, "\"pending\""],
        )
        .await?,
    );

    // The base fee is set by the chain and rises with demand; the tip is what
    // the sender adds on top. Doubling the base leaves room for it to rise
    // between reading it and being included, and anything unspent is refunded.
    let block = rpc(
        crate::NODE_RPC_URL,
        "eth_getBlockByNumber",
        &["\"latest\"", "false"],
    )
    .await?;
    let base_fee = hex_u64(&block["baseFeePerGas"]).max(7);
    let tip: u128 = 1_000_000_000;

    let transaction = TxEip1559 {
        chain_id: 31337,
        nonce,
        gas_limit: 21_000,
        max_fee_per_gas: u128::from(base_fee) * 2 + tip,
        max_priority_fee_per_gas: tip,
        to: TxKind::Call(to.parse().context("the recipient address did not parse")?),
        value: U256::from(1_000_000_000_000_000_000u64),
        input: Bytes::new(),
        access_list: Default::default(),
    };

    let signature = key.sign_hash_sync(&transaction.signature_hash())?;
    let envelope = TxEnvelope::Eip1559(transaction.into_signed(signature));
    let mut raw = Vec::new();
    envelope.encode_2718(&mut raw);
    let encoded = format!(
        "0x{}",
        raw.iter().map(|b| format!("{b:02x}")).collect::<String>()
    );

    let hash = rpc(
        crate::NODE_RPC_URL,
        "eth_sendRawTransaction",
        &[&format!("\"{encoded}\"")],
    )
    .await?;
    Ok(hash.as_str().unwrap_or_default().to_string())
}

/// Read a `0x`-prefixed quantity. Zero when it is missing or malformed, which
/// is the right answer for a nonce and a survivable one for a fee.
fn hex_u64(value: &Value) -> u64 {
    value
        .as_str()
        .and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok())
        .unwrap_or(0)
}

/// A JSON-RPC call against a public endpoint.
///
/// Parameters arrive as strings and are parsed as JSON where they can be, so a
/// caller can pass `"false"` for a boolean and `0xabc…` for an address without
/// two spellings of the same argument list.
async fn rpc(url: &str, method: &str, params: &[&str]) -> Result<Value> {
    let params: Vec<Value> = params
        .iter()
        .map(|p| serde_json::from_str(p).unwrap_or_else(|_| Value::String((*p).to_string())))
        .collect();
    let response: Value = reqwest::Client::new()
        .post(url)
        .json(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params
        }))
        .send()
        .await
        .with_context(|| format!("{url} did not answer"))?
        .json()
        .await?;
    if let Some(error) = response.get("error").filter(|e| !e.is_null()) {
        bail!("{method}: {error}");
    }
    Ok(response["result"].clone())
}

/// A GET against a beacon API.
async fn get(url: &str) -> Result<Value> {
    Ok(reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?
        .get(url)
        .send()
        .await
        .with_context(|| format!("{url} did not answer"))?
        .json()
        .await?)
}

/// Refuse to run a network walkthrough against a chain that is not there.
async fn require_network(beacon: &str) -> Result<()> {
    if get(&format!("{beacon}/eth/v1/node/version")).await.is_err() {
        bail!(
            "this walkthrough needs the devnet — start it with \
             `cupel network up --detach`, then run this again"
        );
    }
    Ok(())
}

// ------------------------------------------------------------------ printing

fn heading(walk: &Walkthrough) {
    println!();
    println!("  ---------------------------------------------------------------");
    println!("  Walkthrough {} — {}", walk.number, walk.title);
    println!("  ---------------------------------------------------------------");
    println!();
    for line in wrap(walk.teaches, 66) {
        println!("  {line}");
    }
    println!();
    println!(
        "  Needs a chain started with `{}`",
        walk.mode.how_to_start()
    );
    println!();
}

fn step(number: u8, title: &str) {
    println!();
    println!("  -- {number}. {title} --");
    println!();
}

fn say(text: &str) {
    for line in wrap(text, 66) {
        println!("  {line}");
    }
    println!();
}

fn field(label: &str, value: &str) {
    println!("      {label:<22} {value}");
}

fn closing(lines: &[&str]) {
    println!();
    println!("  ---------------------------------------------------------------");
    for line in lines {
        for wrapped in wrap(line, 66) {
            println!("  {wrapped}");
        }
        println!();
    }
}

/// Print one Engine API exchange: the method, what was sent, and the two
/// fields of the answer that carry the meaning.
fn show(exchange: &Exchange, first: &[&str], second: &[&str]) {
    field("Method", &exchange.method);
    field("Sent", &summarise(&exchange.request));
    field("Answered in", &format!("{:.1?}", exchange.elapsed));
    for path in [first, second] {
        if let Some(value) = dig(&exchange.response, path) {
            field(&format!("  {}", path.join(".")), &summarise(value));
        }
    }
    println!();
}

/// Follow a path of object keys.
fn dig<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |v, key| v.get(*key))
}

/// A one-line rendering of a JSON value, short enough for a terminal.
fn summarise(value: &Value) -> String {
    match value {
        Value::String(s) => short(s),
        Value::Array(items) => {
            let inner: Vec<String> = items.iter().take(3).map(summarise).collect();
            if items.len() > 3 {
                format!("[{}, … {} items]", inner.join(", "), items.len())
            } else {
                format!("[{}]", inner.join(", "))
            }
        }
        Value::Object(map) => {
            let keys: Vec<&str> = map.keys().take(5).map(String::as_str).collect();
            if map.len() > 5 {
                format!("{{{}, … {} fields}}", keys.join(", "), map.len())
            } else {
                format!("{{{}}}", keys.join(", "))
            }
        }
        other => other.to_string(),
    }
}

/// Shorten a hash so a line of output stays one line.
fn short(text: &str) -> String {
    if text.chars().count() <= 22 {
        return text.to_string();
    }
    format!("{}…{}", &text[..12], &text[text.len() - 6..])
}

/// Wrap prose to a width, breaking on spaces.
fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        if !current.is_empty() && current.chars().count() + 1 + word.chars().count() > width {
            lines.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walkthroughs_are_numbered_from_one_without_gaps() {
        for (index, walk) in WALKTHROUGHS.iter().enumerate() {
            assert_eq!(
                walk.number as usize,
                index + 1,
                "`cupel lab N` selects by number, so the numbers must be the order"
            );
        }
    }

    #[test]
    fn every_listed_walkthrough_has_a_branch_in_run() {
        // `run` matches on the number and would panic on a walkthrough that was
        // listed but never wired up.
        assert_eq!(
            WALKTHROUGHS.len(),
            4,
            "a walkthrough was added to the list without a branch in `run`"
        );
    }

    #[test]
    fn wrapping_never_exceeds_the_width_or_loses_a_word() {
        let text = "Since the merge an execution client does not decide when a \
                    block happens, which is the whole point of this exercise.";
        let lines = wrap(text, 30);
        for line in &lines {
            assert!(line.chars().count() <= 30, "too long: {line:?}");
        }
        assert_eq!(
            lines.join(" ").split_whitespace().count(),
            text.split_whitespace().count(),
            "wrapping dropped or duplicated a word"
        );
    }

    #[test]
    fn a_word_longer_than_the_width_still_gets_a_line() {
        let lines = wrap("short 0xabcdefabcdefabcdefabcdef end", 10);
        assert_eq!(lines.len(), 3, "{lines:?}");
        assert_eq!(lines[1], "0xabcdefabcdefabcdefabcdef");
    }

    #[test]
    fn hashes_are_shortened_and_short_strings_are_not() {
        assert_eq!(short("VALID"), "VALID");
        assert_eq!(
            short("0x1234567890abcdef1234567890abcdef"),
            "0x1234567890…abcdef"
        );
    }

    #[test]
    fn summarise_keeps_a_line_to_a_line() {
        let payload = serde_json::json!({
            "parentHash": "0xaaaa", "feeRecipient": "0xbbbb", "stateRoot": "0xcccc",
            "receiptsRoot": "0xdddd", "logsBloom": "0xeeee", "prevRandao": "0xffff"
        });
        let line = summarise(&payload);
        assert!(line.contains("… 6 fields"), "{line}");
        assert!(!line.contains('\n'), "a summary is one line");
        assert!(summarise(&serde_json::json!(["a", "b", "c", "d", "e"])).contains("… 5 items"));
    }

    #[test]
    fn dig_follows_a_path_and_gives_up_quietly() {
        let value = serde_json::json!({"payloadStatus": {"status": "VALID"}});
        assert_eq!(
            dig(&value, &["payloadStatus", "status"]).and_then(Value::as_str),
            Some("VALID")
        );
        assert_eq!(dig(&value, &["payloadStatus", "missing"]), None);
        assert_eq!(dig(&value, &["nothing", "here"]), None);
    }

    #[test]
    fn each_mode_says_how_to_start_the_chain_it_needs() {
        assert!(Mode::Lab.how_to_start().starts_with("cupel up"));
        assert!(Mode::Network.how_to_start().starts_with("cupel network up"));
    }
}
