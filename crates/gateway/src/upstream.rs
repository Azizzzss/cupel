//! Upstreams, what they can answer, and which one gets a request.
//!
//! The gateway holds a *list* of upstreams even when there is only one, and
//! each declares what it is capable of. That costs almost nothing today and is
//! what lets a second node be added later as a config entry rather than a
//! rewrite — which matters, because the multi-client network in a later phase
//! arrives with three of them.
//!
//! The abstraction is deliberately over the list and the capabilities, never
//! over the protocol. There is no plugin loading here and no translation layer
//! for backends that do not speak JSON-RPC.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

/// What an upstream is able to answer.
///
/// Routing checks these *before* choosing, so a request that needs archive
/// state is never sent to a node that would have to refuse it. The client then
/// gets one clear error instead of a confusing failure from a node that was
/// never a candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    /// Can answer state queries at historical blocks.
    pub archive: bool,
    /// Serves the `debug_` and `trace_` namespaces.
    pub trace: bool,
    /// Serves the `txpool_` namespace.
    pub tx_pool: bool,
    /// Largest batch it will accept.
    pub max_batch: usize,
}

impl Default for Capabilities {
    fn default() -> Self {
        // The lab node runs with --gcmode archive and every namespace enabled,
        // so the honest default is "everything".
        Self {
            archive: true,
            trace: true,
            tx_pool: true,
            max_batch: 100,
        }
    }
}

/// What a request needs from an upstream.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Requirements {
    /// Needs historical state.
    pub archive: bool,
    /// Needs tracing.
    pub trace: bool,
    /// Needs the transaction pool.
    pub tx_pool: bool,
}

impl Requirements {
    /// Work out what a method needs.
    ///
    /// `historical` is supplied by the caller because it depends on the
    /// *arguments*, not the method: `eth_getBalance` at `latest` needs nothing
    /// special, the same call at block 100 needs an archive node.
    pub fn for_method(method: &str, historical: bool) -> Self {
        Self {
            archive: historical,
            trace: method.starts_with("debug_") || method.starts_with("trace_"),
            tx_pool: method.starts_with("txpool_"),
        }
    }

    /// Whether an upstream can satisfy this.
    pub fn satisfied_by(&self, capabilities: &Capabilities) -> bool {
        (!self.archive || capabilities.archive)
            && (!self.trace || capabilities.trace)
            && (!self.tx_pool || capabilities.tx_pool)
    }
}

/// Whether an upstream is answering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    /// Answering normally.
    Up,
    /// Failing, and not to be routed to.
    Down,
    /// Not probed yet. Treated as usable, so a request arriving before the
    /// first probe is served rather than rejected.
    Unknown,
}

impl Health {
    /// Whether routing may use it.
    pub fn routable(self) -> bool {
        !matches!(self, Self::Down)
    }
}

/// One node the gateway can forward to.
#[derive(Debug)]
pub struct Upstream {
    /// Name, used in logs and metrics.
    pub name: String,
    /// Where to send requests.
    pub url: String,
    /// Relative share of traffic among equally healthy upstreams.
    pub weight: u32,
    /// What it can answer.
    pub capabilities: Capabilities,
    /// Current health, as an integer so it can be updated without a lock.
    health: AtomicUsize,
    /// Consecutive probe failures, used to avoid flapping on one blip.
    failures: AtomicU64,
    /// Requests forwarded, for metrics.
    pub(crate) forwarded: AtomicU64,
    /// Requests that failed at the transport, for metrics.
    pub(crate) errors: AtomicU64,
}

const HEALTH_UNKNOWN: usize = 0;
const HEALTH_UP: usize = 1;
const HEALTH_DOWN: usize = 2;

/// Probe failures tolerated before an upstream is taken out of rotation.
///
/// One failed probe is usually a blip. Removing a node on the first one makes
/// the gateway flap under load, which is worse than a moment of latency.
pub const FAILURES_BEFORE_DOWN: u64 = 2;

