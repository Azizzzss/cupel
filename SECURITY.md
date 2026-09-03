# Security

## Cupel is a laboratory, not a production system

It is built to be experimented on, and several of its defaults would be
indefensible anywhere else. They are listed here so nobody has to discover them
the hard way.

**The private keys are published.** The development accounts are the standard
Hardhat and Anvil keys, printed on startup and committed to this repository.
They are in every wallet, every tutorial and every scraper on the internet.
Anything sent to those addresses on a real network is gone within seconds.

**Anyone may mint.** `Token.mint` has no access control at all. That is a
deliberate convenience — needing a faucet to get test tokens helps nobody — and
it means the contracts in this repository must never be deployed anywhere that
matters.

**The contracts are teaching material, not a library.** They are written to be
read and traced rather than deployed — short, heavily annotated, and without the
hardening a production implementation needs. Read the comments before copying
anything; use OpenZeppelin or Solady for real work.

**Everything binds to localhost.** The gateway, the signer, the Engine API,
Prometheus and Grafana all listen on `127.0.0.1` only. Do not change that
without understanding what each one grants:

| | What reaching it means |
|---|---|
| Engine API `:8551` | With the JWT, complete control over what the chain contains |
| Signer `:8550` | Signatures from the held key, up to whatever the policy allows |
| Gateway `:8545` | Everything an RPC endpoint can do, including sending transactions |
| Grafana `:3000` | Anonymous admin, with no login form |

**Grafana runs with anonymous admin access and no login.** On an interface bound
to localhost a password is friction with no security value; on any other
interface it is a hole.

**The Engine API secret is generated on first run** into
`config/genesis/jwt.hex` and is gitignored. `cupel reset` deletes it along with
the chain data, because a fresh chain paired with a stale token is a confusing
failure.

## The signer's policy is a mitigation, not a boundary

The policy engine bounds what a compromised *application* can do with a key it
was given. It does not protect against someone who has reached the signer
process itself, read its memory, or edited its configuration. It turns "the key
is gone" into "the key moved at most the budget before the window closed", which
is worth having and is not the same as safety.

## Reporting something

This is a personal project with no users to protect, so there is no embargo
process and no security contact. If you find something wrong, please open an
issue — including for problems in the contracts, which are exactly the kind of
thing this repository exists to talk about.

If you find a way the *lab itself* could harm someone running it — something
that reaches beyond localhost, writes outside the repository, or exfiltrates a
key — that is worth flagging directly rather than in a public issue.
