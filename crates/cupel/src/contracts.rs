//! The contract library, and how it reaches the chain.
//!
//! Cupel's reference contracts are not deployed by a transaction. Their runtime
//! bytecode is written straight into the genesis file, so they exist at block
//! zero at addresses chosen in advance. Nothing has to run first, nothing can
//! fail halfway, the addresses never move, and `cupel up` stays one step with
//! no Foundry needed at runtime.
//!
//! The cost of that choice is that constructors never execute, so every
//! contract in the library is written to need no constructor state — supply
//! starts at zero and anyone may mint, and the vault's asset address is a
//! constant rather than an argument.

use std::path::Path;

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};

/// A contract that ships in the genesis state.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Deployed {
    /// Name, as it appears in the source and the build artifact.
    pub(crate) name: &'static str,
    /// The address it lives at on every Cupel chain.
    ///
    /// Chosen so the trailing digits name the standard: `c0dE0020` is the
    /// ERC-20, `c0dE4626` the vault. They are recognisable in a trace, and
    /// documentation can hard-code them.
    pub(crate) address: &'static str,
    /// Path of the build artifact under `contracts/out`.
    pub(crate) artifact: &'static str,
    /// One line on what it is for.
    pub(crate) blurb: &'static str,
}

/// Everything the library ships.
pub(crate) const CONTRACTS: &[Deployed] = &[
    Deployed {
        name: "Token",
        address: "0x00000000000000000000000000000000c0de0020",
        artifact: "Token.sol/Token.json",
        blurb: "ERC-20 with EIP-2612 permits. Anyone may mint.",
    },
    Deployed {
        name: "Vault",
        address: "0x00000000000000000000000000000000c0de4626",
        artifact: "Vault.sol/Vault.json",
        blurb: "ERC-4626 vault over Token, rounding on display.",
    },
    Deployed {
        name: "Weth",
        address: "0x00000000000000000000000000000000c0de0009",
        artifact: "Weth.sol/Weth.json",
        blurb: "Wrapped ether. Send it ether, get an ERC-20 balance.",
    },
];

/// Print the library as a table.
pub(crate) fn print_table() {
    println!();
    println!("  Contracts, deployed in genesis");
    println!("  ---------------------------------------------------");
    for contract in CONTRACTS {
        println!("  {:<6} {}", contract.name, contract.address);
        println!("         {}", contract.blurb);
    }
    println!();
    println!(
        "  cast call {} 'totalSupply()(uint256)'",
        CONTRACTS[0].address
    );
    println!();
}

/// Rewrite `config/genesis/genesis.json` from the compiled artifacts.
///
/// Run after changing a contract. The result is committed, so a clone needs no
/// Solidity toolchain to bring a chain up — only to change one.
pub(crate) fn regenerate_genesis(root: &Path) -> Result<usize> {
    let genesis_path = root.join("config/genesis/genesis.json");
    let raw = std::fs::read_to_string(&genesis_path)
        .with_context(|| format!("could not read {}", genesis_path.display()))?;
    let mut genesis: Value =
        serde_json::from_str(&raw).context("genesis.json is not valid JSON")?;

    let alloc = genesis
        .get_mut("alloc")
        .and_then(Value::as_object_mut)
        .context("genesis.json has no alloc object")?;

    // Drop any contract this tool placed previously, so removing one from the
    // library removes it from genesis too rather than leaving it stranded.
    let managed: Vec<String> = alloc
        .iter()
        .filter(|(_, account)| account.get("code").is_some())
        .map(|(address, _)| address.clone())
        .collect();
    for address in managed {
        alloc.remove(&address);
    }

    let mut written = 0;
    for contract in CONTRACTS {
        let code = deployed_bytecode(root, contract)?;
        alloc.insert(
            contract.address.to_string(),
            json!({ "balance": "0x0", "code": code }),
        );
        written += 1;
    }

    sort_alloc(alloc);
    let mut serialised = serde_json::to_string_pretty(&genesis)?;
    serialised.push('\n');
    std::fs::write(&genesis_path, serialised)
        .with_context(|| format!("could not write {}", genesis_path.display()))?;
    Ok(written)
}

