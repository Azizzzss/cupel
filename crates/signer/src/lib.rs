//! A signing service that holds keys behind a policy.
//!
//! Cupel's clients sign for themselves — `cast` and MetaMask hold their own
//! keys and never ask anything else. This service exists for the other case:
//! an *application* that needs to send transactions, and therefore needs a key
//! it cannot be trusted with.
//!
//! The faucet is the obvious example. It has to send ether to strangers on
//! request, which is exactly the shape of a service you do not want holding an
//! unrestricted key. A policy between the application and the key turns "this
//! process was compromised" into "this process was compromised and could still
//! only send one ether to two known addresses before the rate limit stopped
//! it".
//!
//! # Why not Clef
//!
//! Geth's Clef was the obvious thing to integrate here, and it no longer
//! exists: `cmd/clef` has been removed from go-ethereum and the binary is
//! absent from the `alltools` image, though the documentation page still
//! describes it as current. Rather than pin an ancient geth to run a deleted
//! tool, the policy engine lives here and the signing primitives come from
//! `alloy` — the same division the rest of Cupel follows: borrow the
//! cryptography, own the rules.

pub mod audit;
pub mod policy;

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use alloy::consensus::{SignableTransaction, TxEip1559, TxEnvelope};
use alloy::eips::eip2718::Encodable2718;
use alloy::primitives::{Address, Bytes, TxKind, U256};
use alloy::signers::SignerSync;
use alloy::signers::local::PrivateKeySigner;
use axum::Router;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};

pub use audit::AuditLog;
pub use policy::{Decision, Policy, PolicyEngine, Refusal, SigningRequest};

/// Anything that stops a signature being produced.
#[derive(Debug, thiserror::Error)]
pub enum SignerError {
    /// The policy said no.
    #[error("{0}")]
    Refused(#[from] Refusal),
    /// The key material was unusable.
    #[error("could not load key: {0}")]
    BadKey(String),
    /// Signing itself failed.
    #[error("signing failed: {0}")]
    Signing(String),
    /// The request was not shaped as expected.
    #[error("malformed request: {0}")]
    Malformed(String),
}

/// How the service is set up.
#[derive(Debug, Clone)]
pub struct Config {
    /// Chain the signed transactions are for.
    ///
    /// Part of what is signed, so a signature made here cannot be replayed on
    /// another chain.
    pub chain_id: u64,
    /// Where to append the audit log.
    pub audit_path: Option<PathBuf>,
    /// The rules keys are held under.
    pub policy: Policy,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            chain_id: 31337,
            audit_path: None,
            policy: Policy::default(),
        }
    }
}

/// Holds keys, applies a policy, and records every decision.
#[derive(Debug)]
pub struct Signer {
    keys: HashMap<Address, PrivateKeySigner>,
    engine: PolicyEngine,
    audit: AuditLog,
    chain_id: u64,
}

impl Signer {
    /// Build a signer holding the given private keys.
    pub fn new(config: Config, private_keys: &[String]) -> Result<Self, SignerError> {
        let mut keys = HashMap::new();
        for key in private_keys {
            let trimmed = key.trim();
            let parsed: PrivateKeySigner = trimmed
                .strip_prefix("0x")
                .unwrap_or(trimmed)
                .parse()
                .map_err(|error| SignerError::BadKey(format!("{error}")))?;
            keys.insert(parsed.address(), parsed);
        }

        let audit = match &config.audit_path {
            Some(path) => AuditLog::to_file(path)
                .map_err(|error| SignerError::BadKey(format!("audit log: {error}")))?,
            None => AuditLog::in_memory(),
        };

        Ok(Self {
            keys,
            engine: PolicyEngine::new(config.policy),
            audit,
            chain_id: config.chain_id,
        })
    }

    /// The addresses this service can sign for.
    pub fn accounts(&self) -> Vec<Address> {
        let mut accounts: Vec<Address> = self.keys.keys().copied().collect();
        // Sorted so `eth_accounts` is stable between calls.
        accounts.sort();
        accounts
    }

    /// The rules in force.
    pub fn policy(&self) -> &Policy {
        self.engine.policy()
    }

    /// The audit log.
    pub fn audit(&self) -> &AuditLog {
        &self.audit
    }

