//! Prometheus metrics, rendered by hand.
//!
//! The exposition format is a few lines of text, so a whole client library
//! would be more dependency than the job needs. What matters is emitting the
//! right *shape*: a `# HELP` and `# TYPE` per family, counters that only ever
//! increase, and a gauge for anything that can go down.
//!
//! These are the numbers the Grafana dashboard is built from, and the ones that
//! make a failed upstream visible before anybody files a bug.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// Counters and gauges the gateway keeps.
#[derive(Debug, Default)]
pub struct Metrics {
    /// Requests received, by method.
    by_method: Mutex<HashMap<String, u64>>,
    /// Requests answered successfully.
    pub ok: AtomicU64,
    /// Requests that produced a JSON-RPC error object.
    pub failed: AtomicU64,
    /// Requests refused because no upstream could take them.
    pub rejected: AtomicU64,
    /// Requests served from the cache.
    pub cache_hits: AtomicU64,
    /// Requests that had to go to an upstream.
    pub cache_misses: AtomicU64,
    /// Requests refused by the rate limiter.
    pub rate_limited: AtomicU64,
    /// Total time spent waiting on upstreams, in microseconds.
    pub upstream_micros: AtomicU64,
}

impl Metrics {
    /// A fresh set of counters.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that a method was called.
    pub fn observe_method(&self, method: &str) {
        if let Ok(mut counts) = self.by_method.lock() {
            // Bounded so that a client inventing method names cannot grow this
            // without limit — an unbounded label set is the classic way to make
            // a metrics endpoint fall over.
            if counts.len() < 128 || counts.contains_key(method) {
                *counts.entry(method.to_string()).or_insert(0) += 1;
            }
        }
    }

    /// Render everything in the Prometheus text format.
    pub fn render(&self, upstreams: &[UpstreamStat]) -> String {
        let mut out = String::with_capacity(2048);

        counter(
            &mut out,
            "cupel_gateway_requests_ok_total",
            "Requests answered successfully.",
            self.ok.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "cupel_gateway_requests_failed_total",
            "Requests that returned a JSON-RPC error.",
            self.failed.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "cupel_gateway_requests_rejected_total",
            "Requests refused because no upstream could serve them.",
            self.rejected.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "cupel_gateway_rate_limited_total",
            "Requests refused by the rate limiter.",
            self.rate_limited.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "cupel_gateway_cache_hits_total",
            "Requests served from the immutable-response cache.",
            self.cache_hits.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "cupel_gateway_cache_misses_total",
            "Requests that had to reach an upstream.",
            self.cache_misses.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "cupel_gateway_upstream_seconds_total",
            "Total time spent waiting on upstreams.",
            self.upstream_micros.load(Ordering::Relaxed) / 1_000_000,
        );

        if let Ok(counts) = self.by_method.lock() {
            out.push_str("# HELP cupel_gateway_method_total Requests received, by method.\n");
            out.push_str("# TYPE cupel_gateway_method_total counter\n");
            let mut methods: Vec<(&String, &u64)> = counts.iter().collect();
            methods.sort_by(|a, b| a.0.cmp(b.0));
            for (method, count) in methods {
                let _ = writeln!(
                    out,
                    "cupel_gateway_method_total{{method=\"{method}\"}} {count}"
                );
            }
        }

        out.push_str("# HELP cupel_gateway_upstream_up Whether an upstream is answering.\n");
        out.push_str("# TYPE cupel_gateway_upstream_up gauge\n");
        for stat in upstreams {
            let _ = writeln!(
                out,
                "cupel_gateway_upstream_up{{upstream=\"{}\"}} {}",
                stat.name,
                u8::from(stat.up)
            );
        }

        out.push_str(
            "# HELP cupel_gateway_upstream_forwarded_total Requests sent to an upstream.\n",
        );
        out.push_str("# TYPE cupel_gateway_upstream_forwarded_total counter\n");
        for stat in upstreams {
            let _ = writeln!(
                out,
                "cupel_gateway_upstream_forwarded_total{{upstream=\"{}\"}} {}",
                stat.name, stat.forwarded
            );
        }

        out.push_str(
            "# HELP cupel_gateway_upstream_errors_total Requests that failed at the transport.\n",
        );
        out.push_str("# TYPE cupel_gateway_upstream_errors_total counter\n");
        for stat in upstreams {
            let _ = writeln!(
                out,
                "cupel_gateway_upstream_errors_total{{upstream=\"{}\"}} {}",
                stat.name, stat.errors
            );
        }

        out
    }
}

