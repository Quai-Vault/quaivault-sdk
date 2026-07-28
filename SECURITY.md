# Security Policy

## Reporting a vulnerability

Email **security@quaivault.org**. Please do not open a public issue for a security report.

Include enough detail to reproduce: affected version, the call sequence, and the impact you
believe it has. We will acknowledge receipt and keep you updated on remediation.

## Scope

This policy covers the `@quaivault/sdk` package. Vulnerabilities in the QuaiVault contracts
themselves, the indexer, or the web application should be reported through the same address
and will be routed appropriately.

## What is not a vulnerability

**The indexer publishable key shipped in the network presets is public by design.** The
indexer's row-level security grants the `anon` role `SELECT` and nothing else; every write
is reserved for `service_role`. The key exposes only chain data that is already public.
Reports that it is "leaked" will be closed as intended behaviour.

## Security properties this SDK relies on

If you are auditing an integration, these are the assumptions worth checking:

- **Writes re-validate on chain.** Indexed data never gates a signature. Approval counts
  used for a write decision are read from the chain, not the database.
- **Reads are retried, writes are not.** Retrying a write risks a double broadcast, since a
  transaction that timed out client-side may already be in the mempool.
- **Private keys are consumed once.** The key builds a signer and is not retained on the
  client; `client.config` is a redacted view and is safe to log.
- **Qi addresses are rejected** wherever an address is committed to a role or receives
  value. A Qi owner can never sign, and the contracts do not check for this.

## Supported versions

While the SDK is `0.x`, only the latest published version receives security fixes.