    /// Evaluate a request and, if the policy permits, sign it.
    ///
    /// Returns the raw EIP-2718 encoding, ready for `eth_sendRawTransaction`.
    pub fn sign(
        &self,
        request: &SigningRequest,
        nonce: u64,
        max_priority_fee_per_gas: u128,
    ) -> Result<Vec<u8>, SignerError> {
        // EIP-1559 forbids a tip above the fee cap and a node refuses one. Say
        // so here, before the policy spends any of the window on it.
        if max_priority_fee_per_gas > request.max_fee_per_gas {
            return Err(SignerError::Malformed(format!(
                "maxPriorityFeePerGas {max_priority_fee_per_gas} is above maxFeePerGas {}",
                request.max_fee_per_gas
            )));
        }
        let held: HashSet<Address> = self.keys.keys().copied().collect();

        if let Decision::Refused(refusal) = self.engine.evaluate(request, &held) {
            // Recorded before returning, so a refusal reaches the log even if
            // the caller drops the error on the floor.
            self.audit
                .record(request, &Decision::Refused(refusal.clone()), None);
            return Err(SignerError::Refused(refusal));
        }

        let key = self
            .keys
            .get(&request.from)
            .ok_or(SignerError::Refused(Refusal::UnknownSigner(request.from)))?;

        let transaction = TxEip1559 {
            chain_id: self.chain_id,
            nonce,
            gas_limit: request.gas_limit,
            max_fee_per_gas: request.max_fee_per_gas,
            max_priority_fee_per_gas,
            to: match request.to {
                Some(to) => TxKind::Call(to),
                None => TxKind::Create,
            },
            value: request.value,
            input: Bytes::from(request.data.clone()),
            access_list: Default::default(),
        };

        let signature = key
            .sign_hash_sync(&transaction.signature_hash())
            .map_err(|error| SignerError::Signing(format!("{error}")))?;
        let envelope = TxEnvelope::Eip1559(transaction.into_signed(signature));

        let mut raw = Vec::new();
        envelope.encode_2718(&mut raw);
        let hash = format!("0x{}", hex_encode(envelope.tx_hash().as_slice()));

        self.audit.record(request, &Decision::Approved, Some(&hash));
        Ok(raw)
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Serve the signer's API on `address`.
/// Bind `address` and serve until the task is dropped.
///
/// Prefer [`serve_on`] when the caller wants to know that the port was actually
/// obtained: spawned into a task, a failure here is a returned error nobody
/// reads, and the program goes on to announce an address it does not hold.
pub async fn serve(signer: Arc<Signer>, address: SocketAddr) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(address).await?;
    serve_on(signer, listener).await
}

/// Serve on a listener the caller has already bound.
pub async fn serve_on(
    signer: Arc<Signer>,
    listener: tokio::net::TcpListener,
) -> std::io::Result<()> {
    let app = Router::new()
        .route("/", post(rpc))
        .route("/policy", get(policy_endpoint))
        .route("/audit", get(audit_endpoint))
        .with_state(signer);

    axum::serve(listener, app).await
}

async fn rpc(State(signer): State<Arc<Signer>>, body: String) -> Response {
    let request: Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(_) => return json_response(error(Value::Null, -32700, "Parse error".into())),
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);

    let answer = match request.get("method").and_then(Value::as_str) {
        Some("eth_accounts") => {
            let accounts: Vec<String> = signer.accounts().iter().map(ToString::to_string).collect();
            json!({"jsonrpc": "2.0", "id": id, "result": accounts})
        }
        Some("eth_signTransaction") => match sign_from_params(&signer, request.get("params")) {
            Ok(raw) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": format!("0x{}", hex_encode(&raw)),
            }),
            // A policy refusal is a deliberate answer, not a server fault, so
            // it carries its own code and the reason in the message.
            Err(SignerError::Refused(refusal)) => {
                error(id, -32020, format!("refused by policy: {refusal}"))
            }
            Err(other) => error(id, -32602, other.to_string()),
        },
        Some(other) => error(id, -32601, format!("Method not found: {other}")),
        None => error(id, -32600, "Request has no method".into()),
    };
    json_response(answer)
}