impl Upstream {
    /// Declare an upstream with default capabilities.
    pub fn new(name: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            url: url.into(),
            weight: 1,
            capabilities: Capabilities::default(),
            health: AtomicUsize::new(HEALTH_UNKNOWN),
            failures: AtomicU64::new(0),
            forwarded: AtomicU64::new(0),
            errors: AtomicU64::new(0),
        }
    }

    /// Set capabilities.
    pub fn with_capabilities(mut self, capabilities: Capabilities) -> Self {
        self.capabilities = capabilities;
        self
    }

    /// Set the routing weight.
    pub fn with_weight(mut self, weight: u32) -> Self {
        self.weight = weight;
        self
    }

    /// Current health.
    pub fn health(&self) -> Health {
        match self.health.load(Ordering::Relaxed) {
            HEALTH_UP => Health::Up,
            HEALTH_DOWN => Health::Down,
            _ => Health::Unknown,
        }
    }

    /// Record a successful probe, clearing any accumulated failures.
    pub fn mark_healthy(&self) {
        self.failures.store(0, Ordering::Relaxed);
        self.health.store(HEALTH_UP, Ordering::Relaxed);
    }

    /// Record a failed probe. Only takes the upstream out of rotation once
    /// enough have accumulated.
    pub fn mark_probe_failed(&self) {
        let failures = self.failures.fetch_add(1, Ordering::Relaxed) + 1;
        if failures >= FAILURES_BEFORE_DOWN {
            self.health.store(HEALTH_DOWN, Ordering::Relaxed);
        }
    }

    /// Requests forwarded so far.
    pub fn forwarded(&self) -> u64 {
        self.forwarded.load(Ordering::Relaxed)
    }

    /// Transport failures so far.
    pub fn errors(&self) -> u64 {
        self.errors.load(Ordering::Relaxed)
    }
}

/// Why no upstream could take a request.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RouteError {
    /// Every upstream that could have answered is down.
    #[error("no healthy upstream is available")]
    AllDown,
    /// No upstream declares the capability the request needs.
    #[error("no upstream can serve this request: it requires {requirement}")]
    Unsupported {
        /// The capability that was missing.
        requirement: &'static str,
    },
}

/// The set of upstreams, and the choice of which one answers.
#[derive(Debug)]
pub struct Registry {
    upstreams: Vec<Upstream>,
    next: AtomicUsize,
}

impl Registry {
    /// Build a registry. Must not be empty.
    pub fn new(upstreams: Vec<Upstream>) -> Self {
        assert!(
            !upstreams.is_empty(),
            "a gateway needs at least one upstream"
        );
        Self {
            upstreams,
            next: AtomicUsize::new(0),
        }
    }

    /// Every upstream, for metrics and status.
    pub fn all(&self) -> &[Upstream] {
        &self.upstreams
    }

