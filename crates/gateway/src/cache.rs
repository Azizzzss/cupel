//! A cache for answers that cannot change.
//!
//! Most JSON-RPC traffic from a development tool is repetitive: the same block
//! fetched again, the same receipt polled until it appears, `eth_chainId` asked
//! on every single call. Serving those from memory keeps them off the node.
//!
//! The rule here is deliberately narrow: **cache only what is provably
//! immutable.** A block identified by hash cannot change. A block identified by
//! `latest` changes every second. Getting this wrong does not show up as a slow
//! gateway, it shows up as a client being told something false, so the default
//! is to cache nothing and add methods only where the argument pins the answer.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;

/// Tags that name a moving target rather than a fixed block.
const MOVING: [&str; 4] = ["latest", "pending", "safe", "finalized"];

/// Whether a response to this call can ever change.
///
/// `params` matters as much as the method: `eth_getBlockByNumber` is cacheable
/// at block `0x5` and never cacheable at `latest`.
pub fn is_immutable(method: &str, params: &Value) -> bool {
    match method {
        // Properties of the chain itself.
        "eth_chainId" | "net_version" | "web3_clientVersion" => true,

        // Identified by hash, so the answer is pinned by the question.
        "eth_getBlockByHash"
        | "eth_getTransactionByHash"
        | "eth_getTransactionReceipt"
        | "eth_getBlockTransactionCountByHash" => true,

        // Identified by number, but only when the number is a number.
        "eth_getBlockByNumber" | "eth_getBlockTransactionCountByNumber" => {
            !references_moving_block(params)
        }

        // Everything else, including every balance and every call, is a
        // question about *now*.
        _ => false,
    }
}

/// Whether any argument names a moving block.
fn references_moving_block(params: &Value) -> bool {
    match params {
        Value::String(text) => MOVING.contains(&text.as_str()),
        Value::Array(items) => items.iter().any(references_moving_block),
        Value::Object(fields) => fields.values().any(references_moving_block),
        _ => false,
    }
}

/// A bounded store of immutable responses.
#[derive(Debug)]
pub struct Cache {
    entries: Mutex<HashMap<String, Value>>,
    capacity: usize,
}

impl Cache {
    /// A cache holding at most `capacity` responses.
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            capacity,
        }
    }

    /// The key a call is stored under.
    pub fn key(method: &str, params: &Value) -> String {
        format!("{method}|{params}")
    }

    /// Look up a stored response.
    pub fn get(&self, key: &str) -> Option<Value> {
        self.entries.lock().ok()?.get(key).cloned()
    }

    /// Store a response, if there is room.
    ///
    /// When full the cache simply stops accepting new entries rather than
    /// evicting. Nothing here is ever invalidated — every entry is immutable —
    /// so the worst case is that later calls miss, which costs latency and
    /// never correctness.
    pub fn put(&self, key: String, value: Value) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        if entries.len() >= self.capacity && !entries.contains_key(&key) {
            return;
        }
        entries.insert(key, value);
    }

    /// How many responses are held.
    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .map(|entries| entries.len())
            .unwrap_or(0)
    }

    /// Whether nothing is held.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chain_properties_are_cacheable() {
        assert!(is_immutable("eth_chainId", &json!([])));
        assert!(is_immutable("net_version", &json!([])));
        assert!(is_immutable("web3_clientVersion", &json!([])));
    }

    #[test]
    fn anything_identified_by_hash_is_cacheable() {
        let hash = json!(["0xabc", false]);
        assert!(is_immutable("eth_getBlockByHash", &hash));
        assert!(is_immutable("eth_getTransactionByHash", &json!(["0xabc"])));
        assert!(is_immutable("eth_getTransactionReceipt", &json!(["0xabc"])));
    }

    #[test]
    fn a_numbered_block_is_cacheable_but_latest_is_not() {
        assert!(is_immutable("eth_getBlockByNumber", &json!(["0x5", false])));
        assert!(!is_immutable(
            "eth_getBlockByNumber",
            &json!(["latest", false])
        ));
        assert!(!is_immutable(
            "eth_getBlockByNumber",
            &json!(["pending", false])
        ));
        assert!(!is_immutable(
            "eth_getBlockByNumber",
            &json!(["safe", false])
        ));
        assert!(!is_immutable(
            "eth_getBlockByNumber",
            &json!(["finalized", false])
        ));
    }

    #[test]
    fn questions_about_now_are_never_cacheable() {
        // Every one of these would be a correctness bug, not a slow gateway.
        for method in [
            "eth_blockNumber",
            "eth_getBalance",
            "eth_getTransactionCount",
            "eth_call",
            "eth_estimateGas",
            "eth_gasPrice",
            "eth_sendRawTransaction",
            "txpool_status",
        ] {
            assert!(!is_immutable(method, &json!([])), "{method}");
        }
    }

    #[test]
    fn a_moving_tag_is_found_however_it_is_nested() {
        // Clients pass block tags in objects as well as positionally, and a
        // filter can bury one two levels down.
        assert!(references_moving_block(&json!(["latest"])));
        assert!(references_moving_block(&json!([{"blockTag": "latest"}])));
        assert!(references_moving_block(
            &json!([{"filter": {"toBlock": "pending"}}])
        ));
        assert!(!references_moving_block(
            &json!(["0x1", {"toBlock": "0x2"}])
        ));
    }

    #[test]
    fn stored_responses_come_back() {
        let cache = Cache::new(4);
        let key = Cache::key("eth_chainId", &json!([]));
        assert_eq!(cache.get(&key), None);

        cache.put(key.clone(), json!("0x7a69"));
        assert_eq!(cache.get(&key), Some(json!("0x7a69")));
    }

    #[test]
    fn the_key_separates_calls_that_differ_only_in_arguments() {
        let five = Cache::key("eth_getBlockByNumber", &json!(["0x5", false]));
        let six = Cache::key("eth_getBlockByNumber", &json!(["0x6", false]));
        assert_ne!(five, six, "different blocks are different entries");
    }

    #[test]
    fn a_full_cache_stops_accepting_rather_than_evicting() {
        let cache = Cache::new(2);
        cache.put("a".into(), json!(1));
        cache.put("b".into(), json!(2));
        cache.put("c".into(), json!(3));

        assert_eq!(cache.len(), 2, "capacity is respected");
        assert_eq!(cache.get("a"), Some(json!(1)), "existing entries survive");
        assert_eq!(cache.get("c"), None, "the newcomer was refused");
    }

    #[test]
    fn overwriting_an_existing_entry_is_allowed_when_full() {
        let cache = Cache::new(1);
        cache.put("a".into(), json!(1));
        cache.put("a".into(), json!(2));
        assert_eq!(cache.get("a"), Some(json!(2)));
        assert_eq!(cache.len(), 1);
    }
}
