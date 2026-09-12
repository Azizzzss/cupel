//! What a held key is allowed to sign.
//!
//! A key sitting in a service is only as safe as the code around it. If the
//! service can sign anything, then anyone who reaches the service can move
//! everything, and the key may as well be in the application's own memory.
//! A policy makes the difference between "this process was compromised" and
//! "this process was compromised and could still only send 1 ETH to two known
//! addresses before the rate limit stopped it".
//!
//! Every decision here is recorded, approvals included. An audit log that only
//! holds refusals answers "what was blocked" and not "what was signed", and the
//! second question is the one asked after an incident.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use alloy::primitives::{Address, U256};

/// A request to sign something.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SigningRequest {
    /// The account being asked to sign.
    pub from: Address,
    /// The recipient, or `None` for a contract creation.
    pub to: Option<Address>,
    /// Wei being sent.
    pub value: U256,
    /// Gas limit requested.
    pub gas_limit: u64,
    /// The most the sender will pay per unit of gas, tip included.
    ///
    /// Part of what is evaluated, not only of what is signed. It used to go
    /// straight to the signature without the policy ever seeing it, so the
    /// spending budget — described everywhere as what bounds the total loss —
    /// counted value alone, and a caller could spend the key on fees without
    /// limit.
    pub max_fee_per_gas: u128,
    /// Calldata.
    pub data: Vec<u8>,
}

impl SigningRequest {
    /// The most this transaction can take from the key: its value, plus its
    /// whole gas limit paid at its maximum fee.
    ///
    /// The real charge is usually lower — unused gas is refunded and the base
    /// fee is often below the cap — but a budget has to be counted against the
    /// worst case, or it bounds nothing.
    pub fn most_it_can_cost(&self) -> U256 {
        let fees = U256::from(self.gas_limit).saturating_mul(U256::from(self.max_fee_per_gas));
        self.value.saturating_add(fees)
    }
}

/// Why a request was refused.
///
/// Each is a distinct reason rather than one message, so the audit log can be
/// searched and the dashboard can count them by kind.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    /// The service does not hold this key.
    #[error("no key held for {0}")]
    UnknownSigner(Address),
    /// Over the per-transaction value ceiling.
    #[error("value {requested} exceeds the ceiling of {ceiling} wei")]
    ValueTooHigh {
        /// What was asked for.
        requested: U256,
        /// What is allowed.
        ceiling: U256,
    },
    /// Over the gas ceiling.
    #[error("gas limit {requested} exceeds the ceiling of {ceiling}")]
    GasTooHigh {
        /// What was asked for.
        requested: u64,
        /// What is allowed.
        ceiling: u64,
    },
    /// The recipient is not on the allowlist.
    #[error("{0} is not an approved recipient")]
    RecipientNotAllowed(Address),
    /// The recipient is explicitly blocked.
    #[error("{0} is blocked")]
    RecipientDenied(Address),
    /// Deploying is not permitted for this key.
    #[error("this key may not deploy contracts")]
    ContractCreationNotAllowed,
    /// Too many requests in the current window.
    #[error("rate limit reached: {limit} signatures per {window_seconds}s")]
    RateLimited {
        /// Signatures allowed per window.
        limit: u32,
        /// Length of the window.
        window_seconds: u64,
    },
    /// The window's total spend would be exceeded.
    #[error("spending {requested} would exceed the {window_seconds}s budget; {remaining} wei left")]
    BudgetExceeded {
        /// What was asked for.
        requested: U256,
        /// What is left in the window.
        remaining: U256,
        /// Length of the window.
        window_seconds: u64,
    },
}

/// The outcome of evaluating a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// May be signed.
    Approved,
    /// Must not be signed.
    Refused(Refusal),
}

impl Decision {
    /// Whether signing may proceed.
    pub fn approved(&self) -> bool {
        matches!(self, Self::Approved)
    }
}

/// The rules a key is held under.
#[derive(Debug, Clone)]
pub struct Policy {
    /// Largest value a single transaction may carry.
    pub max_value: U256,
    /// Largest gas limit a single transaction may request.
    pub max_gas: u64,
    /// If set, the only recipients permitted.
    pub allowed_recipients: Option<HashSet<Address>>,
    /// Recipients that are always refused, checked before the allowlist.
    pub denied_recipients: HashSet<Address>,
    /// Whether this key may deploy contracts.
    pub allow_contract_creation: bool,
    /// Signatures permitted per window.
    pub max_per_window: u32,
    /// Total value permitted per window.
    pub max_value_per_window: U256,
    /// Length of the window.
    pub window: Duration,
}

