//! The files a chain is made of, carried in the binary.
//!
//! Cupel reads its compose files and its configuration from a checkout, found
//! by walking up from the working directory. That is right for anyone working
//! on the project and useless for anyone who downloaded a release: the archive
//! holds a binary, and the binary went looking for `compose/lab.yml` in a
//! directory that was never going to have one. Every command except
//! `--version` answered "could not find a Cupel checkout", and there was
//! nothing in the download to point it at. The release's own smoke test could
//! not catch it, because it runs inside a checkout.
//!
//! So the binary carries them. With no checkout in sight they are written once
//! into a directory of their own and the lab runs from there — the same trade
//! the control room makes with `ui/dist` and the contracts make with their
//! bytecode: what you downloaded is the whole thing.
//!
//! Two things are deliberately not carried. The Foundry artifacts, because the
//! one command that reads them rebuilds what is already committed and belongs
//! to a checkout. And the Engine API secret, which is generated per chain: one
//! compiled into a published binary would be the same secret on every machine
//! that downloaded it.

use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rust_embed::{Embed, RustEmbed};

/// The lab, the devnet, and the monitoring stack.
#[derive(Embed)]
#[folder = "../../compose"]
struct Compose;

/// The lab's genesis, with the contracts already in it.
///
/// `jwt.hex` sits beside it in a checkout and is excluded on purpose; see the
/// module's last paragraph.
#[derive(Embed)]
#[folder = "../../config/genesis"]
#[include = "genesis.json"]
struct Genesis;

/// What `cupel observe` mounts into Prometheus.
#[derive(Embed)]
#[folder = "../../config/prometheus"]
struct Prometheus;

/// And into Grafana: the provisioning it reads at start-up, and the dashboards
/// that provisioning points at.
#[derive(Embed)]
#[folder = "../../config/grafana"]
struct Grafana;

/// Which version wrote the files, so a later one knows to replace them.
const STAMP: &str = ".cupel-version";

/// What laying out a home did, which decides what to say about it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Laid {
    /// This version's files were already there.
    Kept,
    /// Nothing was there before.
    First,
    /// Another version's files were replaced.
    Refreshed,
}

/// Every carried file, under the path it takes in a root.
fn carried() -> Vec<(PathBuf, Cow<'static, [u8]>)> {
    let mut files = Vec::new();
    take::<Compose>("compose", &mut files);
    take::<Genesis>("config/genesis", &mut files);
    take::<Prometheus>("config/prometheus", &mut files);
    take::<Grafana>("config/grafana", &mut files);
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

fn take<E: RustEmbed>(under: &str, files: &mut Vec<(PathBuf, Cow<'static, [u8]>)>) {
    for name in E::iter() {
        let file = E::get(&name).expect("rust-embed listed this file a moment ago");
        files.push((Path::new(under).join(name.as_ref()), file.data));
    }
}

/// Where the lab lives when there is no checkout to live in.
///
/// `CUPEL_HOME` first, then the place the platform keeps application data. Not
/// the working directory: a chain is not a thing to scatter through whichever
/// folder somebody happened to be in.
pub(crate) fn home() -> Result<PathBuf> {
    if let Some(named) = std::env::var_os("CUPEL_HOME") {
        return Ok(PathBuf::from(named));
    }
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
            })
    };
    let base = base.context(
        "no home directory to put the lab in — name one with CUPEL_HOME, or run \
         this from a Cupel checkout",
    )?;
    Ok(base.join("cupel"))
}

/// The home directory, ready to run a chain from, and said out loud.
pub(crate) fn prepare() -> Result<PathBuf> {
    let home = home()?;
    let version = env!("CARGO_PKG_VERSION");
    match lay_out_if_needed(&home, version)? {
        Laid::Kept => {}
        Laid::First => {
            println!(
                "cupel: no checkout here, so the lab runs from {}",
                home.display()
            );
            println!(
                "cupel: its compose files and configuration live there; --root points at a \
                 checkout instead"
            );
        }
        Laid::Refreshed => {
            println!(
                "cupel: refreshed the lab files in {} for v{version}",
                home.display()
            );
            println!(
                "cupel: a chain made by an older version keeps the genesis it was made with — \
                 `cupel reset` starts a fresh one"
            );
        }
    }
    Ok(home)
}