fn sign_from_params(signer: &Signer, params: Option<&Value>) -> Result<Vec<u8>, SignerError> {
    let call = params
        .and_then(|params| params.get(0))
        .ok_or_else(|| SignerError::Malformed("no transaction supplied".into()))?;

    let address = |field: &str| -> Result<Option<Address>, SignerError> {
        match call.get(field).and_then(Value::as_str) {
            Some(text) => text
                .parse()
                .map(Some)
                .map_err(|_| SignerError::Malformed(format!("{field} is not an address"))),
            None => Ok(None),
        }
    };
    // A JSON-RPC quantity is a 0x-prefixed hex string. Anything else in one of
    // these fields is refused rather than guessed at. The previous version
    // trimmed an optional "0x" and parsed hex either way, so a decimal "21000"
    // became 135168; it turned anything it could not parse into a default; and
    // it cut u128 down to u64 with `as`. Each of those signed a transaction
    // other than the one that was asked for, and said nothing.
    let digits = |field: &str| -> Result<Option<&str>, SignerError> {
        match call.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => text.strip_prefix("0x").map(Some).ok_or_else(|| {
                SignerError::Malformed(format!(
                    "{field} must be a 0x-prefixed hex quantity, got {text:?}"
                ))
            }),
            Some(other) => Err(SignerError::Malformed(format!(
                "{field} must be a 0x-prefixed hex string, got {other}"
            ))),
        }
    };
    let quantity = |field: &str| -> Result<Option<u128>, SignerError> {
        digits(field)?
            .map(|hex| {
                u128::from_str_radix(hex, 16).map_err(|_| {
                    SignerError::Malformed(format!("{field} is not a hex quantity that fits"))
                })
            })
            .transpose()
    };
    let small = |field: &str| -> Result<Option<u64>, SignerError> {
        quantity(field)?
            .map(|n| {
                u64::try_from(n)
                    .map_err(|_| SignerError::Malformed(format!("{field} does not fit in 64 bits")))
            })
            .transpose()
    };

    let from = address("from")?.ok_or_else(|| SignerError::Malformed("no from address".into()))?;
    let value = digits("value")?
        .map(|hex| {
            U256::from_str_radix(hex, 16)
                .map_err(|_| SignerError::Malformed("value is not a hex quantity".into()))
        })
        .transpose()?
        .unwrap_or(U256::ZERO);
    let data = call
        .get("data")
        .or_else(|| call.get("input"))
        .and_then(Value::as_str)
        .map(decode_hex)
        .transpose()?
        .unwrap_or_default();

    // Nonce and gas are required, as geth's own eth_signTransaction requires
    // them. The defaults they replace were each wrong in a way that looked
    // right: a nonce of 0 is the first transaction an account ever sends and
    // is refused by the node for every one after, and a gas limit of 21000 is a
    // plain transfer, so any contract call signed with it runs out of gas.
    // This service does not read the chain, so the caller supplies both.
    let nonce = small("nonce")?.ok_or_else(|| {
        SignerError::Malformed("nonce not specified — this signer does not read the chain".into())
    })?;
    let gas_limit = small("gas")?.ok_or_else(|| {
        SignerError::Malformed("gas not specified — 21000 is a transfer, not a call".into())
    })?;

    let request = SigningRequest {
        from,
        to: address("to")?,
        value,
        gas_limit,
        // Fees keep lab-sized defaults when omitted: an absent fee is not a
        // mistake the way an absent nonce is, and both count against the budget.
        max_fee_per_gas: quantity("maxFeePerGas")?.unwrap_or(2_000_000_000),
        data,
    };

    signer.sign(
        &request,
        nonce,
        quantity("maxPriorityFeePerGas")?.unwrap_or(1_000_000),
    )
}

fn decode_hex(text: &str) -> Result<Vec<u8>, SignerError> {
    let body = text.trim_start_matches("0x");
    if !body.len().is_multiple_of(2) {
        return Err(SignerError::Malformed("odd-length hex data".into()));
    }
    (0..body.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&body[index..index + 2], 16)
                .map_err(|_| SignerError::Malformed("invalid hex data".into()))
        })
        .collect()
}

/// Sort a set of addresses into a stable list, so the endpoint reads the same
/// way twice running.
fn sorted(addresses: impl IntoIterator<Item = Address>) -> Vec<String> {
    let mut list: Vec<String> = addresses.into_iter().map(|a| a.to_string()).collect();
    list.sort();
    list
}