impl Default for Policy {
    /// A deliberately tight default.
    ///
    /// A signer whose default is permissive is one that ships permissive,
    /// because nobody tightens a policy that has not yet caused a problem.
    fn default() -> Self {
        Self {
            max_value: U256::from(10u64).pow(U256::from(18u64)), // 1 ether
            max_gas: 500_000,
            allowed_recipients: None,
            denied_recipients: HashSet::new(),
            allow_contract_creation: false,
            max_per_window: 10,
            max_value_per_window: U256::from(5u64) * U256::from(10u64).pow(U256::from(18u64)),
            window: Duration::from_secs(60),
        }
    }
}

/// What has been signed recently, for the windowed limits.
#[derive(Debug)]
struct Window {
    started: Instant,
    count: u32,
    spent: U256,
}

/// Applies a [`Policy`] and remembers enough to enforce the windowed rules.
#[derive(Debug)]
pub struct PolicyEngine {
    policy: Policy,
    window: std::sync::Mutex<Window>,
}

impl PolicyEngine {
    /// Build an engine, starting its window now.
    pub fn new(policy: Policy) -> Self {
        Self::starting_at(policy, Instant::now())
    }

    /// Build an engine with an explicit start, so tests control the clock.
    pub fn starting_at(policy: Policy, now: Instant) -> Self {
        Self {
            policy,
            window: std::sync::Mutex::new(Window {
                started: now,
                count: 0,
                spent: U256::ZERO,
            }),
        }
    }

    /// The rules in force.
    pub fn policy(&self) -> &Policy {
        &self.policy
    }

    /// Decide whether a request may be signed, and record it if so.
    pub fn evaluate(&self, request: &SigningRequest, held: &HashSet<Address>) -> Decision {
        self.evaluate_at(request, held, Instant::now())
    }

