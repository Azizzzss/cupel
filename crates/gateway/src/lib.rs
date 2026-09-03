//! The Cupel RPC gateway.
//!
//! Everything points at the gateway; the gateway points at the nodes. That one
//! indirection buys the things a bare node cannot give you: a request is routed
//! to an upstream that can actually answer it, an upstream that stops answering
//! is taken out of rotation and put back when it recovers, repeated questions
//! with unchanging answers are served from memory, and the whole lot is
//! measurable from the outside.
//!
//! It speaks plain JSON-RPC in both directions and understands nothing about
//! the chain beyond which methods are expensive and which answers can be
//! cached.

pub mod cache;
pub mod metrics;
pub mod upstream;

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};

pub use cache::Cache;
pub use metrics::{Metrics, UpstreamStat};
pub use upstream::{Capabilities, Health, Registry, Requirements, RouteError, Upstream};

/// How the gateway behaves.
#[derive(Debug, Clone)]
pub struct Config {
    /// Requests per second accepted overall.
    pub rate_limit: u32,
    /// Requests per second accepted for expensive methods.
    ///
    /// `eth_call`, gas estimation, log queries and tracing all cost the node
    /// far more than a balance lookup, and a loop issuing them is the usual way
    /// a local node becomes unresponsive.
    pub expensive_rate_limit: u32,
    /// How many immutable responses to keep.
    pub cache_capacity: usize,
    /// Gap between health probes.
    pub probe_interval: Duration,
    /// How long to wait on an upstream before giving up.
    pub upstream_timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            rate_limit: 2_000,
            expensive_rate_limit: 200,
            cache_capacity: 4_096,
            probe_interval: Duration::from_secs(2),
            upstream_timeout: Duration::from_secs(10),
        }
    }
}

/// Methods that cost a node real work.
fn is_expensive(method: &str) -> bool {
    matches!(method, "eth_call" | "eth_estimateGas" | "eth_getLogs")
        || method.starts_with("debug_")
        || method.starts_with("trace_")
}

/// Whether a call asks about a block other than the current one.
///
/// Judged from the arguments rather than the method: `eth_getBalance` at
/// `latest` is an ordinary question, and the same call at block `0x5` needs a
/// node that kept history.
fn needs_history(method: &str, params: &Value) -> bool {
    let block_argument = match method {
        "eth_getBalance" | "eth_getCode" | "eth_getTransactionCount" => 1,
        "eth_getStorageAt" => 2,
        "eth_call" | "eth_estimateGas" => 1,
        _ => return false,
    };
    params
        .get(block_argument)
        .and_then(Value::as_str)
        .is_some_and(|tag| tag.starts_with("0x"))
}

/// A crude per-second window.
///
/// Not a token bucket: this is a local development gateway, and the job is to
/// stop a runaway loop from wedging the node, not to shape traffic fairly.
#[derive(Debug)]
struct Window {
    started: std::sync::Mutex<Instant>,
    count: std::sync::atomic::AtomicU32,
}

impl Window {
    fn new() -> Self {
        Self {
            started: std::sync::Mutex::new(Instant::now()),
            count: std::sync::atomic::AtomicU32::new(0),
        }
    }

    /// Take one slot, or report that the limit is reached.
    fn allow(&self, limit: u32) -> bool {
        if let Ok(mut started) = self.started.lock()
            && started.elapsed() >= Duration::from_secs(1)
        {
            *started = Instant::now();
            self.count.store(0, Ordering::Relaxed);
        }
        self.count.fetch_add(1, Ordering::Relaxed) < limit
    }
}

/// The gateway.
#[derive(Debug)]
pub struct Gateway {
    config: Config,
    registry: Registry,
    cache: Cache,
    metrics: Metrics,
    http: reqwest::Client,
    all_requests: Window,
    expensive_requests: Window,
}

impl Gateway {
    /// Build a gateway over a set of upstreams.
    pub fn new(config: Config, upstreams: Vec<Upstream>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(config.upstream_timeout)
            .build()
            .expect("a default http client always builds");
        Self {
            cache: Cache::new(config.cache_capacity),
            registry: Registry::new(upstreams),
            metrics: Metrics::new(),
            http,
            all_requests: Window::new(),
            expensive_requests: Window::new(),
            config,
        }
    }

