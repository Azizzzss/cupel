//! The Cupel control plane.
//!
//! One command brings up a local Ethereum chain and keeps it producing blocks.
//! The execution client runs in a container; the thing that tells it to make
//! blocks runs here, because since the merge an execution client will not make
//! one on its own.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

mod contracts;
mod lab;
mod network;
mod web;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use cupel_gateway::{Config as GatewayConfig, Gateway, Upstream};
use cupel_producer::{Config, Head, Producer, generate_jwt_secret, parse_jwt_secret};
use cupel_signer::{Config as SignerConfig, Policy, Signer};
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

/// The node's own JSON-RPC. The producer talks to it directly rather than
/// through the gateway: block production is not client traffic, and it must
/// keep working while the gateway is rate-limiting or refusing requests.
const NODE_RPC_URL: &str = "http://127.0.0.1:8546";
const ENGINE_URL: &str = "http://127.0.0.1:8551";
/// The ports everything else points at. The interface comes from `--bind`, so
/// these are halves of an address rather than addresses.
const GATEWAY_PORT: u16 = 8545;
/// The control room. Next to the gateway so it is obviously related, and not
/// on it: one is JSON-RPC for tools, the other is a page for a person.
const CONTROL_ROOM_PORT: u16 = 8544;
const GATEWAY_URL: &str = "http://127.0.0.1:8545";
/// The signing service. 8550 is the port Clef used to hold, which is where
/// anyone looking for a signer will think to look.
const SIGNER_ADDR: &str = "127.0.0.1:8550";
const SIGNER_URL: &str = "http://127.0.0.1:8550";
/// Account 2 is the signer's own key. Keeping it distinct from account 0 makes
/// it obvious in a trace which transactions the service sent.
const TREASURY: usize = 2;

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
        ///
        /// Rejected at zero rather than accepted: `tokio::time::interval`
        /// panics on a zero period, and it did so after the container was up
        /// and the banner printed, which reads as a crash rather than a typo.
        #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u64).range(1..))]
        block_time: u64,

        /// Leave the container running after Cupel exits.
        #[arg(long)]
        keep: bool,

        /// Address the gateway and the control room listen on.
        ///
        /// Localhost by default. `0.0.0.0` makes them reachable from containers
        /// and from the network, which is what Prometheus needs on plain Linux
        /// Docker and what pointing another machine at this chain needs. The
        /// signer is deliberately not covered: it holds a key, and moving that
        /// off localhost should be a separate decision taken on purpose.
        ///
        /// An address, not a hostname: `localhost` used to reach the socket
        /// parser, which expects host and port together, and panicked — after
        /// the container was already running.
        #[arg(long, default_value = "127.0.0.1")]
        bind: IpAddr,
    },
    /// Stop the chain, keeping its data.
    Down,
    /// Stop the chain and delete its data.
    Reset,
    /// Report whether the chain is up, and where it has got to.
    Status,
    /// List the reference contracts and the addresses they live at.
    Contracts,
    /// Start Prometheus and Grafana against the gateway, the nodes, and the clients.
    Observe {
        /// Stop them instead.
        #[arg(long)]
        down: bool,
    },
    /// Walk through a piece of the machinery, narrated while it runs.
    ///
    /// With no number, lists what there is. Each walkthrough does real work
    /// against a running chain and prints what it sent and what came back.
    Lab {
        /// Which one to run.
        number: Option<u8>,
    },
    /// Run the multi-client devnet instead of the single-node lab.
    ///
    /// Three execution clients paired with Lighthouse, Prysm and Teku, driven
    /// by sixty-four validators. Real consensus, real peers, real finality —
    /// and about twenty-five minutes to the first finalised epoch, where lab
    /// mode is instant.
    Network {
        #[command(subcommand)]
        command: NetworkCommand,
    },
    /// Rewrite the genesis file from the compiled contracts.
    ///
    /// Only needed after changing a contract; the result is committed so a
    /// clone needs no Solidity toolchain to bring a chain up.
    Genesis,
}

