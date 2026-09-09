//! The control room, served from the binary.
//!
//! Two jobs. It hands out the built interface, which is compiled in rather than
//! read from disk so a release binary carries its own front end and running
//! Cupel never needs a JavaScript toolchain — the same trade the contracts
//! make, where committed bytecode means a clone needs Foundry only to *change*
//! a contract.
//!
//! And it exposes the one thing the browser cannot do for itself. Everything on
//! the page is read straight from the clients, because they all run with
//! permissive CORS; the exception is producing a block, which means talking to
//! the Engine API with a shared secret over a port bound to localhost. That is
//! this process's job, so the walkthrough asks it here.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use cupel_producer::{Head, Producer};
use rust_embed::Embed;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

/// The built interface.
///
/// `ui/dist` is committed for the reason above. It is also rebuilt and diffed
/// in CI, so a committed bundle that no longer matches its source fails there
/// rather than shipping quietly — the same check the genesis file gets.
#[derive(Embed)]
#[folder = "../../ui/dist"]
struct Assets;

/// What the page needs from this process, rather than from the chain.
#[derive(Clone)]
pub(crate) struct Control {
    /// What answers the walkthrough — in lab mode.
    ///
    /// `None` in network mode, where there is nothing for it to be. Blocks
    /// there come from sixty-four validators proposing and attesting on a
    /// schedule no one controls, and an Engine API call from this process
    /// would not join that; it would start a second chain beside it. So the
    /// endpoint says that, and the page does not offer the button.
    pub(crate) producing: Option<Producing>,
}

/// A producer kept for narrating, and the head it works from.
#[derive(Clone)]
pub(crate) struct Producing {
    /// A producer with exchange recording on. Separate from the one driving the
    /// chain: recording copies every request and response, and the loop that
    /// runs once a second should not pay for that.
    pub(crate) narrator: Arc<Producer>,
    /// The head, shared with the production loop. Both take this lock for the
    /// duration of one block, so a block asked for here and a block the loop
    /// was about to make cannot interleave and build on the same parent.
    pub(crate) head: Arc<Mutex<Head>>,
}

pub(crate) fn router(control: Control) -> Router {
    Router::new()
        .route("/api/produce", post(produce))
        .route("/api/health", get(|| async { "ok" }))
        .fallback(asset)
        .with_state(control)
}

pub(crate) async fn serve_on(listener: TcpListener, control: Control) -> Result<()> {
    axum::serve(listener, router(control))
        .await
        .context("the control room stopped serving")
}

/// Bind the control room, and say what to do if the port is taken.
pub(crate) async fn bind(address: &str) -> Result<TcpListener> {
    let socket: SocketAddr = address
        .parse()
        .with_context(|| format!("{address} is not an address"))?;
    TcpListener::bind(socket).await.with_context(|| {
        format!("could not listen on {address} — something else is using that port")
    })
}

/// Produce one block and report the calls that did it.
///
/// The lock is held across the whole sequence on purpose. Producing a block is
/// four round trips that each name the parent, and two producers working from
/// the same head would have the second one building on a block the first had
/// already replaced.
async fn produce(State(control): State<Control>) -> Response {
    let Some(producing) = control.producing else {
        return (
            StatusCode::CONFLICT,
            axum::Json(json!({ "error": NO_PRODUCER })),
        )
            .into_response();
    };
    let mut head = producing.head.lock().await;
    match producing.narrator.produce_block(&head).await {
        Ok(block) => {
            *head = block.head.clone();
            let exchanges: Vec<Value> = block
                .exchanges
                .iter()
                .map(|exchange| {
                    json!({
                        "method": exchange.method,
                        "request": exchange.request,
                        "response": exchange.response,
                        "elapsedMs": exchange.elapsed.as_secs_f64() * 1000.0,
                    })
                })
                .collect();
            axum::Json(json!({
                "block": {
                    "number": block.head.number,
                    "hash": block.head.hash,
                    "timestamp": block.head.timestamp,
                    "transactions": block.transactions,
                    "gasUsed": block.gas_used,
                },
                "exchanges": exchanges,
            }))
            .into_response()
        }
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

/// Why there is no button in network mode.
///
/// A 409 rather than a 404: the route exists and the request was understood,
/// it is the state of this process that makes it wrong.
const NO_PRODUCER: &str = "This process is fronting a devnet, and a devnet \
makes its own blocks — sixty-four validators propose and attest on a schedule \
nobody here controls. Producing one from the host would not add to that chain, \
it would start another. `cupel lab 3` and `cupel lab 4` walk through how the \
validators do it instead.";

/// Serve a compiled-in file, falling back to the page itself.
///
/// The fallback is what makes a refresh work on any path the interface routes
/// to internally: the browser asks for a URL this server has no file for, and
/// the answer is the page, which then reads the URL for itself.
async fn asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let candidate = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = Assets::get(candidate) {
        let mime = mime_guess::from_path(candidate).first_or_octet_stream();
        return ([(header::CONTENT_TYPE, mime.as_ref())], file.data).into_response();
    }
    match Assets::get("index.html") {
        Some(index) => ([(header::CONTENT_TYPE, "text/html")], index.data).into_response(),
        // Only reachable when the binary was built without the interface having
        // been built first, which CI prevents and a release never does.
        None => (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "text/html")],
            NOT_BUILT,
        )
            .into_response(),
    }
}

const NOT_BUILT: &str = "<!doctype html><meta charset=utf-8>\
<title>Cupel</title>\
<body style=\"font:15px system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem\">\
<h1 style=\"font-size:1.3rem\">The control room was not built into this binary.</h1>\
<p>Its source is in <code>ui/</code>. Build it once and rebuild Cupel:</p>\
<pre><code>npm --prefix ui ci\nnpm --prefix ui run build\ncargo build -p cupel</code></pre>\
<p>Release binaries always carry it; this only happens in a working copy where \
<code>ui/dist</code> is missing.</p>";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_interface_is_compiled_in() {
        // A binary that serves the not-built page is a binary somebody will
        // ship by accident. If `ui/dist` was missing at compile time this is
        // where it shows up, rather than in a browser.
        assert!(
            Assets::get("index.html").is_some(),
            "ui/dist/index.html was not embedded — run `npm --prefix ui run build`"
        );
    }

    #[tokio::test]
    async fn network_mode_refuses_to_produce_and_says_why() {
        // The button is hidden in network mode, so this is what a stale page or
        // a curl gets. It must not be a 500, and it must not quietly succeed by
        // building a block beside a chain sixty-four validators are agreeing
        // on — which is what an `unwrap` here would have done.
        let response = produce(State(Control { producing: None })).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("a body");
        let text = String::from_utf8_lossy(&body);
        assert!(
            text.contains("validators"),
            "the refusal should explain itself, got: {text}"
        );
    }

    #[test]
    fn the_page_names_itself() {
        let index = Assets::get("index.html").expect("embedded");
        let html = String::from_utf8_lossy(&index.data);
        assert!(
            html.contains("Cupel"),
            "the served page should say what it is"
        );
        // Vite is configured with a relative base so the assets resolve
        // wherever this server mounts them. An absolute path here would mean
        // the page loads and its script does not.
        assert!(
            !html.contains("src=\"/assets/"),
            "assets must be referenced relatively, not from the root"
        );
    }
}