    /// Choose an upstream for a request.
    ///
    /// Resolution order is fixed: **capability, then health, then weight.**
    /// Capability first is what makes the failure message useful — a request no
    /// node can serve is a different problem from one where every node is down,
    /// and the client should be told which.
    pub fn select(&self, requirements: &Requirements) -> Result<&Upstream, RouteError> {
        let capable: Vec<&Upstream> = self
            .upstreams
            .iter()
            .filter(|upstream| requirements.satisfied_by(&upstream.capabilities))
            .collect();

        if capable.is_empty() {
            return Err(RouteError::Unsupported {
                requirement: if requirements.archive {
                    "historical state"
                } else if requirements.trace {
                    "tracing"
                } else {
                    "the transaction pool"
                },
            });
        }

        let usable: Vec<&&Upstream> = capable
            .iter()
            .filter(|upstream| upstream.health().routable())
            .collect();
        if usable.is_empty() {
            return Err(RouteError::AllDown);
        }

        // Weighted round-robin: an upstream with weight 3 appears three times in
        // the rotation. Simple, allocation-free for the common case, and good
        // enough while the list is a handful of nodes.
        let total: u32 = usable.iter().map(|upstream| upstream.weight.max(1)).sum();
        let step = self.next.fetch_add(1, Ordering::Relaxed) as u32;
        let mut point = step % total;
        for upstream in &usable {
            let weight = upstream.weight.max(1);
            if point < weight {
                return Ok(upstream);
            }
            point -= weight;
        }
        Ok(usable[0])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive_only() -> Capabilities {
        Capabilities {
            archive: true,
            trace: false,
            tx_pool: false,
            max_batch: 10,
        }
    }

    fn full() -> Capabilities {
        Capabilities::default()
    }

    #[test]
    fn requirements_follow_the_method_and_the_arguments() {
        // The namespace decides tracing and the pool.
        assert!(Requirements::for_method("debug_traceTransaction", false).trace);
        assert!(Requirements::for_method("trace_block", false).trace);
        assert!(Requirements::for_method("txpool_status", false).tx_pool);
        assert!(!Requirements::for_method("eth_blockNumber", false).trace);

        // Archive depends on the *block argument*, not the method name: the
        // same call is ordinary at `latest` and needs history at block 100.
        assert!(!Requirements::for_method("eth_getBalance", false).archive);
        assert!(Requirements::for_method("eth_getBalance", true).archive);
    }

    #[test]
    fn an_upstream_must_declare_what_a_request_needs() {
        let needs_trace = Requirements::for_method("debug_traceCall", false);
        assert!(!needs_trace.satisfied_by(&archive_only()));
        assert!(needs_trace.satisfied_by(&full()));

        let ordinary = Requirements::for_method("eth_blockNumber", false);
        assert!(ordinary.satisfied_by(&archive_only()), "asks for nothing");
    }

    #[test]
    fn selection_prefers_a_capable_upstream() {
        let registry = Registry::new(vec![
            Upstream::new("fast", "http://a").with_capabilities(archive_only()),
            Upstream::new("full", "http://b").with_capabilities(full()),
        ]);
        for upstream in registry.all() {
            upstream.mark_healthy();
        }

        let chosen = registry
            .select(&Requirements::for_method("debug_traceCall", false))
            .expect("one upstream can trace");
        assert_eq!(chosen.name, "full", "only one of them traces");
    }

    #[test]
    fn a_request_no_upstream_supports_says_so_specifically() {
        let registry = Registry::new(vec![Upstream::new("fast", "http://a").with_capabilities(
            Capabilities {
                archive: false,
                trace: false,
                tx_pool: false,
                max_batch: 10,
            },
        )]);
        registry.all()[0].mark_healthy();

        // Unsupported is a different answer from "everything is down", and the
        // client needs to be able to tell them apart.
        let error = registry
            .select(&Requirements::for_method("eth_getBalance", true))
            .unwrap_err();
        assert_eq!(
            error,
            RouteError::Unsupported {
                requirement: "historical state"
            }
        );
    }

    #[test]
    fn a_down_upstream_is_skipped() {
        let registry = Registry::new(vec![
            Upstream::new("a", "http://a"),
            Upstream::new("b", "http://b"),
        ]);
        registry.all()[0].mark_healthy();
        registry.all()[1].mark_healthy();

        // Take the first out of rotation.
        registry.all()[0].mark_probe_failed();
        registry.all()[0].mark_probe_failed();
        assert_eq!(registry.all()[0].health(), Health::Down);

        for _ in 0..10 {
            let chosen = registry.select(&Requirements::default()).unwrap();
            assert_eq!(chosen.name, "b", "traffic avoids the down upstream");
        }
    }

    #[test]
    fn one_blip_does_not_take_an_upstream_out_of_rotation() {
        // Removing a node on a single failed probe makes the gateway flap under
        // load, which is worse than a moment of latency.
        let upstream = Upstream::new("a", "http://a");
        upstream.mark_healthy();

        upstream.mark_probe_failed();
        assert_eq!(upstream.health(), Health::Up, "still in rotation");

        upstream.mark_probe_failed();
        assert_eq!(upstream.health(), Health::Down, "two in a row is enough");
    }

    #[test]
    fn recovery_clears_accumulated_failures() {
        let upstream = Upstream::new("a", "http://a");
        upstream.mark_probe_failed();
        upstream.mark_healthy();
        // The earlier failure must not count towards the next removal.
        upstream.mark_probe_failed();
        assert_eq!(upstream.health(), Health::Up, "the counter reset");
    }

    #[test]
    fn everything_down_is_reported_as_such() {
        let registry = Registry::new(vec![Upstream::new("a", "http://a")]);
        registry.all()[0].mark_probe_failed();
        registry.all()[0].mark_probe_failed();

        assert_eq!(
            registry.select(&Requirements::default()).unwrap_err(),
            RouteError::AllDown
        );
    }

    #[test]
    fn an_unprobed_upstream_is_usable() {
        // A request arriving before the first probe should be served, not
        // refused because the gateway has not looked yet.
        let registry = Registry::new(vec![Upstream::new("a", "http://a")]);
        assert_eq!(registry.all()[0].health(), Health::Unknown);
        assert!(registry.select(&Requirements::default()).is_ok());
    }

    #[test]
    fn weight_shares_traffic_in_proportion() {
        let registry = Registry::new(vec![
            Upstream::new("heavy", "http://a").with_weight(3),
            Upstream::new("light", "http://b").with_weight(1),
        ]);
        for upstream in registry.all() {
            upstream.mark_healthy();
        }

        let mut heavy = 0;
        for _ in 0..400 {
            if registry.select(&Requirements::default()).unwrap().name == "heavy" {
                heavy += 1;
            }
        }
        assert_eq!(heavy, 300, "three of every four requests");
    }

    #[test]
    fn a_single_upstream_always_wins() {
        let registry = Registry::new(vec![Upstream::new("only", "http://a")]);
        registry.all()[0].mark_healthy();
        for _ in 0..5 {
            assert_eq!(
                registry.select(&Requirements::default()).unwrap().name,
                "only"
            );
        }
    }
}