#[derive(Debug, Subcommand)]
enum NetworkCommand {
    /// Generate a devnet, bring it up, and front all three nodes on 8545.
    Up {
        /// Start the containers and exit.
        ///
        /// Both the gateway and the control room live in this process, so
        /// detaching leaves the devnet running with neither: no 8545 across the
        /// three nodes, and no page on 8544. The clients' own ports still work.
        #[arg(long)]
        detach: bool,

        /// Address the gateway and the control room listen on.
        ///
        /// As for `cupel up`. Prometheus on plain Linux Docker cannot reach a
        /// gateway bound to localhost, which is why network mode needs this too.
        #[arg(long, default_value = "127.0.0.1")]
        bind: IpAddr,
    },
    /// Generate a devnet without starting it.
    Init,
    /// Stop the devnet, keeping its chains.
    Down,
    /// Stop the devnet and delete its chains.
    Reset,
    /// Ask all three nodes where the chain has got to.
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
        bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
    }) {
        Commands::Up {
            block_time,
            keep,
            bind,
        } => up(&root, block_time, keep, bind).await,
        Commands::Down => down(&root, false).await,
        Commands::Reset => down(&root, true).await,
        Commands::Status => status(&root).await,
        Commands::Contracts => {
            contracts::print_table();
            Ok(())
        }
        Commands::Observe { down } => observe(&root, down).await,
        Commands::Lab { number } => match number {
            Some(number) => lab::run(&root, number).await,
            None => {
                lab::list();
                Ok(())
            }
        },
        Commands::Network { command } => match command {
            NetworkCommand::Up { detach, bind } => network::up(&root, detach, bind).await,
            NetworkCommand::Init => network::init(&root).await,
            NetworkCommand::Down => network::down(&root, false).await,
            NetworkCommand::Reset => network::down(&root, true).await,
            NetworkCommand::Status => network::status(&root).await,
        },
        Commands::Genesis => {
            let count = contracts::regenerate_genesis(&root)?;
            println!("cupel: wrote {count} contracts into the genesis allocation");
            println!("cupel: run `cupel reset` for a chain that carries them");
            Ok(())
        }
    }
}

