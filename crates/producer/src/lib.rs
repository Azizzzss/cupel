//! An Engine API block producer.
//!
//! Since the merge, an execution client cannot make a block on its own. It will
//! accept transactions, gossip them, and answer queries — and then sit at the
//! same block forever, because deciding *when* a block happens and *what* goes
//! on top of what is the consensus layer's job. On real Ethereum that job is
//! done by a beacon client running a fork-choice rule over attestations from
//! hundreds of thousands of validators.
//!
//! A single-node lab needs none of that machinery, but it still needs something
//! on the other end of the Engine API. That is this crate: the smallest honest
//! thing that will make geth produce blocks.
//!
//! # What it is not
//!
//! This is a **block producer**, not a consensus client. There are no
//! attestations, no fork choice, and no finality — every block it makes is
//! declared final immediately, because with one producer there is nothing to
//! disagree with. Anything that depends on reorgs or on real finality
//! semantics needs the multi-client network, not this.
//!
//! # The cycle
//!
//! Producing one block is four calls:
//!
//! 1. `engine_forkchoiceUpdatedV3` with payload attributes — "build on this
//!    head, with this timestamp"; returns a payload id.
//! 2. `engine_getPayloadV3` — collect the block the client just built.
//! 3. `engine_newPayloadV3` — hand it back for validation.
//! 4. `engine_forkchoiceUpdatedV3` without attributes — make it canonical.
//!
//! The Engine API is authenticated with a shared secret rather than left open,
//! because anything that can reach it can dictate what the chain contains.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use jsonwebtoken::{Algorithm, EncodingKey, Header as JwtHeader};
use rand::Rng;
use serde::Serialize;
use serde_json::{Value, json};

/// The all-zero 32-byte value, used where Cancun requires a beacon block root
/// that a lab chain has no beacon chain to supply.
const ZERO_HASH: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";

/// Anything that can go wrong driving the Engine API.
#[derive(Debug, thiserror::Error)]
pub enum ProducerError {
    /// The HTTP request itself failed.
    #[error("engine api transport: {0}")]
    Transport(#[from] reqwest::Error),
    /// The node returned a JSON-RPC error object.
    #[error("engine api rejected {method}: {message}")]
    Rpc {
        /// The method that was called.
        method: String,
        /// What the node said about it.
        message: String,
    },
    /// The response was shaped differently than expected.
    #[error("unexpected response to {method}: {detail}")]
    Malformed {
        /// The method that was called.
        method: String,
        /// What was missing or wrong.
        detail: String,
    },
    /// The node accepted the request but refused the payload.
    #[error("payload {status}{}", .reason.as_deref().map(|r| format!(": {r}")).unwrap_or_default())]
    PayloadRejected {
        /// The status the node reported, such as `INVALID` or `SYNCING`.
        status: String,
        /// The validation error, when the node supplied one.
        reason: Option<String>,
    },
    /// The JWT could not be signed.
    #[error("could not sign the engine api token: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),
    /// The clock is behind the Unix epoch.
    #[error("system clock is before the unix epoch")]
    Clock,
}

/// Where the chain currently is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    /// Hash of the head block.
    pub hash: String,
    /// Height of the head block.
    pub number: u64,
    /// Timestamp of the head block, in seconds.
    pub timestamp: u64,
}

/// A block that was just produced.
#[derive(Debug, Clone)]
pub struct Produced {
    /// The new head.
    pub head: Head,
    /// How many transactions it contained.
    pub transactions: usize,
    /// Gas consumed.
    pub gas_used: u64,
    /// The Engine API calls that produced it, in order.
    ///
    /// Empty unless [`Config::record_exchanges`] is set. It exists so the
    /// sequence can be shown to somebody rather than described to them: there
    /// is one implementation of how a block gets made, and it can narrate
    /// itself instead of being reimplemented next to a lesson about it.
    pub exchanges: Vec<Exchange>,
}

/// One request to the Engine API and what came back.
#[derive(Debug, Clone)]
pub struct Exchange {
    /// The method called, such as `engine_getPayloadV3`.
    pub method: String,
    /// The parameters sent, exactly as they went on the wire.
    pub request: Value,
    /// The `result` field of the response, or null if the call failed.
    pub response: Value,
    /// How long the client took to answer.
    pub elapsed: Duration,
}

