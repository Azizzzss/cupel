//! The Cupel control plane.
//!
//! One command brings up a local Ethereum chain and keeps it producing blocks.
//! The execution client runs in a container; the thing that tells it to make
//! blocks runs here, because since the merge an execution client will not make
//! one on its own.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use cupel_producer::{Config, Head, Producer, generate_jwt_secret, parse_jwt_secret};
use tokio::process::Command;

/// Accounts every Ethereum development tool already knows, so a wallet can be
/// set up by pasting a key people usually have to hand.
///
/// Published keys, for local use only.
const DEV_ACCOUNTS: [(&str, &str); 4] = [
    (
        "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    ),
    (
        "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    ),
    (
        "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
        "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    ),
    (
        "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
        "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    ),
];

const RPC_URL: &str = "http://127.0.0.1:8545";
const ENGINE_URL: &str = "http://127.0.0.1:8551";

#[derive(Debug, Parser)]
#[command(
    name = "cupel",
    version,
    about = "A local Ethereum lab: one command, a real chain, contracts ready to take apart"
)]
struct Cli {
    /// Path to the Cupel checkout. Found by searching upward when omitted.
    #[arg(long, global = true)]
    root: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Start the chain and produce blocks until interrupted.
    Up {
        /// Seconds between blocks.
        #[arg(long, default_value_t = 1)]
        block_time: u64,

        /// Leave the container running after Cupel exits.
        #[arg(long)]
        keep: bool,
    },
    /// Stop the chain, keeping its data.
    Down,
    /// Stop the chain and delete its data.
    Reset,
    /// Report whether the chain is up, and where it has got to.
    Status,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let root = match &cli.root {
        Some(path) => path.clone(),
        None => find_root().context(
            "could not find a Cupel checkout — run this from inside one, or pass --root",
        )?,
    };

    match cli.command.unwrap_or(Commands::Up {
        block_time: 1,
        keep: false,
    }) {
        Commands::Up { block_time, keep } => up(&root, block_time, keep).await,
        Commands::Down => down(&root, false).await,
        Commands::Reset => down(&root, true).await,
        Commands::Status => status(&root).await,
    }
}

/// Walk upward from the working directory looking for the compose file.
fn find_root() -> Result<PathBuf> {
    let mut directory = std::env::current_dir()?;
    loop {
        if directory.join("compose/lab.yml").is_file() {
            return Ok(directory);
        }
        if !directory.pop() {
            bail!("no compose/lab.yml in this directory or any parent");
        }
    }
}

async fn up(root: &Path, block_time: u64, keep: bool) -> Result<()> {
    let secret = ensure_jwt_secret(root)?;

    println!("cupel: starting the execution client");
    compose(root, &["up", "-d", "--wait"])
        .await
        .context("docker compose could not start the chain")?;

    let producer = Producer::new(Config {
        engine_url: ENGINE_URL.to_string(),
        rpc_url: RPC_URL.to_string(),
        jwt_secret: secret,
        fee_recipient: DEV_ACCOUNTS[0].0.to_string(),
        block_time: Duration::from_secs(block_time),
        ..Config::default()
    });

    // `--wait` only proves the container is healthy, not that the RPC is
    // answering us over the published port, so confirm that ourselves before
    // claiming the chain is up.
    let mut head = wait_for_rpc(&producer).await?;
    banner(&head, block_time);

    let result = produce_until_interrupted(&producer, &mut head).await;

    if keep {
        println!("\ncupel: leaving the container running (--keep)");
    } else {
        println!("\ncupel: stopping the chain");
        compose(root, &["down"]).await.ok();
    }
    result
}

/// Produce blocks on a fixed interval until Ctrl-C.
async fn produce_until_interrupted(producer: &Producer, head: &mut Head) -> Result<()> {
    let mut ticker = tokio::time::interval(producer.config().block_time);
    // Blocks are produced on a schedule; falling behind should not cause a
    // burst of catch-up blocks with near-identical timestamps.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                match producer.produce_block(head).await {
                    Ok(block) => {
                        *head = block.head.clone();
                        if block.transactions > 0 {
                            println!(
                                "  block {:<6} {}  {} tx  {} gas",
                                block.head.number,
                                short(&block.head.hash),
                                block.transactions,
                                block.gas_used
                            );
                        }
                    }
                    Err(error) => {
                        eprintln!("cupel: block production failed: {error}");
                        return Err(error.into());
                    }
                }
            }
            _ = tokio::signal::ctrl_c() => return Ok(()),
        }
    }
}

