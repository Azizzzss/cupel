//! A cache for answers that cannot change.
//!
//! Most JSON-RPC traffic from a development tool is repetitive: the same block
//! fetched again, `eth_chainId` asked on every single call. Serving those from
//! memory keeps them off the node.
//!
//! The rule here is deliberately narrow: **cache only what is provably
//! immutable.** Getting this wrong does not show up as a slow gateway, it shows
//! up as a client being told something false, so the default is to cache
//! nothing and add methods only where the question pins the answer for ever.
//!
//! "For ever" is the part that is easy to get wrong, and this module did. A
//! question identified by a hash *looks* pinned, and a block identified by a
//! number *looks* fixed once it exists, and neither is true on a chain that can
//! reorganise:
//!
//! - A transaction looked up by hash while it is pending comes back with a null
//!   `blockHash`. Cache that and the gateway reports it pending after it has
//!   landed, indefinitely.
//! - A receipt, or a mined transaction, names the block that included it. Before
//!   finality a reorg can include the same transaction in a different block,
//!   and a cached copy goes on naming the one that is no longer canonical.
//! - A block by number names a position, and before finality a position can be
//!   filled by a different block.
//!
//! Lab mode has one producer and cannot reorganise, which is why none of this
//! showed. Network mode has three clients and can. Nothing above is cached any
//! more; what remains is content-addressed or a property of the chain itself,
//! and is immutable without any assumption about finality.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;

/// Whether a response to this call can ever change.
///
/// Only two kinds qualify. Properties of the chain, and a block identified by
/// its hash — a hash commits to the block's contents, so a node may stop
/// serving a block that was reorganised away, but it can never serve different
/// contents under that hash.
pub fn is_immutable(method: &str, _params: &Value) -> bool {
    matches!(
        method,
        "eth_chainId"
            | "net_version"
            | "web3_clientVersion"
            | "eth_getBlockByHash"
            | "eth_getBlockTransactionCountByHash"
    )
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
    fn a_block_named_by_its_hash_is_cacheable() {
        let hash = json!(["0xabc", false]);
        assert!(is_immutable("eth_getBlockByHash", &hash));
        assert!(is_immutable(
            "eth_getBlockTransactionCountByHash",
            &json!(["0xabc"])
        ));
    }

    #[test]
    fn answers_that_a_transaction_landing_or_a_reorg_can_change_are_not() {
        // Keyed by hash, and still not pinned. A pending transaction's answer
        // changes when it is mined; a receipt's block changes if a reorg
        // includes the transaction somewhere else. These were cached, and the
        // first of them served a landed transaction as pending for ever.
        assert!(!is_immutable("eth_getTransactionByHash", &json!(["0xabc"])));
        assert!(!is_immutable(
            "eth_getTransactionReceipt",
            &json!(["0xabc"])
        ));

        // A number is a position, and before finality a position can be filled
        // by a different block. Every tag is a moving position as well.
        for block in ["0x5", "latest", "pending", "safe", "finalized"] {
            assert!(
                !is_immutable("eth_getBlockByNumber", &json!([block, false])),
                "{block}"
            );
            assert!(
                !is_immutable("eth_getBlockTransactionCountByNumber", &json!([block])),
                "{block}"
            );
        }
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