/// How the producer should behave.
#[derive(Debug, Clone)]
pub struct Config {
    /// Engine API endpoint, normally `http://127.0.0.1:8551`.
    pub engine_url: String,
    /// Public JSON-RPC endpoint, used to read the head at startup.
    pub rpc_url: String,
    /// The 32-byte shared secret the execution client was started with.
    pub jwt_secret: [u8; 32],
    /// Address credited with priority fees.
    pub fee_recipient: String,
    /// Interval between blocks.
    pub block_time: Duration,
    /// Whether to keep a copy of every Engine API exchange in [`Produced`].
    ///
    /// Off by default. Producing a block is the hot path and a payload can be
    /// large, so the copies are only made when something intends to read them.
    pub record_exchanges: bool,
    /// How long to let the client build a payload before collecting it.
    ///
    /// This has to exceed the client's payload refresh interval, not merely be
    /// "long enough to be safe". Geth answers a build request with an empty
    /// payload straight away and only fills it in on its `--miner.recommit`
    /// tick; collect sooner than that and every block comes back empty, with
    /// the transactions still sitting in the pool and nothing reporting an
    /// error.
    pub build_delay: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            engine_url: "http://127.0.0.1:8551".to_string(),
            rpc_url: "http://127.0.0.1:8545".to_string(),
            jwt_secret: [0u8; 32],
            fee_recipient: "0x0000000000000000000000000000000000000000".to_string(),
            block_time: Duration::from_secs(1),
            record_exchanges: false,
            build_delay: Duration::from_millis(500),
        }
    }
}

/// Drives an execution client to produce blocks.
#[derive(Debug)]
pub struct Producer {
    config: Config,
    http: reqwest::Client,
}

impl Producer {
    /// Build a producer from its configuration.
    pub fn new(config: Config) -> Self {
        Self {
            config,
            http: reqwest::Client::new(),
        }
    }

    /// The configuration in use.
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Read the current head from the public JSON-RPC endpoint.
    ///
    /// Used once at startup; after that the producer knows the head because it
    /// just made it.
    pub async fn current_head(&self) -> Result<Head, ProducerError> {
        let block = self
            .rpc_call("eth_getBlockByNumber", json!(["latest", false]), false)
            .await?;
        parse_head(&block, "eth_getBlockByNumber")
    }

    /// Produce exactly one block on top of `head`, and return the new head.
    pub async fn produce_block(&self, head: &Head) -> Result<Produced, ProducerError> {
        // A block's timestamp must strictly exceed its parent's. Following the
        // wall clock keeps the chain roughly in step with real time, but the
        // parent still wins when blocks are produced faster than one a second.
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ProducerError::Clock)?
            .as_secs();
        let timestamp = now.max(head.timestamp + 1);

        let attributes = json!({
            "timestamp": hex_u64(timestamp),
            "prevRandao": random_hash(),
            "suggestedFeeRecipient": self.config.fee_recipient,
            // Shanghai requires the field; a lab chain has no validators to
            // withdraw for, so it is always empty.
            "withdrawals": [],
            // Cancun requires a beacon block root. There is no beacon chain
            // here, so it is zero — consistently, so the value is at least
            // deterministic.
            "parentBeaconBlockRoot": ZERO_HASH,
        });

        let mut exchanges = Vec::new();

        // 1. Ask the client to start building.
        let started = self
            .engine_call(
                "engine_forkchoiceUpdatedV3",
                json!([forkchoice(&head.hash), attributes]),
                &mut exchanges,
            )
            .await?;
        check_payload_status(&started["payloadStatus"], "engine_forkchoiceUpdatedV3")?;

        let payload_id = started["payloadId"]
            .as_str()
            .ok_or_else(|| ProducerError::Malformed {
                method: "engine_forkchoiceUpdatedV3".to_string(),
                detail: "no payloadId returned; the client refused to build".to_string(),
            })?;

        // 2. Give it a moment to pull transactions in, then collect the block.
        tokio::time::sleep(self.config.build_delay).await;
        let built = self
            .engine_call("engine_getPayloadV3", json!([payload_id]), &mut exchanges)
            .await?;
        let payload = &built["executionPayload"];

        // 3. Hand it back for validation. Without this the client has built a
        //    block but never checked or stored it.
        let accepted = self
            .engine_call(
                "engine_newPayloadV3",
                json!([payload, Vec::<String>::new(), ZERO_HASH]),
                &mut exchanges,
            )
            .await?;
        check_payload_status(&accepted, "engine_newPayloadV3")?;

        // 4. Adopt it. Safe and finalized move with the head because a single
        //    producer has nothing to disagree with — see the note in the module
        //    documentation about what this is not.
        let new_head = parse_head(payload, "engine_getPayloadV3")?;
        let adopted = self
            .engine_call(
                "engine_forkchoiceUpdatedV3",
                json!([forkchoice(&new_head.hash), Value::Null]),
                &mut exchanges,
            )
            .await?;
        check_payload_status(&adopted["payloadStatus"], "engine_forkchoiceUpdatedV3")?;