    /// The upstreams it knows about.
    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    /// Its counters.
    pub fn metrics(&self) -> &Metrics {
        &self.metrics
    }

    /// A snapshot of every upstream, for metrics and the status endpoint.
    pub fn upstream_stats(&self) -> Vec<UpstreamStat> {
        self.registry
            .all()
            .iter()
            .map(|upstream| UpstreamStat {
                name: upstream.name.clone(),
                up: upstream.health().routable(),
                forwarded: upstream.forwarded(),
                errors: upstream.errors(),
            })
            .collect()
    }

    /// Handle a raw payload: one request or a batch.
    pub async fn handle(&self, payload: &str) -> Value {
        let parsed: Value = match serde_json::from_str(payload) {
            Ok(value) => value,
            Err(_) => return error_response(Value::Null, -32700, "Parse error".into()),
        };

        match parsed {
            Value::Array(items) if items.is_empty() => {
                error_response(Value::Null, -32600, "Empty batch".into())
            }
            Value::Array(items) => {
                let mut answers = Vec::with_capacity(items.len());
                for item in items {
                    answers.push(self.handle_one(item).await);
                }
                Value::Array(answers)
            }
            single => self.handle_one(single).await,
        }
    }

    async fn handle_one(&self, request: Value) -> Value {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let Some(method) = request.get("method").and_then(Value::as_str) else {
            return error_response(id, -32600, "Request has no method".into());
        };
        let params = request.get("params").cloned().unwrap_or(json!([]));

        self.metrics.observe_method(method);

        if !self.all_requests.allow(self.config.rate_limit)
            || (is_expensive(method)
                && !self
                    .expensive_requests
                    .allow(self.config.expensive_rate_limit))
        {
            self.metrics.rate_limited.fetch_add(1, Ordering::Relaxed);
            return error_response(id, -32005, "Rate limit exceeded".into());
        }

        // A cached answer never reaches an upstream at all.
        let cache_key = cache::is_immutable(method, &params).then(|| Cache::key(method, &params));
        if let Some(key) = &cache_key
            && let Some(hit) = self.cache.get(key)
        {
            self.metrics.cache_hits.fetch_add(1, Ordering::Relaxed);
            self.metrics.ok.fetch_add(1, Ordering::Relaxed);
            return json!({"jsonrpc": "2.0", "id": id, "result": hit});
        }
        self.metrics.cache_misses.fetch_add(1, Ordering::Relaxed);

        let requirements = Requirements::for_method(method, needs_history(method, &params));
        let upstream = match self.registry.select(&requirements) {
            Ok(upstream) => upstream,
            Err(error) => {
                self.metrics.rejected.fetch_add(1, Ordering::Relaxed);
                return error_response(id, -32003, error.to_string());
            }
        };

        let started = Instant::now();
        let forwarded = self
            .http
            .post(&upstream.url)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": params,
            }))
            .send()
            .await;
        upstream.forwarded.fetch_add(1, Ordering::Relaxed);
        self.metrics
            .upstream_micros
            .fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);

        let body: Value = match forwarded {
            Ok(response) => match response.json().await {
                Ok(body) => body,
                Err(error) => {
                    upstream.errors.fetch_add(1, Ordering::Relaxed);
                    upstream.mark_probe_failed();
                    self.metrics.failed.fetch_add(1, Ordering::Relaxed);
                    return error_response(
                        id,
                        -32603,
                        format!(
                            "upstream {} returned unreadable json: {error}",
                            upstream.name
                        ),
                    );
                }
            },
            Err(error) => {
                upstream.errors.fetch_add(1, Ordering::Relaxed);
                // A failed request is evidence about health, so feed it back
                // rather than waiting for the next scheduled probe.
                upstream.mark_probe_failed();
                self.metrics.failed.fetch_add(1, Ordering::Relaxed);
                return error_response(
                    id,
                    -32003,
                    format!("upstream {} is unreachable: {error}", upstream.name),
                );
            }
        };

        if let Some(result) = body.get("result").filter(|value| !value.is_null()) {
            self.metrics.ok.fetch_add(1, Ordering::Relaxed);
            if let Some(key) = cache_key {
                self.cache.put(key, result.clone());
            }
            return json!({"jsonrpc": "2.0", "id": id, "result": result});
        }

        // An error from the node is a valid answer about the request, not
        // evidence that the node is unwell — it is passed through untouched and
        // never counted against the upstream's health.
        self.metrics.failed.fetch_add(1, Ordering::Relaxed);
        match body.get("error") {
            Some(error) => json!({"jsonrpc": "2.0", "id": id, "error": error}),
            None => json!({"jsonrpc": "2.0", "id": id, "result": Value::Null}),
        }
    }

    /// Probe every upstream once.
    pub async fn probe_once(&self) {
        for upstream in self.registry.all() {
            let alive = self
                .http
                .post(&upstream.url)
                .json(&json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "eth_chainId",
                    "params": [],
                }))
                .timeout(Duration::from_secs(2))
                .send()
                .await
                .is_ok_and(|response| response.status().is_success());

            if alive {
                upstream.mark_healthy();
            } else {
                upstream.mark_probe_failed();
            }
        }
    }

    /// Probe on a timer until cancelled.
    pub async fn probe_forever(self: Arc<Self>) {
        let mut ticker = tokio::time::interval(self.config.probe_interval);
        loop {
            ticker.tick().await;
            self.probe_once().await;
        }
    }
}