/// Read a contract's runtime bytecode out of its Foundry artifact.
///
/// The *deployed* bytecode, not the creation bytecode: genesis holds what a
/// constructor would have returned, not the code that would have run to produce
/// it.
fn deployed_bytecode(root: &Path, contract: &Deployed) -> Result<String> {
    let path = root.join("contracts/out").join(contract.artifact);
    let raw = std::fs::read_to_string(&path).with_context(|| {
        format!(
            "could not read {} — run `forge build` in contracts/ first",
            path.display()
        )
    })?;
    let artifact: Value = serde_json::from_str(&raw)
        .with_context(|| format!("{} is not valid JSON", path.display()))?;

    let code = artifact
        .pointer("/deployedBytecode/object")
        .and_then(Value::as_str)
        .with_context(|| format!("{} has no deployedBytecode", path.display()))?;

    // A contract whose bytecode still contains a link reference or an immutable
    // placeholder cannot be placed in genesis: the value would never be filled
    // in, because no constructor runs.
    if code.contains("__$") {
        anyhow::bail!(
            "{} has an unresolved link reference and cannot be placed in genesis",
            contract.name
        );
    }
    if code.len() <= 2 {
        anyhow::bail!("{} compiled to empty bytecode", contract.name);
    }
    Ok(code.to_string())
}

/// Keep the allocation in a stable order so regenerating produces no diff when
/// nothing changed.
fn sort_alloc(alloc: &mut Map<String, Value>) {
    let mut entries: Vec<(String, Value)> =
        alloc.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    entries.sort_by_key(|entry| entry.0.to_lowercase());
    alloc.clear();
    for (address, account) in entries {
        alloc.insert(address, account);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_well_formed_and_distinct() {
        let mut seen = Vec::new();
        for contract in CONTRACTS {
            assert_eq!(contract.address.len(), 42, "{}", contract.name);
            assert!(contract.address.starts_with("0x"), "{}", contract.name);
            assert_eq!(
                contract.address,
                contract.address.to_lowercase(),
                "{} must be lowercase so genesis keys are consistent",
                contract.name
            );
            assert!(
                !seen.contains(&contract.address),
                "{} reuses an address",
                contract.name
            );
            seen.push(contract.address);
        }
    }

    #[test]
    fn the_vault_points_at_the_token() {
        // Vault.sol hard-codes its asset, so the two must agree or the vault is
        // pointed at an empty address the moment either one moves.
        let token = CONTRACTS
            .iter()
            .find(|c| c.name == "Token")
            .expect("Token is in the library");
        assert_eq!(token.address, "0x00000000000000000000000000000000c0de0020");
    }

    #[test]
    fn the_page_knows_the_same_addresses() {
        // The control room names these addresses without asking the chain,
        // because nothing can move a contract placed in genesis and the four
        // accounts are the ones every development tool already knows. Two
        // files in two languages that must agree; a change here the page did
        // not follow would show a stranger's balance under a familiar name.
        let page = include_str!("../../../ui/src/lib/known.ts");
        for contract in CONTRACTS {
            assert!(
                page.contains(contract.address),
                "ui/src/lib/known.ts does not know {} at {}",
                contract.name,
                contract.address
            );
        }
        for (address, _) in crate::DEV_ACCOUNTS {
            assert!(
                page.contains(address),
                "ui/src/lib/known.ts does not know the account {address}"
            );
        }
    }

    #[test]
    fn sorting_is_stable() {
        let mut alloc = Map::new();
        alloc.insert("0xff".into(), json!({}));
        alloc.insert("0x01".into(), json!({}));
        alloc.insert("0xAb".into(), json!({}));
        sort_alloc(&mut alloc);
        let order: Vec<&String> = alloc.keys().collect();
        assert_eq!(order, vec!["0x01", "0xAb", "0xff"]);
    }
}