        Ok(Produced {
            transactions: payload["transactions"].as_array().map_or(0, Vec::len),
            gas_used: parse_hex_u64(&payload["gasUsed"]).unwrap_or(0),
            head: new_head,
            exchanges,
        })
    }

    /// A signed token for the Engine API.
    ///
    /// Regenerated per call rather than cached: the `iat` claim is only
    /// accepted within a narrow window either side of the node's clock, so a
    /// long-lived token would start failing after a minute.
    fn token(&self) -> Result<String, ProducerError> {
        #[derive(Serialize)]
        struct Claims {
            iat: u64,
        }
        let iat = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ProducerError::Clock)?
            .as_secs();
        Ok(jsonwebtoken::encode(
            &JwtHeader::new(Algorithm::HS256),
            &Claims { iat },
            &EncodingKey::from_secret(&self.config.jwt_secret),
        )?)
    }

    async fn engine_call(
        &self,
        method: &str,
        params: Value,
        log: &mut Vec<Exchange>,
    ) -> Result<Value, ProducerError> {
        if !self.config.record_exchanges {
            return self.rpc_call(method, params, true).await;
        }
        // Only cloned when somebody is going to read it; a payload with a
        // thousand transactions in it is not worth copying for nobody.
        let request = params.clone();
        let started = Instant::now();
        let result = self.rpc_call(method, params, true).await;
        log.push(Exchange {
            method: method.to_string(),
            request,
            // A failed call still gets an entry, with a null response — the
            // error itself is returned to the caller and is not clonable.
            response: result.as_ref().ok().cloned().unwrap_or(Value::Null),
            elapsed: started.elapsed(),
        });
        result
    }

    async fn rpc_call(
        &self,
        method: &str,
        params: Value,
        authenticated: bool,
    ) -> Result<Value, ProducerError> {
        let url = if authenticated {
            &self.config.engine_url
        } else {
            &self.config.rpc_url
        };
        let mut request = self.http.post(url).json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        }));
        if authenticated {
            request = request.bearer_auth(self.token()?);
        }

        let body: Value = request.send().await?.json().await?;

        if let Some(error) = body.get("error").filter(|error| !error.is_null()) {
            return Err(ProducerError::Rpc {
                method: method.to_string(),
                message: error["message"]
                    .as_str()
                    .unwrap_or(&error.to_string())
                    .to_string(),
            });
        }
        body.get("result")
            .filter(|result| !result.is_null())
            .cloned()
            .ok_or_else(|| ProducerError::Malformed {
                method: method.to_string(),
                detail: "response carried neither a result nor an error".to_string(),
            })
    }
}

/// The three-hash forkchoice state, with everything pointing at one block.
fn forkchoice(hash: &str) -> Value {
    json!({
        "headBlockHash": hash,
        "safeBlockHash": hash,
        "finalizedBlockHash": hash,
    })
}

/// Reject anything that is not an outright `VALID`.
///
/// `SYNCING` and `ACCEPTED` are legitimate answers on a real network, where the
/// client may be catching up. Here they mean something is wrong, and treating
/// them as success would silently stall the chain.
fn check_payload_status(status: &Value, method: &str) -> Result<(), ProducerError> {
    let reported = status["status"]
        .as_str()
        .ok_or_else(|| ProducerError::Malformed {
            method: method.to_string(),
            detail: "no status field in the payload status".to_string(),
        })?;
    if reported == "VALID" {
        return Ok(());
    }
    Err(ProducerError::PayloadRejected {
        status: reported.to_string(),
        reason: status["validationError"].as_str().map(str::to_string),
    })
}

fn parse_head(block: &Value, method: &str) -> Result<Head, ProducerError> {
    let missing = |field: &str| ProducerError::Malformed {
        method: method.to_string(),
        detail: format!("block has no usable {field}"),
    };
    Ok(Head {
        hash: block["blockHash"]
            .as_str()
            .or_else(|| block["hash"].as_str())
            .ok_or_else(|| missing("hash"))?
            .to_string(),
        number: parse_hex_u64(&block["blockNumber"])
            .or_else(|| parse_hex_u64(&block["number"]))
            .ok_or_else(|| missing("number"))?,
        timestamp: parse_hex_u64(&block["timestamp"]).ok_or_else(|| missing("timestamp"))?,
    })
}

fn parse_hex_u64(value: &Value) -> Option<u64> {
    let text = value.as_str()?;
    u64::from_str_radix(text.strip_prefix("0x").unwrap_or(text), 16).ok()
}

fn hex_u64(value: u64) -> String {
    format!("{value:#x}")
}

