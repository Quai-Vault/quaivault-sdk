# Changelog

All notable changes to `@quaivault/sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
version is `0.x`, minor bumps may contain breaking changes.

## [Unreleased]

## [0.2.0] — 2026-07-28

A full-surface review for security, stability, efficiency, scalability and succinctness.
See [`docs/sdk-review-2026-07.md`](docs/sdk-review-2026-07.md) for the findings and the
reasoning behind each fix.

### Breaking

- `VaultTransaction.proposedAt` is `0` on indexer-sourced reads, with the block number in
  the new `proposedAtBlock`. It previously carried a block number while being documented
  and typed as Unix seconds, so anything formatting it as a date rendered 1970.
- `RecoveryModule.history()` throws `NoIndexerError` when no indexer is configured,
  instead of returning `[]`. An empty array was indistinguishable from "this vault has no
  recovery history".
- `RecoveryRequest.approvedBy` removed. It was declared but never populated by any code
  path; use `RecoveryModule.approvals(hash)`.
- `IndexerClient.raw` is now `IndexerClient.rest` and returns a `PostgrestClient`.
  Realtime moved to `IndexerClient.channel()` / `.removeChannel()`.
- `Page.total` is an estimate on large result sets rather than an exact count.
  `Page.hasMore` remains exact and is what a paging loop should use.

### Added

- `sanitizeText` — strips ANSI escapes, bidi overrides and zero-width characters from
  attacker-controlled display strings. Applied to token `symbol`/`name` and to revert
  reasons, both of which are chosen by whoever deployed the contract and both of which
  land in terminals.
- `AbortError` (code `ABORTED`) — one typed error for every abort path.
- `Vault.transactions(hashes)` — batched read that shares one owner/threshold read and
  one confirmations query across the whole set.
- `Vault.view()` and `Vault.pinned(view)` — an explicit, caller-scoped snapshot of owners
  and threshold, with a visible `capturedAt`. Write preconditions bypass it by
  construction, so a pinned view can never gate a signature.
- `TokenContract` — retrying facade for token reads, which previously bypassed the retry
  policy entirely.
- `mapPooled` / `DEFAULT_CONCURRENCY` — bounded fan-out, and a `concurrency` option on
  `balances()`.
- `createWorkerThreadsStrategy(load)` — injectable worker runtime, so the salt miner's
  fallback path is testable.
- `ZERO_ADDRESS`.

### Fixed

- `balances({ transferScanLimit })` now pages past the 200-row per-request clamp, so its
  documented default of 500 is reachable and `truncated.transfers` reflects the budget
  actually requested.
- `activeConfirmationsBatch` chunks its `in(...)` filter. A full page of hashes built a
  ~14 KB request line, past the 8 KB cap most reverse proxies apply.
- `propose.removeOwner` and `propose.changeThreshold` read owners and threshold from
  chain, restoring the documented "writes always re-validate on chain" invariant.
- The salt miner falls back to the sync strategy when a worker fails to start, rather
  than failing outright. The inlined worker resolves `quais` with a bare `require` that
  no bundler traces, so this was the default outcome in any packaged consumer.
- The indexer health probe's deadline now covers the response body, not just headers.
- `threshold()` honours the consistency setting instead of always reading chain.
- `describe()` no longer fetches the same transaction twice.
- Indexed reads no longer make a separate `indexer_state` round trip per hydration.
- `QUAIVAULT_PRIVATE_KEY` is not resolved when an explicit `signer` was supplied.

### Changed

- Depends on `@supabase/postgrest-js` and `@supabase/realtime-js` directly instead of the
  `@supabase/supabase-js` umbrella, whose constructor instantiates auth, storage and
  functions clients that nothing here uses and no bundler can remove. Measured: the full
  SDK bundle drops from 231 KB to 197 KB gzip.
- `quais` is pinned exactly. Every release is an alpha, so a range admitted unreviewed
  breaking changes on any fresh install.
- `MAX_MODULES` is now enforced in `createVault` validation, mirroring the contract's
  `MaxModulesReached`.

## [0.1.1] — 2026-07-28

No functional changes. This is the first release published through npm trusted
publishing, which exercises the release pipeline end to end and attaches a provenance
attestation linking the package to the exact commit and workflow run that built it.

`0.1.0` was published by hand to bootstrap the package, because a trusted publisher can
only be attached to a package that already exists — so it carries no attestation.

## [0.1.0] — 2026-07-28

Initial release.

### Requirements

- **Node 22 or later.** The Supabase client declares the same floor: Realtime needs a
  global `WebSocket`, which Node 20 does not provide.

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