async fn policy_endpoint(State(signer): State<Arc<Signer>>) -> Response {
    let policy = signer.policy();
    let allowed = policy
        .allowed_recipients
        .as_ref()
        .map(|set| sorted(set.iter().copied()));
    let denied = sorted(policy.denied_recipients.iter().copied());
    let accounts = sorted(signer.accounts());

    json_response(json!({
        "max_value_wei": policy.max_value.to_string(),
        "max_gas": policy.max_gas,
        "allow_contract_creation": policy.allow_contract_creation,
        "max_per_window": policy.max_per_window,
        "max_value_per_window_wei": policy.max_value_per_window.to_string(),
        "window_seconds": policy.window.as_secs(),
        "allowed_recipients": allowed,
        "denied_recipients": denied,
        "accounts": accounts,
    }))
}

async fn audit_endpoint(State(signer): State<Arc<Signer>>) -> Response {
    json_response(json!(signer.audit().recent(50)))
}

fn error(id: Value, code: i32, message: String) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn json_response(body: Value) -> Response {
    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        )],
        body.to_string(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The third development account, used as the service's own key so it is
    /// obvious which transactions came from the signer.
    const TREASURY: &str = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

    fn ether(n: u64) -> U256 {
        U256::from(n) * U256::from(10u64).pow(U256::from(18u64))
    }

    fn signer_with(policy: Policy) -> Signer {
        Signer::new(
            Config {
                policy,
                ..Config::default()
            },
            &[TREASURY.to_string()],
        )
        .expect("the development key is valid")
    }

    fn request(from: Address, value: U256) -> SigningRequest {
        SigningRequest {
            from,
            to: Some(Address::from([2u8; 20])),
            value,
            gas_limit: 21_000,
            max_fee_per_gas: 2_000_000_000,
            data: Vec::new(),
        }
    }

    fn call(fields: Value) -> Value {
        json!([fields])
    }

    #[test]
    fn a_request_without_a_nonce_or_gas_is_refused_not_defaulted() {
        let signer = signer_with(Policy::default());
        let from = signer.accounts()[0].to_string();
        let to = Address::from([2u8; 20]).to_string();

        let no_nonce = call(json!({"from": from, "to": to, "gas": "0x5208"}));
        let said = sign_from_params(&signer, Some(&no_nonce))
            .unwrap_err()
            .to_string();
        assert!(said.contains("nonce"), "{said}");

        let no_gas = call(json!({"from": from, "to": to, "nonce": "0x0"}));
        let said = sign_from_params(&signer, Some(&no_gas))
            .unwrap_err()
            .to_string();
        assert!(said.contains("gas"), "{said}");

        let complete = call(json!({"from": from, "to": to, "nonce": "0x0", "gas": "0x5208"}));
        assert!(sign_from_params(&signer, Some(&complete)).is_ok());
    }

    #[test]
    fn a_quantity_is_hex_with_a_prefix_or_it_is_refused() {
        let signer = signer_with(Policy::default());
        let from = signer.accounts()[0].to_string();
        let to = Address::from([2u8; 20]).to_string();
        let with = |field: &str, value: Value| {
            let mut fields = json!({"from": from, "to": to, "nonce": "0x0", "gas": "0x5208"});
            fields[field] = value;
            sign_from_params(&signer, Some(&call(fields)))
        };

        // A decimal was read as hex: "21000" became 135168.
        assert!(with("gas", json!("21000")).is_err());
        // A number rather than a string used to fall back to the default.
        assert!(with("gas", json!(21000)).is_err());
        // Unparseable used to fall back to the default too.
        assert!(with("maxFeePerGas", json!("0xnothex")).is_err());
        assert!(with("value", json!("0xnothex")).is_err());
        // Too big for the field used to be truncated with `as`.
        assert!(with("nonce", json!("0x10000000000000000")).is_err());
        // A tip above the fee cap is refused, as a node would refuse it.
        let mut fees = json!({"from": from, "to": to, "nonce": "0x0", "gas": "0x5208"});
        fees["maxFeePerGas"] = json!("0x1");
        fees["maxPriorityFeePerGas"] = json!("0x2");
        assert!(sign_from_params(&signer, Some(&call(fees))).is_err());
    }

    #[test]
    fn the_key_loads_and_reports_its_address() {
        let signer = signer_with(Policy::default());
        let accounts = signer.accounts();
        assert_eq!(accounts.len(), 1);
        // The published address for this development key.
        assert_eq!(
            accounts[0].to_string().to_lowercase(),
            "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"
        );
    }

    #[test]
    fn a_permitted_transaction_is_signed() {
        let signer = signer_with(Policy::default());
        let from = signer.accounts()[0];

        let raw = signer
            .sign(&request(from, ether(1)), 0, 1_000_000)
            .expect("within policy");

        // An EIP-1559 envelope, so the first byte is its type.
        assert_eq!(raw[0], 0x02, "a typed transaction");
        assert!(raw.len() > 32);
    }

    #[test]
    fn a_refused_transaction_produces_no_signature_at_all() {
        let signer = signer_with(Policy::default());
        let from = signer.accounts()[0];

        let error = signer
            .sign(&request(from, ether(100)), 0, 1_000_000)
            .expect_err("over the ceiling");

        assert!(matches!(
            error,
            SignerError::Refused(Refusal::ValueTooHigh { .. })
        ));
    }

    #[test]
    fn a_refusal_is_recorded_even_though_nothing_was_signed() {
        // The caller may discard the error; the log must still have it.
        let signer = signer_with(Policy::default());
        let from = signer.accounts()[0];

        let _ = signer.sign(&request(from, ether(100)), 0, 1_000_000);

        let entries = signer.audit().recent(10);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["decision"], "refused");
        assert_eq!(entries[0]["hash"], Value::Null);
        assert!(
            entries[0]["reason"]
                .as_str()
                .unwrap()
                .contains("exceeds the ceiling")
        );
    }

    #[test]
    fn an_approval_is_recorded_with_the_hash_it_produced() {
        let signer = signer_with(Policy::default());
        let from = signer.accounts()[0];

        signer
            .sign(&request(from, ether(1)), 0, 1_000_000)
            .expect("within policy");

        let entry = signer.audit().recent(1).remove(0);
        assert_eq!(entry["decision"], "approved");
        let hash = entry["hash"].as_str().expect("a hash was recorded");
        assert_eq!(hash.len(), 66, "a 32-byte hash");
    }

    #[test]
    fn a_key_the_service_does_not_hold_is_refused() {
        let signer = signer_with(Policy::default());
        let stranger = Address::from([9u8; 20]);

        let error = signer
            .sign(&request(stranger, ether(1)), 0, 1_000_000)
            .expect_err("not our key");
        assert!(matches!(
            error,
            SignerError::Refused(Refusal::UnknownSigner(_))
        ));
    }

    #[test]
    fn the_rate_limit_applies_to_signing_not_only_to_evaluation() {
        let signer = signer_with(Policy {
            max_per_window: 2,
            max_value_per_window: ether(100),
            ..Policy::default()
        });
        let from = signer.accounts()[0];

        for nonce in 0..2 {
            assert!(
                signer
                    .sign(&request(from, ether(1)), nonce, 1_000_000)
                    .is_ok(),
                "signature {nonce}"
            );
        }
        assert!(matches!(
            signer.sign(&request(from, ether(1)), 2, 1_000_000),
            Err(SignerError::Refused(Refusal::RateLimited { .. }))
        ));
    }

    #[test]
    fn a_different_nonce_produces_a_different_signature() {
        // Otherwise the same signed blob could be replayed.
        let signer = signer_with(Policy {
            max_per_window: 10,
            ..Policy::default()
        });
        let from = signer.accounts()[0];

        let first = signer.sign(&request(from, ether(1)), 0, 1_000_000).unwrap();
        let second = signer.sign(&request(from, ether(1)), 1, 1_000_000).unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn a_malformed_key_is_rejected_at_startup() {
        // Better to fail to start than to run holding nothing useful.
        let result = Signer::new(Config::default(), &["not-a-key".to_string()]);
        assert!(matches!(result, Err(SignerError::BadKey(_))));
    }

    #[test]
    fn keys_load_with_or_without_the_prefix() {
        let bare = TREASURY.trim_start_matches("0x").to_string();
        let signer = Signer::new(Config::default(), &[bare]).expect("bare key loads");
        assert_eq!(signer.accounts().len(), 1);
    }

    #[test]
    fn hex_decoding_refuses_malformed_input() {
        assert!(decode_hex("0xabc").is_err(), "odd length");
        assert!(decode_hex("0xzz").is_err(), "not hex");
        assert_eq!(
            decode_hex("0xdeadbeef").unwrap(),
            vec![0xde, 0xad, 0xbe, 0xef]
        );
        assert_eq!(decode_hex("").unwrap(), Vec::<u8>::new());
    }
}