/// A snapshot of one upstream, for rendering.
#[derive(Debug, Clone)]
pub struct UpstreamStat {
    /// Its name.
    pub name: String,
    /// Whether it is currently routable.
    pub up: bool,
    /// Requests forwarded to it.
    pub forwarded: u64,
    /// Transport failures.
    pub errors: u64,
}

fn counter(out: &mut String, name: &str, help: &str, value: u64) {
    let _ = writeln!(out, "# HELP {name} {help}");
    let _ = writeln!(out, "# TYPE {name} counter");
    let _ = writeln!(out, "{name} {value}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats() -> Vec<UpstreamStat> {
        vec![UpstreamStat {
            name: "geth".into(),
            up: true,
            forwarded: 7,
            errors: 1,
        }]
    }

    #[test]
    fn every_family_carries_help_and_type() {
        // Prometheus tolerates their absence, but a metric without them is
        // undocumented for anyone reading the endpoint by hand.
        let rendered = Metrics::new().render(&stats());
        for family in [
            "cupel_gateway_requests_ok_total",
            "cupel_gateway_cache_hits_total",
            "cupel_gateway_upstream_up",
            "cupel_gateway_upstream_forwarded_total",
        ] {
            assert!(
                rendered.contains(&format!("# HELP {family} ")),
                "{family} has no HELP"
            );
            assert!(
                rendered.contains(&format!("# TYPE {family} ")),
                "{family} has no TYPE"
            );
        }
    }

    #[test]
    fn health_is_a_gauge_and_the_rest_are_counters() {
        // A counter that can go down breaks every rate() query built on it.
        let rendered = Metrics::new().render(&stats());
        assert!(rendered.contains("# TYPE cupel_gateway_upstream_up gauge"));
        assert!(rendered.contains("# TYPE cupel_gateway_requests_ok_total counter"));
    }

    #[test]
    fn upstream_labels_are_rendered() {
        let rendered = Metrics::new().render(&stats());
        assert!(rendered.contains("cupel_gateway_upstream_up{upstream=\"geth\"} 1"));
        assert!(rendered.contains("cupel_gateway_upstream_forwarded_total{upstream=\"geth\"} 7"));
        assert!(rendered.contains("cupel_gateway_upstream_errors_total{upstream=\"geth\"} 1"));
    }

    #[test]
    fn a_down_upstream_reads_zero() {
        let down = vec![UpstreamStat {
            name: "geth".into(),
            up: false,
            forwarded: 0,
            errors: 3,
        }];
        let rendered = Metrics::new().render(&down);
        assert!(rendered.contains("cupel_gateway_upstream_up{upstream=\"geth\"} 0"));
    }

    #[test]
    fn method_counts_accumulate_and_sort() {
        let metrics = Metrics::new();
        metrics.observe_method("eth_blockNumber");
        metrics.observe_method("eth_blockNumber");
        metrics.observe_method("eth_chainId");

        let rendered = metrics.render(&stats());
        assert!(rendered.contains("cupel_gateway_method_total{method=\"eth_blockNumber\"} 2"));
        assert!(rendered.contains("cupel_gateway_method_total{method=\"eth_chainId\"} 1"));

        // Sorted, so the output is stable between scrapes.
        let block = rendered.find("method=\"eth_blockNumber\"").unwrap();
        let chain = rendered.find("method=\"eth_chainId\"").unwrap();
        assert!(block < chain);
    }

    #[test]
    fn the_method_label_set_is_bounded() {
        // A client inventing method names must not be able to grow the metrics
        // endpoint without limit.
        let metrics = Metrics::new();
        for i in 0..500 {
            metrics.observe_method(&format!("eth_invented{i}"));
        }
        let count = metrics.by_method.lock().unwrap().len();
        assert!(count <= 128, "label set grew to {count}");
    }
}
