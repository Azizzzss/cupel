//! The record of what was asked for and what was decided.
//!
//! Approvals are logged as well as refusals. A log holding only refusals
//! answers "what was blocked", and after an incident the question is always
//! "what was signed" — which such a log cannot answer at all.
//!
//! Entries are one JSON object per line: greppable by hand, and parseable
//! without a schema by anything that wants to ship them somewhere.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::policy::{Decision, SigningRequest};

/// An append-only record of signing decisions.
#[derive(Debug)]
pub struct AuditLog {
    file: Option<Mutex<File>>,
    /// Also print to standard output, so a decision is visible in the terminal
    /// the moment it happens rather than only in a file nobody opens.
    echo: bool,
    entries: Mutex<Vec<Value>>,
}

impl AuditLog {
    /// A log that writes to `path` and echoes to standard output.
    ///
    /// Opened in append mode: a signer restart must never truncate the history
    /// of what it signed.
    pub fn to_file(path: &Path) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Self {
            file: Some(Mutex::new(file)),
            echo: true,
            entries: Mutex::new(Vec::new()),
        })
    }

    /// A log kept only in memory, for tests.
    pub fn in_memory() -> Self {
        Self {
            file: None,
            echo: false,
            entries: Mutex::new(Vec::new()),
        }
    }

    /// Record a decision.
    pub fn record(&self, request: &SigningRequest, decision: &Decision, hash: Option<&str>) {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or_default();

        let entry = json!({
            "time": seconds,
            "decision": match decision {
                Decision::Approved => "approved",
                Decision::Refused(_) => "refused",
            },
            "reason": match decision {
                Decision::Approved => Value::Null,
                Decision::Refused(refusal) => json!(refusal.to_string()),
            },
            "from": request.from.to_string(),
            "to": match request.to {
                Some(to) => json!(to.to_string()),
                None => json!("create"),
            },
            "value": request.value.to_string(),
            "gas": request.gas_limit,
            "data_len": request.data.len(),
            "hash": hash,
        });

        if self.echo {
            match decision {
                Decision::Approved => println!("  signer: approved {entry}"),
                Decision::Refused(refusal) => println!("  signer: REFUSED {refusal}"),
            }
        }

        if let Some(file) = &self.file
            && let Ok(mut file) = file.lock()
        {
            // A failed write must not stop the service, but it must not be
            // silent either: a signer that cannot record what it signed is
            // operating without an audit trail and somebody should know.
            if let Err(error) = writeln!(file, "{entry}") {
                eprintln!("  signer: could not write the audit log: {error}");
            }
            let _ = file.flush();
        }

        if let Ok(mut entries) = self.entries.lock() {
            // Bounded, so a long-running signer does not grow without limit.
            // The file is the durable record; this is only for the API.
            if entries.len() >= 1_000 {
                entries.remove(0);
            }
            entries.push(entry);
        }
    }

    /// The most recent entries, newest last.
    pub fn recent(&self, limit: usize) -> Vec<Value> {
        let Ok(entries) = self.entries.lock() else {
            return Vec::new();
        };
        let start = entries.len().saturating_sub(limit);
        entries[start..].to_vec()
    }

    /// How many decisions have been recorded in memory.
    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .map(|entries| entries.len())
            .unwrap_or(0)
    }

    /// Whether nothing has been recorded.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::Refusal;
    use alloy::primitives::{Address, U256};

    fn request() -> SigningRequest {
        SigningRequest {
            from: Address::from([1u8; 20]),
            to: Some(Address::from([2u8; 20])),
            value: U256::from(1000u64),
            gas_limit: 21_000,
            data: vec![1, 2, 3],
        }
    }

    #[test]
    fn an_approval_is_recorded_not_just_a_refusal() {
        // After an incident the question is what was signed, and a log holding
        // only refusals cannot answer it.
        let log = AuditLog::in_memory();
        log.record(&request(), &Decision::Approved, Some("0xdead"));

        let entries = log.recent(10);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["decision"], "approved");
        assert_eq!(entries[0]["hash"], "0xdead");
        assert_eq!(entries[0]["reason"], Value::Null);
    }

    #[test]
    fn a_refusal_carries_the_reason_as_text() {
        let log = AuditLog::in_memory();
        let refusal = Refusal::ValueTooHigh {
            requested: U256::from(2000u64),
            ceiling: U256::from(1000u64),
        };
        log.record(&request(), &Decision::Refused(refusal), None);

        let entries = log.recent(10);
        assert_eq!(entries[0]["decision"], "refused");
        assert!(
            entries[0]["reason"]
                .as_str()
                .unwrap()
                .contains("exceeds the ceiling")
        );
        assert_eq!(entries[0]["hash"], Value::Null, "nothing was signed");
    }

    #[test]
    fn a_creation_is_recorded_as_such() {
        let log = AuditLog::in_memory();
        let mut deploy = request();
        deploy.to = None;
        log.record(&deploy, &Decision::Approved, None);

        assert_eq!(log.recent(1)[0]["to"], "create");
    }

    #[test]
    fn entries_carry_the_fields_an_investigation_needs() {
        let log = AuditLog::in_memory();
        log.record(&request(), &Decision::Approved, None);
        let entry = &log.recent(1)[0];

        for field in ["time", "decision", "from", "to", "value", "gas", "data_len"] {
            assert!(entry.get(field).is_some(), "missing {field}");
        }
        assert_eq!(entry["value"], "1000", "the amount, exactly");
        assert_eq!(entry["gas"], 21_000);
        assert_eq!(entry["data_len"], 3);
    }

    #[test]
    fn the_in_memory_view_is_bounded() {
        let log = AuditLog::in_memory();
        for _ in 0..1_200 {
            log.record(&request(), &Decision::Approved, None);
        }
        assert!(log.len() <= 1_000, "grew to {}", log.len());
    }

    #[test]
    fn recent_returns_the_newest_and_never_over_reads() {
        let log = AuditLog::in_memory();
        log.record(&request(), &Decision::Approved, Some("0x01"));
        log.record(&request(), &Decision::Approved, Some("0x02"));

        assert_eq!(log.recent(1)[0]["hash"], "0x02", "newest last");
        assert_eq!(
            log.recent(50).len(),
            2,
            "asking for more than exists is fine"
        );
    }

    #[test]
    fn a_file_log_appends_rather_than_truncating() {
        let directory = std::env::temp_dir().join(format!("cupel-audit-{}", std::process::id()));
        let path = directory.join("audit.log");
        let _ = std::fs::remove_file(&path);

        {
            let log = AuditLog::to_file(&path).expect("open");
            log.record(&request(), &Decision::Approved, None);
        }
        {
            // A restart must not erase what was signed before it.
            let log = AuditLog::to_file(&path).expect("reopen");
            log.record(&request(), &Decision::Approved, None);
        }

        let written = std::fs::read_to_string(&path).expect("read back");
        assert_eq!(written.lines().count(), 2, "both runs are present");
        // Each line stands alone as JSON.
        for line in written.lines() {
            serde_json::from_str::<Value>(line).expect("each line parses");
        }
        let _ = std::fs::remove_dir_all(&directory);
    }
}