async fn down(root: &Path, wipe: bool) -> Result<()> {
    if wipe {
        println!("cupel: stopping the chain and deleting its data");
        compose(root, &["down", "-v"]).await?;
        let secret = root.join("config/genesis/jwt.hex");
        // The secret belongs to the datadir that was just removed; leaving it
        // behind would pair a fresh chain with a stale token.
        std::fs::remove_file(&secret).ok();
    } else {
        println!("cupel: stopping the chain");
        compose(root, &["down"]).await?;
    }
    Ok(())
}

async fn status(root: &Path) -> Result<()> {
    let secret = match read_jwt_secret(root)? {
        Some(secret) => secret,
        None => {
            println!("cupel: not initialised — run `cupel up`");
            return Ok(());
        }
    };
    let producer = Producer::new(Config {
        engine_url: ENGINE_URL.to_string(),
        rpc_url: RPC_URL.to_string(),
        jwt_secret: secret,
        ..Config::default()
    });

    match producer.current_head().await {
        Ok(head) => {
            println!("cupel: running");
            println!("  rpc      {RPC_URL}");
            println!("  head     {} ({})", head.number, short(&head.hash));
            println!("  time     {}", head.timestamp);
        }
        Err(error) => {
            println!("cupel: not reachable at {RPC_URL}");
            println!("  {error}");
        }
    }
    Ok(())
}

/// Poll the public RPC until it answers, so failure is reported here rather
/// than as a confusing error from the first Engine API call.
async fn wait_for_rpc(producer: &Producer) -> Result<Head> {
    const ATTEMPTS: u32 = 40;
    let mut last = None;
    for _ in 0..ATTEMPTS {
        match producer.current_head().await {
            Ok(head) => return Ok(head),
            Err(error) => last = Some(error),
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    match last {
        Some(error) => Err(error).context(format!("the chain never answered on {RPC_URL}")),
        None => bail!("the chain never answered on {RPC_URL}"),
    }
}

/// Read the Engine API secret, creating one if this is a fresh checkout.
fn ensure_jwt_secret(root: &Path) -> Result<[u8; 32]> {
    if let Some(secret) = read_jwt_secret(root)? {
        return Ok(secret);
    }
    let path = root.join("config/genesis/jwt.hex");
    let generated = generate_jwt_secret();
    std::fs::write(&path, &generated)
        .with_context(|| format!("could not write {}", path.display()))?;
    println!("cupel: generated a new engine api secret");
    parse_jwt_secret(&generated).map_err(|error| anyhow::anyhow!(error))
}

fn read_jwt_secret(root: &Path) -> Result<Option<[u8; 32]>> {
    let path = root.join("config/genesis/jwt.hex");
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("could not read {}", path.display()))?;
    parse_jwt_secret(&text)
        .map(Some)
        .map_err(|error| anyhow::anyhow!("{} is unusable: {error}", path.display()))
}

async fn compose(root: &Path, args: &[&str]) -> Result<()> {
    let status = Command::new("docker")
        .arg("compose")
        .arg("-f")
        .arg(root.join("compose/lab.yml"))
        .args(args)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await
        .context("could not run `docker compose` — is Docker running?")?;

    if !status.success() {
        bail!("docker compose {} failed", args.join(" "));
    }
    Ok(())
}

fn banner(head: &Head, block_time: u64) {
    println!();
    println!("  Cupel v{}", env!("CARGO_PKG_VERSION"));
    println!("  ---------------------------------------------------");
    println!("  RPC          {RPC_URL}");
    println!("  Chain id     31337");
    println!("  Head         {} ({})", head.number, short(&head.hash));
    println!("  Block time   {block_time}s");
    println!();
    println!("  Accounts (10000 ETH each)");
    for (index, (address, key)) in DEV_ACCOUNTS.iter().enumerate() {
        println!("  ({index}) {address}");
        println!("      {key}");
    }
    println!();
    println!("  These keys are public. Never use them on a real network.");
    println!();
    println!("  Producing blocks. Ctrl-C to stop.");
    println!();
}

fn short(hash: &str) -> String {
    if hash.len() <= 12 {
        return hash.to_string();
    }
    format!("{}…{}", &hash[..8], &hash[hash.len() - 4..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_shorten_predictably() {
        let hash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        assert_eq!(short(hash), "0x123456…cdef");
        // Anything already short is left alone rather than panicking on a slice.
        assert_eq!(short("0xabc"), "0xabc");
        assert_eq!(short(""), "");
    }

    #[test]
    fn dev_accounts_are_well_formed() {
        for (address, key) in DEV_ACCOUNTS {
            assert_eq!(address.len(), 42, "{address}");
            assert!(address.starts_with("0x"));
            assert_eq!(key.len(), 66, "{key}");
            assert!(key.starts_with("0x"));
        }
    }
}
