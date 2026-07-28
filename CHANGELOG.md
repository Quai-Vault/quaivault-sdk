# Changelog

All notable changes to `@quaivault/sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
version is `0.x`, minor bumps may contain breaking changes.

## [Unreleased]

## [0.1.0] — 2026-07-28

Initial release.

### Requirements

- **Node 22 or later.** `@supabase/supabase-js` declares the same floor: it constructs a
  Realtime client eagerly and needs a global `WebSocket`, which Node 20 does not provide.

### Added

- **Client** — `connect()` with configuration resolving explicit options → environment →
  network preset. Built-in `mainnet` (chain 9) and `testnet` (Orchard, chain 15000)
  presets, including indexer credentials, so the SDK works with no configuration.
- **Vault reads** — owners, threshold, modules, DelegateCall whitelist, balances, deposits,
  token transfers, signed messages, pending transactions and history.
- **Vault writes** — the full proposal surface (native/ERC20/ERC721/ERC1155 transfers,
  batching, owner and threshold changes, module and DelegateCall management, EIP-1271
  message signing, recovery setup) plus approve, execute, revoke, cancel and expire.
- **`ExecuteResult`** — execute and approveAndExecute return a discriminated outcome
  (`executed` / `failed` / `timelock_started` / `approved_only`) classified from receipt
  logs, because a successful Quai transaction does not imply the vault transaction ran.
- **CREATE2 salt mining** — `factory.create()` mines a shard-valid salt automatically;
  `predictVaultAddress()` reproduces `predictWalletAddress` off-chain. Sync and
  `worker_threads` strategies.
- **Social recovery** — configuration, guardian checks, initiate/approve/revoke/execute/
  cancel/expire, and recovery affordances.
- **Affordances** — `vault.affordances(txHash, caller)` reports which actions are legal
  now and when blocked ones unlock, derived from the contracts' own rules.
- **Realtime** — `vault.watch()` over Supabase Realtime, one channel per vault.
- **`waitForIndexer()`** — closes the write-then-read race against the indexer.
- **Typed errors** — every error carries a stable `code`, a `remediation` string and
  `toJSON()`. Reverts are decoded against all QuaiVault ABIs (73 custom error selectors).
- **Retry** — transient RPC failures retry with exponential backoff and full jitter.
  Reads only; writes are never retried.
- **Quai-only address enforcement** — validates both zone and ledger wherever an address is
  committed to a role or receives value. Qi addresses cannot interact with contracts, and
  the vault contracts do not reject them.

### Known divergences the SDK compensates for

- Indexed approval counts are intersected with the live owner set, reproducing the
  contract's epoch-based invalidation.
- Transaction and recovery expiry are derived from timestamps rather than read from a
  stored status column.

Both were fixed indexer-side in July 2026; the SDK keeps the workarounds so it stays
correct against an un-migrated or self-hosted indexer.