fn error_response(id: Value, code: i32, message: String) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// Serve JSON-RPC on `address` until the process ends.
/// Bind `address` and serve until the task is dropped.
///
/// Prefer [`serve_on`] when the caller wants to know that the port was actually
/// obtained: spawned into a task, a failure here is a returned error nobody
/// reads, and the program goes on to announce an address it does not hold.
pub async fn serve(gateway: Arc<Gateway>, address: SocketAddr) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(address).await?;
    serve_on(gateway, listener).await
}

/// Serve on a listener the caller has already bound.
pub async fn serve_on(
    gateway: Arc<Gateway>,
    listener: tokio::net::TcpListener,
) -> std::io::Result<()> {
    let app = Router::new()
        .route("/", post(rpc))
        .route("/metrics", get(prometheus))
        .route("/health", get(health))
        .with_state(gateway);

    axum::serve(listener, app).await
}

async fn rpc(State(gateway): State<Arc<Gateway>>, body: String) -> Response {
    let answer = gateway.handle(&body).await;
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            ),
            (
                header::ACCESS_CONTROL_ALLOW_ORIGIN,
                HeaderValue::from_static("*"),
            ),
        ],
        answer.to_string(),
    )
        .into_response()
}

async fn prometheus(State(gateway): State<Arc<Gateway>>) -> Response {
    let rendered = gateway.metrics().render(&gateway.upstream_stats());
    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; version=0.0.4"),
        )],
        rendered,
    )
        .into_response()
}