/// Write the carried files into `home` unless this version's are already there.
///
/// The stamp alone is not enough to decide. A file deleted by hand would
/// otherwise go unnoticed until Docker complained about a path, which is a
/// long way from the thing that is actually wrong.
pub(crate) fn lay_out_if_needed(home: &Path, version: &str) -> Result<Laid> {
    let stamp = home.join(STAMP);
    let written = fs::read_to_string(&stamp).unwrap_or_default();
    let complete = carried().iter().all(|(path, _)| home.join(path).is_file());
    if written.trim() == version && complete {
        return Ok(Laid::Kept);
    }

    for (path, bytes) in carried() {
        let target = home.join(&path);
        let parent = target
            .parent()
            .expect("a carried file always sits in a directory");
        fs::create_dir_all(parent)
            .with_context(|| format!("could not create {}", parent.display()))?;
        fs::write(&target, bytes.as_ref())
            .with_context(|| format!("could not write {}", target.display()))?;
    }
    fs::write(&stamp, version).with_context(|| format!("could not write {}", stamp.display()))?;

    Ok(if written.trim().is_empty() {
        Laid::First
    } else {
        Laid::Refreshed
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of this test's own, gone by the time it returns.
    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("cupel-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        path
    }

    fn paths() -> Vec<String> {
        carried()
            .iter()
            .map(|(path, _)| path.to_string_lossy().replace('\\', "/"))
            .collect()
    }

    #[test]
    fn everything_the_lab_reads_is_carried() {
        // This list is what the rest of the program opens under the root. A
        // file that stops being carried while the code still opens it is the
        // fault this module exists to fix, arriving a second time.
        let carried = paths();
        for wanted in [
            "compose/lab.yml",
            "compose/network.yml",
            "compose/observe.yml",
            "config/genesis/genesis.json",
            "config/prometheus/prometheus.yml",
            "config/grafana/provisioning/dashboards/cupel.yml",
            "config/grafana/provisioning/datasources/prometheus.yml",
        ] {
            assert!(
                carried.iter().any(|path| path == wanted),
                "{wanted} is not carried in the binary, but something opens it"
            );
        }
        assert!(
            carried
                .iter()
                .any(|path| path.starts_with("config/grafana/dashboards/")),
            "no dashboards carried, so `cupel observe` would provision empty panels"
        );
    }

    #[test]
    fn the_engine_api_secret_is_not_carried() {
        // It sits beside genesis.json in a checkout. Compiled in, it would be
        // the same secret on every machine that downloaded the release, and
        // anything that can reach the Engine API with it can make blocks.
        assert!(Genesis::get("jwt.hex").is_none());
        assert!(!paths().iter().any(|path| path.ends_with("jwt.hex")));
    }

    #[test]
    fn a_home_is_laid_out_once_and_kept() {
        let home = scratch("laid-out");
        assert_eq!(lay_out_if_needed(&home, "1.0.0").unwrap(), Laid::First);

        let genesis = home.join("config/genesis/genesis.json");
        assert!(genesis.is_file());
        assert!(home.join("compose/lab.yml").is_file());
        assert_eq!(fs::read_to_string(home.join(STAMP)).unwrap(), "1.0.0");

        // Same version, everything present: nothing is rewritten, so an edit
        // made in the home directory survives.
        fs::write(&genesis, "edited by hand").unwrap();
        assert_eq!(lay_out_if_needed(&home, "1.0.0").unwrap(), Laid::Kept);
        assert_eq!(fs::read_to_string(&genesis).unwrap(), "edited by hand");

        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_newer_binary_replaces_the_files_and_leaves_the_chain_alone() {
        let home = scratch("refreshed");
        lay_out_if_needed(&home, "1.0.0").unwrap();

        // What a running lab put there: keys, generated configuration, logs.
        let audit = home.join("data/audit.log");
        let jwt = home.join("config/genesis/jwt.hex");
        let devnet = home.join("config/network/network.env");
        for path in [&audit, &jwt, &devnet] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "generated").unwrap();
        }
        let compose = home.join("compose/lab.yml");
        fs::write(&compose, "stale").unwrap();

        assert_eq!(lay_out_if_needed(&home, "1.1.0").unwrap(), Laid::Refreshed);
        assert_ne!(fs::read_to_string(&compose).unwrap(), "stale");
        assert_eq!(fs::read_to_string(home.join(STAMP)).unwrap(), "1.1.0");
        for path in [&audit, &jwt, &devnet] {
            assert_eq!(
                fs::read_to_string(path).unwrap(),
                "generated",
                "{} was not the binary's to replace",
                path.display()
            );
        }

        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_file_deleted_by_hand_comes_back() {
        // The stamp would say this home is current. Docker would disagree,
        // several confusing lines later.
        let home = scratch("deleted");
        lay_out_if_needed(&home, "1.0.0").unwrap();
        fs::remove_file(home.join("compose/observe.yml")).unwrap();

        assert_eq!(lay_out_if_needed(&home, "1.0.0").unwrap(), Laid::Refreshed);
        assert!(home.join("compose/observe.yml").is_file());

        fs::remove_dir_all(&home).unwrap();
    }
}