fn random_hash() -> String {
    let bytes: [u8; 32] = rand::rng().random();
    format!("0x{}", hex::encode(bytes))
}

/// Parse a JWT secret written as 64 hex characters, with or without `0x`.
pub fn parse_jwt_secret(text: &str) -> Result<[u8; 32], String> {
    let trimmed = text.trim();
    let body = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    let bytes = hex::decode(body).map_err(|error| format!("secret is not valid hex: {error}"))?;
    bytes
        .try_into()
        .map_err(|_| "secret must be exactly 32 bytes (64 hex characters)".to_string())
}

/// Generate a fresh 32-byte secret, rendered as hex.
pub fn generate_jwt_secret() -> String {
    let bytes: [u8; 32] = rand::rng().random();
    hex::encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_numbers_round_trip() {
        for value in [0u64, 1, 255, 256, 1_700_000_000, u64::MAX] {
            let encoded = hex_u64(value);
            assert_eq!(parse_hex_u64(&json!(encoded)), Some(value), "{value}");
        }
        // Quantities carry no leading zeros.
        assert_eq!(hex_u64(0), "0x0");
        assert_eq!(hex_u64(1024), "0x400");
    }

    #[test]
    fn secrets_round_trip_with_and_without_prefix() {
        let generated = generate_jwt_secret();
        let parsed = parse_jwt_secret(&generated).expect("generated secret must parse");
        assert_eq!(hex::encode(parsed), generated);
        assert_eq!(
            parse_jwt_secret(&format!("0x{generated}")).unwrap(),
            parsed,
            "the 0x prefix is optional"
        );
        // Trailing whitespace from a file read must not break it.
        assert_eq!(parse_jwt_secret(&format!("{generated}\n")).unwrap(), parsed);
    }

    #[test]
    fn secrets_of_the_wrong_size_are_refused() {
        assert!(parse_jwt_secret("abcd").is_err());
        assert!(parse_jwt_secret(&"aa".repeat(31)).is_err());
        assert!(parse_jwt_secret(&"aa".repeat(33)).is_err());
        assert!(parse_jwt_secret("zz".repeat(32).as_str()).is_err());
    }

    #[test]
    fn generated_secrets_differ() {
        assert_ne!(generate_jwt_secret(), generate_jwt_secret());
        assert_eq!(generate_jwt_secret().len(), 64);
    }

    #[test]
    fn prev_randao_is_a_32_byte_hex_value() {
        let value = random_hash();
        assert_eq!(value.len(), 66);
        assert!(value.starts_with("0x"));
        assert_ne!(random_hash(), random_hash());
    }

    #[test]
    fn forkchoice_points_every_field_at_one_block() {
        let state = forkchoice("0xabc");
        assert_eq!(state["headBlockHash"], "0xabc");
        assert_eq!(state["safeBlockHash"], "0xabc");
        assert_eq!(state["finalizedBlockHash"], "0xabc");
    }

    #[test]
    fn only_valid_counts_as_success() {
        assert!(check_payload_status(&json!({"status": "VALID"}), "m").is_ok());

        // SYNCING is a legitimate answer on a real network and a stalled chain
        // here, so it must not be mistaken for success.
        for status in ["SYNCING", "ACCEPTED", "INVALID"] {
            let error = check_payload_status(&json!({"status": status}), "m").unwrap_err();
            assert!(
                matches!(error, ProducerError::PayloadRejected { .. }),
                "{status}"
            );
        }
    }

    #[test]
    fn rejection_carries_the_validation_error() {
        let error = check_payload_status(
            &json!({"status": "INVALID", "validationError": "bad state root"}),
            "engine_newPayloadV3",
        )
        .unwrap_err();
        assert!(error.to_string().contains("bad state root"));
    }

    #[test]
    fn a_head_parses_from_either_field_spelling() {
        // eth_getBlockByNumber says `hash` and `number`; an execution payload
        // says `blockHash` and `blockNumber`. Both have to work.
        let rpc = json!({"hash": "0x01", "number": "0x5", "timestamp": "0x64"});
        let payload = json!({"blockHash": "0x01", "blockNumber": "0x5", "timestamp": "0x64"});
        let expected = Head {
            hash: "0x01".to_string(),
            number: 5,
            timestamp: 100,
        };
        assert_eq!(parse_head(&rpc, "m").unwrap(), expected);
        assert_eq!(parse_head(&payload, "m").unwrap(), expected);
    }

    #[test]
    fn a_head_missing_fields_is_an_error() {
        assert!(parse_head(&json!({"hash": "0x01"}), "m").is_err());
        assert!(parse_head(&json!({}), "m").is_err());
    }
}