async fn health(State(gateway): State<Arc<Gateway>>) -> Response {
    let stats = gateway.upstream_stats();
    let healthy = stats.iter().filter(|stat| stat.up).count();
    let body = json!({
        "healthy": healthy,
        "total": stats.len(),
        "upstreams": stats.iter().map(|stat| json!({
            "name": stat.name,
            "up": stat.up,
            "forwarded": stat.forwarded,
            "errors": stat.errors,
        })).collect::<Vec<_>>(),
    });

    // A gateway with nothing behind it is not healthy, and a load balancer
    // in front should be told so with a status code rather than a field.
    let code = if healthy == 0 {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    };
    (code, axum::Json(body)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expensive_methods_are_recognised() {
        for method in [
            "eth_call",
            "eth_estimateGas",
            "eth_getLogs",
            "debug_traceTransaction",
            "trace_block",
        ] {
            assert!(is_expensive(method), "{method}");
        }
        for method in ["eth_blockNumber", "eth_chainId", "eth_getBalance"] {
            assert!(!is_expensive(method), "{method}");
        }
    }

    #[test]
    fn history_is_judged_from_the_block_argument() {
        // Same method, different answer, depending on the argument.
        assert!(!needs_history(
            "eth_getBalance",
            &json!(["0xabc", "latest"])
        ));
        assert!(needs_history("eth_getBalance", &json!(["0xabc", "0x5"])));

        // The block argument sits in a different position per method.
        assert!(needs_history(
            "eth_getStorageAt",
            &json!(["0xabc", "0x0", "0x5"])
        ));
        assert!(!needs_history(
            "eth_getStorageAt",
            &json!(["0xabc", "0x0", "latest"])
        ));

        // Methods with no block argument never need history.
        assert!(!needs_history("eth_blockNumber", &json!([])));
        assert!(!needs_history(
            "eth_sendRawTransaction",
            &json!(["0xdeadbeef"])
        ));
    }

    #[test]
    fn a_missing_block_argument_is_not_historical() {
        // Clients routinely omit the trailing tag, meaning `latest`.
        assert!(!needs_history("eth_getBalance", &json!(["0xabc"])));
    }

    #[test]
    fn the_window_admits_up_to_the_limit_then_refuses() {
        let window = Window::new();
        for i in 0..5 {
            assert!(window.allow(5), "request {i} should pass");
        }
        assert!(!window.allow(5), "the sixth is refused");
    }

    fn gateway() -> Gateway {
        Gateway::new(
            Config::default(),
            vec![Upstream::new("test", "http://127.0.0.1:1")],
        )
    }

    #[tokio::test]
    async fn malformed_json_is_a_parse_error() {
        let answer = gateway().handle("{not json").await;
        assert_eq!(answer["error"]["code"], -32700);
        assert_eq!(answer["id"], Value::Null);
    }

    #[tokio::test]
    async fn an_empty_batch_is_refused() {
        let answer = gateway().handle("[]").await;
        assert_eq!(answer["error"]["code"], -32600);
    }

    #[tokio::test]
    async fn a_request_without_a_method_is_refused() {
        let answer = gateway().handle(r#"{"jsonrpc":"2.0","id":1}"#).await;
        assert_eq!(answer["error"]["code"], -32600);
        assert_eq!(answer["id"], 1);
    }

    #[tokio::test]
    async fn an_unreachable_upstream_reports_itself_by_name() {
        // Nothing listens on port 1, so this exercises the transport failure
        // path rather than a protocol error.
        let gateway = gateway();
        let answer = gateway
            .handle(r#"{"jsonrpc":"2.0","id":7,"method":"eth_blockNumber","params":[]}"#)
            .await;

        assert_eq!(answer["id"], 7, "the id is echoed even on failure");
        assert_eq!(answer["error"]["code"], -32003);
        assert!(
            answer["error"]["message"]
                .as_str()
                .unwrap()
                .contains("test"),
            "the message names the upstream"
        );
        assert_eq!(gateway.registry().all()[0].errors(), 1);
    }

    #[tokio::test]
    async fn a_failed_request_counts_against_health() {
        let gateway = gateway();
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}"#;

        gateway.handle(request).await;
        gateway.handle(request).await;

        // Two failures in a row is the threshold, so the upstream drops out and
        // the next request is refused before any connection is attempted.
        assert_eq!(gateway.registry().all()[0].health(), Health::Down);
        let answer = gateway.handle(request).await;
        assert!(
            answer["error"]["message"]
                .as_str()
                .unwrap()
                .contains("no healthy upstream"),
            "got: {}",
            answer["error"]["message"]
        );
    }

    #[tokio::test]
    async fn a_batch_is_answered_in_order() {
        let gateway = gateway();
        let answer = gateway
            .handle(
                r#"[{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]},
                    {"jsonrpc":"2.0","id":2,"method":"eth_chainId","params":[]}]"#,
            )
            .await;

        let items = answer.as_array().expect("a batch answers with an array");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["id"], 1);
        assert_eq!(items[1]["id"], 2);
    }

    #[tokio::test]
    async fn the_rate_limiter_refuses_beyond_the_limit() {
        let gateway = Gateway::new(
            Config {
                rate_limit: 3,
                ..Config::default()
            },
            vec![Upstream::new("test", "http://127.0.0.1:1")],
        );
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}"#;

        for _ in 0..3 {
            gateway.handle(request).await;
        }
        let answer = gateway.handle(request).await;
        assert_eq!(answer["error"]["code"], -32005);
        assert_eq!(gateway.metrics().rate_limited.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn metrics_render_after_traffic() {
        let gateway = gateway();
        gateway
            .handle(r#"{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}"#)
            .await;

        let rendered = gateway.metrics().render(&gateway.upstream_stats());
        assert!(rendered.contains("cupel_gateway_method_total{method=\"eth_blockNumber\"} 1"));
        assert!(rendered.contains("cupel_gateway_upstream_forwarded_total{upstream=\"test\"} 1"));
    }
}