/// Take a port before anything announces it.
///
/// Binding inside a spawned task hides the one failure that matters here.
/// `serve` returns its error to a `JoinHandle` nobody reads, so a port already
/// held by something else produced a banner promising an RPC at an address this
/// process did not have — and the address answered, because the other process
/// was still on it, with a different chain.
pub(crate) async fn bind(address: &str, what: &str) -> Result<tokio::net::TcpListener> {
    let socket: SocketAddr = address
        .parse()
        .with_context(|| format!("the {what} cannot listen on {address}: not an address"))?;
    tokio::net::TcpListener::bind(socket)
        .await
        .with_context(|| {
            format!(
                "could not put the {what} on {address} — something else is already \
                 listening there. If that is another cupel running in the \
                 foreground, stop it with Ctrl-C; `cupel down` and `cupel \
                 network down` stop containers, not a process holding a port."
            )
        })
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

async fn up(root: &Path, block_time: u64, keep: bool, listen: IpAddr) -> Result<()> {
    let secret = ensure_jwt_secret(root)?;

    println!("cupel: starting the execution client");
    compose(root, &["up", "-d", "--wait"])
        .await
        .context("docker compose could not start the chain")?;

    let producer = Producer::new(Config {
        engine_url: ENGINE_URL.to_string(),
        rpc_url: NODE_RPC_URL.to_string(),
        jwt_secret: secret,
        fee_recipient: DEV_ACCOUNTS[0].0.to_string(),
        block_time: Duration::from_secs(block_time),
        ..Config::default()
    });

    // `--wait` only proves the container is healthy, not that the RPC is
    // answering us over the published port, so confirm that ourselves before
    // claiming the chain is up.
    let head = wait_for_rpc(&producer).await?;

    // The gateway fronts the node on 8545. It runs in this process rather than
    // a container so there is one binary to rebuild while iterating, and so it
    // shares a lifetime with the chain it is fronting.
    let gateway = Arc::new(Gateway::new(
        GatewayConfig::default(),
        vec![Upstream::new("geth", NODE_RPC_URL)],
    ));
    gateway.probe_once().await;

    let gateway_addr = SocketAddr::new(listen, GATEWAY_PORT).to_string();
    let listener = bind(&gateway_addr, "gateway").await?;
    let gateway_url = url_for(listen, GATEWAY_PORT);
    let serving = tokio::spawn(cupel_gateway::serve_on(Arc::clone(&gateway), listener));
    let probing = tokio::spawn(Arc::clone(&gateway).probe_forever());

    // The signing service holds one key under a policy. Nothing in the lab is
    // obliged to use it -- cast and MetaMask sign for themselves -- but it is
    // what an application should be given instead of a raw key.
    let signer = Arc::new(Signer::new(
        SignerConfig {
            chain_id: 31337,
            audit_path: Some(root.join("data/audit.log")),
            policy: Policy::default(),
        },
        &[DEV_ACCOUNTS[TREASURY].1.to_string()],
    )?);
    let signer_listener = bind(SIGNER_ADDR, "signer").await?;
    let signing = tokio::spawn(cupel_signer::serve_on(Arc::clone(&signer), signer_listener));

    // The control room serves the built interface and the one endpoint the
    // browser cannot cover for itself. The head is shared with the production
    // loop behind a lock so a block asked for in the browser and a block the
    // loop was about to make cannot build on the same parent.
    let shared_head = Arc::new(tokio::sync::Mutex::new(head.clone()));
    let narrator = Arc::new(Producer::new(Config {
        engine_url: ENGINE_URL.to_string(),
        rpc_url: NODE_RPC_URL.to_string(),
        jwt_secret: secret,
        fee_recipient: DEV_ACCOUNTS[0].0.to_string(),
        block_time: Duration::from_secs(block_time),
        // The point of this one: it keeps a copy of what it sent, so a
        // walkthrough can show the sequence rather than describe it.
        record_exchanges: true,
        ..Config::default()
    }));
    let control_addr = SocketAddr::new(listen, CONTROL_ROOM_PORT).to_string();
    let control_listener = web::bind(&control_addr).await?;
    let control_url = url_for(listen, CONTROL_ROOM_PORT);
    let control = tokio::spawn(web::serve_on(
        control_listener,
        web::Control {
            producing: Some(web::Producing {
                narrator,
                head: Arc::clone(&shared_head),
            }),
        },
    ));

    banner(&head, block_time, &gateway_url, &control_url);

    let result = produce_until_interrupted(&producer, &shared_head).await;

    serving.abort();
    probing.abort();
    signing.abort();
    control.abort();

    if keep {
        println!("\ncupel: leaving the container running (--keep)");
    } else {
        println!("\ncupel: stopping the chain");
        compose(root, &["down"]).await.ok();
    }
    result
}

/// Produce blocks on a fixed interval until Ctrl-C.
///
/// A failure here is reported and retried, never fatal. The node going away is
/// a normal thing to survive — it is exactly when the gateway is most useful,
/// answering with a clear error instead of a refused connection — and killing
/// the whole process because one block could not be built would take the
/// gateway down with it.
async fn produce_until_interrupted(
    producer: &Producer,
    head: &Arc<tokio::sync::Mutex<Head>>,
) -> Result<()> {
    let mut ticker = tokio::time::interval(producer.config().block_time);
    // Blocks are produced on a schedule; falling behind should not cause a
    // burst of catch-up blocks with near-identical timestamps.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut stalled = 0u32;

    // Built once and pinned, not once per iteration. `select!` drops the
    // futures of the branches that did not win, so constructing `ctrl_c()`
    // inside the loop meant no listener was registered while a block was being
    // produced — and producing one takes about half of every second. A Ctrl-C
    // arriving in that window was simply dropped on Unix; on Windows it was
    // worse, because with no listener the default handler ends the process, so
    // the container was left running with nothing driving it. Pinned, the
    // registration outlives the block and the signal is waiting at the next
    // pass through the loop.
    let shutdown = tokio::signal::ctrl_c();
    tokio::pin!(shutdown);

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                let mut head = head.lock().await;
                match producer.produce_block(&head).await {
                    Ok(block) => {
                        if stalled > 0 {
                            println!(
                                "  resumed at block {} after {stalled} missed",
                                block.head.number
                            );
                            stalled = 0;
                        }
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
                        // Say it once rather than every second, so a node that
                        // is down for a while does not bury the terminal.
                        if stalled == 0 {
                            eprintln!("  block production stalled: {error}");
                        }
                        stalled += 1;

                        // A node that restarted has its own idea of the head,
                        // and the one held here is stale — every further build
                        // request would be refused. Re-read it so production
                        // resumes by itself once the node is back.
                        if let Ok(current) = producer.current_head().await {
                            *head = current;
                        }
                    }
                }
            }
            _ = &mut shutdown => return Ok(()),
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

async fn observe(root: &Path, down: bool) -> Result<()> {
    if down {
        println!("cupel: stopping the monitoring stack");
        compose_file(root, "compose/observe.yml", &["down"]).await?;
        return Ok(());
    }

    println!("cupel: starting prometheus and grafana");
    compose_file(root, "compose/observe.yml", &["up", "-d"]).await?;
    attach_prometheus().await;
    println!();
    println!("  Grafana      http://127.0.0.1:3000");
    println!("  Prometheus   http://127.0.0.1:9090");
    println!("  Metrics      {GATEWAY_URL}/metrics");
    println!("  Signer       {SIGNER_URL}  (policy at /policy, decisions at /audit)");
    println!();
    println!("  Dashboards   gateway, execution, network — provisioned, no login needed.");
    println!();
    Ok(())
}

/// Put Prometheus on whichever Cupel networks exist, so it can scrape the
/// clients by container name.
///
/// Their metrics ports are published on `127.0.0.1` for a person to curl, and a
/// container reaching `host.docker.internal` arrives on the bridge address
/// instead — where nothing is listening. Docker Desktop's port proxy papers
/// over that; on plain Linux Docker every scrape was refused and every panel
/// drew an empty box, which on a lab chain is indistinguishable from a quiet
/// one.
///
/// Compose cannot express this: an external network it cannot find is an error,
/// and which of the two exists depends on which mode is running. Failures are
/// ignored on purpose — already attached is the common case, and the mode that
/// is not running has no network to join.
async fn attach_prometheus() {
    for network in ["cupel_default", "cupel-network"] {
        Command::new("docker")
            .args(["network", "connect", network, "cupel-prometheus"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .ok();
    }
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
        rpc_url: NODE_RPC_URL.to_string(),
        jwt_secret: secret,
        ..Config::default()
    });

    match producer.current_head().await {
        Ok(head) => {
            println!("cupel: running");
            println!("  rpc      {GATEWAY_URL}");
            println!("  head     {} ({})", head.number, short(&head.hash));
            println!("  time     {}", head.timestamp);
        }
        Err(error) => {
            // Exit non-zero as well as saying so. `cupel status` reported a
            // chain that was not there and still exited 0, which makes it
            // useless in the one place a status command earns its keep.
            println!("cupel: not reachable at {NODE_RPC_URL}");
            println!("  {error}");
            bail!("the chain is not answering on {NODE_RPC_URL}");
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
        Some(error) => Err(error).context(format!("the chain never answered on {NODE_RPC_URL}")),
        None => bail!("the chain never answered on {NODE_RPC_URL}"),
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
    compose_file(root, "compose/lab.yml", args).await
}

async fn compose_file(root: &Path, file: &str, args: &[&str]) -> Result<()> {
    let status = Command::new("docker")
        .arg("compose")
        .arg("-f")
        .arg(root.join(file))
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

/// How to write a listening address in a URL somebody can click.
///
/// A socket bound to 0.0.0.0 is reachable at localhost, and printing that is
/// friendlier than printing a wildcard — but an IPv6 address has to be
/// bracketed or the port reads as part of the address.
pub(crate) fn url_for(ip: IpAddr, port: u16) -> String {
    let host = if ip.is_unspecified() {
        if ip.is_ipv6() { "[::1]" } else { "127.0.0.1" }.to_string()
    } else if ip.is_ipv6() {
        format!("[{ip}]")
    } else {
        ip.to_string()
    };
    format!("http://{host}:{port}")
}

fn banner(head: &Head, block_time: u64, gateway_url: &str, control_url: &str) {
    println!();
    println!("  Cupel v{}", env!("CARGO_PKG_VERSION"));
    println!("  ---------------------------------------------------");
    println!("  RPC          {gateway_url}");
    println!("  Control room {control_url}");
    println!("  Node         {NODE_RPC_URL} (behind the gateway)");
    println!("  Metrics      {gateway_url}/metrics");
    println!("  Signer       {SIGNER_URL}  (policy at /policy, decisions at /audit)");
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
    println!("  Contracts");
    for contract in contracts::CONTRACTS {
        println!("  {:<6} {}", contract.name, contract.address);
    }
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

    #[tokio::test]
    async fn a_taken_port_is_reported_rather_than_announced() {
        // The bug this replaces: `serve` bound inside a spawned task, so a port
        // already held returned an error to a JoinHandle nobody read, and the
        // banner went on to promise an RPC at an address this process did not
        // have. Worse, the address answered — because the process holding it was
        // another cupel, serving a different chain.
        let held = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a free port");
        let address = held.local_addr().expect("bound").to_string();

        let error = bind(&address, "gateway")
            .await
            .expect_err("the port is held");
        let message = format!("{error:#}");
        assert!(
            message.contains("already listening"),
            "the message should say what is wrong: {message}"
        );
        assert!(
            message.contains(&address),
            "and which port it is about: {message}"
        );
    }

    #[test]
    fn a_hostname_is_not_an_address_and_clap_refuses_it_first() {
        // `--bind localhost` used to reach SocketAddr::parse inside bind(),
        // which expected a constant and panicked — after the container was up
        // and had to be cleaned away by hand. Clap rejects it before any of
        // that now, with a usage message instead of a backtrace.
        assert!(Cli::try_parse_from(["cupel", "up", "--bind", "localhost"]).is_err());
        assert!(Cli::try_parse_from(["cupel", "up", "--bind", "127.0.0.1"]).is_ok());
        assert!(Cli::try_parse_from(["cupel", "up", "--bind", "0.0.0.0"]).is_ok());
        assert!(Cli::try_parse_from(["cupel", "up", "--bind", "::1"]).is_ok());
        // And network mode takes it too, which is what lets Prometheus on
        // plain Linux Docker reach that gateway at all.
        assert!(Cli::try_parse_from(["cupel", "network", "up", "--bind", "0.0.0.0"]).is_ok());
    }

    #[test]
    fn a_zero_block_time_is_refused_before_anything_starts() {
        // tokio::time::interval panics on a zero period. It did so after the
        // chain was up and the banner printed, which reads as a crash rather
        // than as the typo it is.
        assert!(Cli::try_parse_from(["cupel", "up", "--block-time", "0"]).is_err());
        assert!(Cli::try_parse_from(["cupel", "up", "--block-time", "1"]).is_ok());
    }

    #[test]
    fn an_address_is_printed_the_way_a_browser_needs_it() {
        assert_eq!(
            url_for("127.0.0.1".parse().unwrap(), 8545),
            "http://127.0.0.1:8545"
        );
        // Bound everywhere: localhost reaches it, and printing that is
        // friendlier than printing a wildcard nobody can paste.
        assert_eq!(
            url_for("0.0.0.0".parse().unwrap(), 8545),
            "http://127.0.0.1:8545"
        );
        assert_eq!(url_for("::".parse().unwrap(), 8544), "http://[::1]:8544");
        // A specific address is printed as itself, and IPv6 is bracketed or
        // the port reads as part of the address.
        assert_eq!(
            url_for("192.168.1.4".parse().unwrap(), 8544),
            "http://192.168.1.4:8544"
        );
        assert_eq!(url_for("::1".parse().unwrap(), 8544), "http://[::1]:8544");
    }

    #[tokio::test]
    async fn a_free_port_binds() {
        let listener = bind("127.0.0.1:0", "gateway")
            .await
            .expect("a free port binds");
        assert_ne!(listener.local_addr().expect("bound").port(), 0);
    }

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