    /// Decide at a given moment.
    ///
    /// Checks run cheapest-first and, more importantly, most-specific-first: a
    /// blocked recipient should be reported as blocked even when the amount
    /// would also have failed, because that is the more useful line in an audit
    /// log.
    pub fn evaluate_at(
        &self,
        request: &SigningRequest,
        held: &HashSet<Address>,
        now: Instant,
    ) -> Decision {
        if !held.contains(&request.from) {
            return Decision::Refused(Refusal::UnknownSigner(request.from));
        }

        match request.to {
            None if !self.policy.allow_contract_creation => {
                return Decision::Refused(Refusal::ContractCreationNotAllowed);
            }
            Some(to) => {
                // Denial beats permission: an address on both lists is refused.
                if self.policy.denied_recipients.contains(&to) {
                    return Decision::Refused(Refusal::RecipientDenied(to));
                }
                if let Some(allowed) = &self.policy.allowed_recipients
                    && !allowed.contains(&to)
                {
                    return Decision::Refused(Refusal::RecipientNotAllowed(to));
                }
            }
            None => {}
        }

        if request.value > self.policy.max_value {
            return Decision::Refused(Refusal::ValueTooHigh {
                requested: request.value,
                ceiling: self.policy.max_value,
            });
        }

        if request.gas_limit > self.policy.max_gas {
            return Decision::Refused(Refusal::GasTooHigh {
                requested: request.gas_limit,
                ceiling: self.policy.max_gas,
            });
        }

        let Ok(mut window) = self.window.lock() else {
            // A poisoned lock means a previous evaluation panicked, and the
            // recorded spend can no longer be trusted. Refusing is the only
            // safe answer.
            return Decision::Refused(Refusal::RateLimited {
                limit: self.policy.max_per_window,
                window_seconds: self.policy.window.as_secs(),
            });
        };

        if now.duration_since(window.started) >= self.policy.window {
            window.started = now;
            window.count = 0;
            window.spent = U256::ZERO;
        }

        if window.count >= self.policy.max_per_window {
            return Decision::Refused(Refusal::RateLimited {
                limit: self.policy.max_per_window,
                window_seconds: self.policy.window.as_secs(),
            });
        }

        let cost = request.most_it_can_cost();
        let would_spend = window.spent.saturating_add(cost);
        if would_spend > self.policy.max_value_per_window {
            return Decision::Refused(Refusal::BudgetExceeded {
                requested: cost,
                remaining: self
                    .policy
                    .max_value_per_window
                    .saturating_sub(window.spent),
                window_seconds: self.policy.window.as_secs(),
            });
        }

        // Only an approval consumes budget. A refused request must not count
        // against the caller, or a flood of rejected requests becomes a way to
        // deny service to legitimate ones.
        window.count += 1;
        window.spent = would_spend;
        Decision::Approved
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(byte: u8) -> Address {
        Address::from([byte; 20])
    }

    fn held() -> HashSet<Address> {
        HashSet::from([address(1)])
    }

    fn ether(n: u64) -> U256 {
        U256::from(n) * U256::from(10u64).pow(U256::from(18u64))
    }

    /// A request whose cost is exactly its value.
    ///
    /// The fee is zero so the tests below keep testing what they are named for —
    /// the value ceiling, the count, the budget arithmetic — with round numbers.
    /// That fees count is tested on its own, further down.
    fn request(value: U256) -> SigningRequest {
        SigningRequest {
            from: address(1),
            to: Some(address(2)),
            value,
            gas_limit: 21_000,
            max_fee_per_gas: 0,
            data: Vec::new(),
        }
    }

    #[test]
    fn an_ordinary_request_is_approved() {
        let engine = PolicyEngine::new(Policy::default());
        assert_eq!(
            engine.evaluate(&request(ether(1)), &held()),
            Decision::Approved
        );
    }

    #[test]
    fn the_default_policy_is_tight() {
        // A signer whose default is permissive ships permissive.
        let policy = Policy::default();
        assert!(!policy.allow_contract_creation, "no deploying by default");
        assert_eq!(
            policy.max_value,
            ether(1),
            "a modest per-transaction ceiling"
        );
        assert!(policy.max_per_window <= 10, "a modest rate");
    }

    #[test]
    fn a_key_the_service_does_not_hold_is_refused() {
        let engine = PolicyEngine::new(Policy::default());
        let mut stranger = request(ether(1));
        stranger.from = address(9);

        assert_eq!(
            engine.evaluate(&stranger, &held()),
            Decision::Refused(Refusal::UnknownSigner(address(9)))
        );
    }

    #[test]
    fn value_over_the_ceiling_is_refused_with_both_numbers() {
        let engine = PolicyEngine::new(Policy::default());
        // The audit line has to say what was asked for as well as what was
        // allowed, or it cannot be acted on.
        assert_eq!(
            engine.evaluate(&request(ether(2)), &held()),
            Decision::Refused(Refusal::ValueTooHigh {
                requested: ether(2),
                ceiling: ether(1),
            })
        );
    }

    #[test]
    fn the_ceiling_is_inclusive() {
        let engine = PolicyEngine::new(Policy::default());
        assert!(
            engine.evaluate(&request(ether(1)), &held()).approved(),
            "exactly at the limit is allowed"
        );
    }

    #[test]
    fn an_excessive_gas_limit_is_refused() {
        let engine = PolicyEngine::new(Policy::default());
        let mut greedy = request(U256::ZERO);
        greedy.gas_limit = 30_000_000;

        assert_eq!(
            engine.evaluate(&greedy, &held()),
            Decision::Refused(Refusal::GasTooHigh {
                requested: 30_000_000,
                ceiling: 500_000,
            })
        );
    }

    #[test]
    fn contract_creation_is_refused_unless_permitted() {
        let engine = PolicyEngine::new(Policy::default());
        let mut deploy = request(U256::ZERO);
        deploy.to = None;

        assert_eq!(
            engine.evaluate(&deploy, &held()),
            Decision::Refused(Refusal::ContractCreationNotAllowed)
        );

        let permissive = PolicyEngine::new(Policy {
            allow_contract_creation: true,
            ..Policy::default()
        });
        assert!(permissive.evaluate(&deploy, &held()).approved());
    }

    #[test]
    fn an_allowlist_excludes_everyone_else() {
        let engine = PolicyEngine::new(Policy {
            allowed_recipients: Some(HashSet::from([address(2)])),
            ..Policy::default()
        });

        assert!(engine.evaluate(&request(ether(1)), &held()).approved());

        let mut elsewhere = request(ether(1));
        elsewhere.to = Some(address(3));
        assert_eq!(
            engine.evaluate(&elsewhere, &held()),
            Decision::Refused(Refusal::RecipientNotAllowed(address(3)))
        );
    }

    #[test]
    fn denial_beats_permission() {
        // An address on both lists must be refused. The opposite ordering means
        // adding an address to the blocklist silently does nothing whenever it
        // is also on the allowlist.
        let engine = PolicyEngine::new(Policy {
            allowed_recipients: Some(HashSet::from([address(2)])),
            denied_recipients: HashSet::from([address(2)]),
            ..Policy::default()
        });

        assert_eq!(
            engine.evaluate(&request(ether(1)), &held()),
            Decision::Refused(Refusal::RecipientDenied(address(2)))
        );
    }

    #[test]
    fn a_blocked_recipient_is_reported_as_blocked_not_as_too_expensive() {
        // Both rules would refuse this. The recipient is the more useful line
        // in an audit log, so it must win.
        let engine = PolicyEngine::new(Policy {
            denied_recipients: HashSet::from([address(2)]),
            ..Policy::default()
        });

        assert_eq!(
            engine.evaluate(&request(ether(500)), &held()),
            Decision::Refused(Refusal::RecipientDenied(address(2)))
        );
    }

    #[test]
    fn the_rate_limit_stops_a_flood() {
        let engine = PolicyEngine::new(Policy {
            max_per_window: 3,
            max_value_per_window: ether(1000),
            ..Policy::default()
        });

        for i in 0..3 {
            assert!(
                engine.evaluate(&request(ether(1)), &held()).approved(),
                "request {i}"
            );
        }
        assert_eq!(
            engine.evaluate(&request(ether(1)), &held()),
            Decision::Refused(Refusal::RateLimited {
                limit: 3,
                window_seconds: 60,
            })
        );
    }

    #[test]
    fn the_window_resets_when_it_expires() {
        let start = Instant::now();
        let engine = PolicyEngine::starting_at(
            Policy {
                max_per_window: 1,
                max_value_per_window: ether(1000),
                window: Duration::from_secs(60),
                ..Policy::default()
            },
            start,
        );

        assert!(
            engine
                .evaluate_at(&request(ether(1)), &held(), start)
                .approved()
        );
        assert!(
            !engine
                .evaluate_at(&request(ether(1)), &held(), start + Duration::from_secs(30))
                .approved(),
            "still inside the window"
        );
        assert!(
            engine
                .evaluate_at(&request(ether(1)), &held(), start + Duration::from_secs(61))
                .approved(),
            "the window rolled over"
        );
    }

    #[test]
    fn the_window_has_a_spending_budget_as_well_as_a_count() {
        // A rate limit alone permits ten transactions of the maximum size; the
        // budget is what bounds the total loss.
        let engine = PolicyEngine::new(Policy {
            max_value: ether(1),
            max_per_window: 100,
            max_value_per_window: ether(2),
            ..Policy::default()
        });

        assert!(engine.evaluate(&request(ether(1)), &held()).approved());
        assert!(engine.evaluate(&request(ether(1)), &held()).approved());

        assert_eq!(
            engine.evaluate(&request(ether(1)), &held()),
            Decision::Refused(Refusal::BudgetExceeded {
                requested: ether(1),
                remaining: U256::ZERO,
                window_seconds: 60,
            })
        );
    }

    #[test]
    fn fees_count_against_the_budget_not_only_value() {
        // A zero-value transaction is not free: the key pays for its gas. The
        // budget counted value alone, so any number of these, each at a fee the
        // caller chose, fitted inside a budget of one wei.
        let engine = PolicyEngine::new(Policy {
            max_gas: 1_000_000,
            max_per_window: 100,
            max_value_per_window: ether(1),
            ..Policy::default()
        });
        let expensive = SigningRequest {
            value: U256::ZERO,
            gas_limit: 1_000_000,
            // 1,000,000 gas at 600 gwei is 0.6 ether of worst-case fees.
            max_fee_per_gas: 600_000_000_000,
            ..request(U256::ZERO)
        };
        assert_eq!(
            expensive.most_it_can_cost(),
            U256::from(600_000_000_000_000_000u128)
        );

        assert!(engine.evaluate(&expensive, &held()).approved());
        assert!(matches!(
            engine.evaluate(&expensive, &held()),
            Decision::Refused(Refusal::BudgetExceeded { .. })
        ));
    }

    #[test]
    fn the_budget_refusal_says_how_much_is_left() {
        let engine = PolicyEngine::new(Policy {
            max_value: ether(10),
            max_per_window: 100,
            max_value_per_window: ether(3),
            ..Policy::default()
        });
        engine.evaluate(&request(ether(1)), &held());

        assert_eq!(
            engine.evaluate(&request(ether(10)), &held()),
            Decision::Refused(Refusal::BudgetExceeded {
                requested: ether(10),
                remaining: ether(2),
                window_seconds: 60,
            })
        );
    }

    #[test]
    fn a_refused_request_does_not_consume_the_budget() {
        // Otherwise a flood of rejected requests becomes a way to deny service
        // to legitimate ones.
        let engine = PolicyEngine::new(Policy {
            max_value: ether(1),
            max_per_window: 2,
            max_value_per_window: ether(10),
            ..Policy::default()
        });

        for _ in 0..20 {
            // Over the per-transaction ceiling, so refused every time.
            assert!(!engine.evaluate(&request(ether(5)), &held()).approved());
        }
        // The allowance is untouched.
        assert!(engine.evaluate(&request(ether(1)), &held()).approved());
        assert!(engine.evaluate(&request(ether(1)), &held()).approved());
    }

    #[test]
    fn refusals_read_as_sentences() {
        // These strings end up in an audit log a human reads under pressure.
        let refusal = Refusal::ValueTooHigh {
            requested: ether(2),
            ceiling: ether(1),
        };
        assert!(refusal.to_string().contains("exceeds the ceiling"));

        assert!(
            Refusal::ContractCreationNotAllowed
                .to_string()
                .contains("may not deploy")
        );
        assert!(
            Refusal::RateLimited {
                limit: 3,
                window_seconds: 60
            }
            .to_string()
            .contains("3 signatures per 60s")
        );
    }
}
