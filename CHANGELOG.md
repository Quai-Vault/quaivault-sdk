# Changelog

All notable changes to `@quaivault/sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
version is `0.x`, minor bumps may contain breaking changes.

## [Unreleased]

Caller-supplied ABIs for `decodeCall`, so proposals targeting contracts the SDK does not
ship get a real description instead of a bare selector. Reasoning, and why network
resolution was left out, in [`docs/design-abi-resolution.md`](docs/design-abi-resolution.md).

### Added

- **`ClientOptions.abis`** and **`DecodeContext.abis`** — an `AbiLookup`, keyed by address.
  Address-keyed rather than a list to try: attempting a pile of ABIs against arbitrary
  calldata until one parses is how a call gets confidently decoded as the wrong thing.
  Synchronous, because `decodeCall` is pure and runs per row across a whole history page.
- **`abiRegistry(entries)`** — builds a lookup from an address-keyed object, matching
  case-insensitively.
- **`DecodedCall.selector`** — the call's 4 bytes, surfaced so a reviewer can check the
  claimed function against a source other than the one making the claim. That is the only
  defence against a colliding selector in a supplied ABI, which the SDK cannot detect.
- **`AbiSource`** and **`AbiLookup`** types.

### Changed

- **`DecodeResult` and `VaultTransaction` carry `abiSource`** — `builtin`, `supplied` or
  `none`. Required, not optional: in a multisig the summary is what owners read before
  approving, so a decode backed by an ABI a stranger supplied must not render identically
  to one the SDK vouches for.

  Supplied ABIs are consulted after every built-in match — they cannot change how a vault
  self-call or a known module call is read — and before the token selector heuristics,
  which identify a call by selector shape alone and will read anything exposing
  `transfer(address,uint256)` as an ERC20.

  Technically breaking for anyone *constructing* a `DecodeResult` or `VaultTransaction`;
  purely additive for anyone reading one.
- A malformed ABI, or a lookup that throws, degrades that row to `abiSource: 'none'` rather
  than failing the surrounding page.

## [0.3.0] — 2026-07-29

**No functional change over `0.2.1`.** The code is byte-for-byte identical; only the version
differs.

`0.2.1` was cut as a patch, but it added public API surface — `ClientOptions.now`, the
`Clock` type, `QuaiVaultClient.now`, `Vault.hasApproved()`, and an `at?` parameter on both
`affordances()` methods. Under semver that is a minor. Nothing in `0.2.1` is unsafe to
upgrade into and its changelog describes it accurately, but a patch version understates what
arrived, and anyone pinning with `~0.2.1` would not receive it as an addition.

This release exists to put the correct signal on that surface. `0.2.1` remains published and
working; there is nothing to migrate. Read the `0.2.1` entry below for what actually changed.

## [0.2.1] — 2026-07-28

Answers the CLI team's [clock-offset request](docs/request-clock-offset.md); the reasoning,
including where we implemented something different from what was asked, is in
[`docs/response-clock-offset.md`](docs/response-clock-offset.md). Additive only — no
breaking changes.

### Fixed

- **`classifyExecution` no longer consults the local clock.** It discriminated
  `timelock_started` from `approved_only` by comparing `executableAfter` against
  `Date.now()`. That is a proxy that holds only while local clock skew stays smaller than
  the execution delay, so a vault with a 60-second timelock misreported under two minutes
  of drift while one with a 24-hour timelock never did — same code, silently different
  reliability. It now compares `executableAfter` against `approvedAt`, both carried by the
  same `ThresholdReached` event under one `block.timestamp`, which answers the question
  exactly and cannot be defeated by a wrong clock.

  The existing tests could not catch this: their fixtures were anchored to `Date.now()`, so
  they agreed with the clock-based implementation by construction. The new cases use
  timestamps decades away from the local clock in both directions.

### Added

- **`ClientOptions.now?: Clock`** — supply the source of "now", in Unix seconds, for
  decisions compared against chain timestamps. Defaults to the local clock; no behaviour
  change when unset. A function rather than a scalar offset, because an offset needs a sign
  convention and getting it backwards doubles the error silently.

  Threaded into every absolute-time site: transaction and recovery status derivation,
  affordances, recovery preconditions, `minimumExpiration`, `view().capturedAt`, and
  `waitForExecutable`'s comparison against `executableAfter`.

  **Not** applied to elapsed-time arithmetic — retry backoff, salt-mining timeouts, poll
  deadlines and cache TTLs stay on the raw local clock, since offsetting a duration is
  meaningless. The split is documented at each site.
- **`Vault.hasApproved(txHash, owner)`** — now public. It is one of the two inputs
  `computeAffordances` needs, and its absence meant a consumer wanting affordances at an
  adjusted time had no way to assemble an `AffordanceContext` without reimplementing the
  method against the raw contract.
- **`at?: number`** on `Vault.affordances()` and `RecoveryModule.affordances()`, overriding
  the configured clock per call.
- **`Clock`** type export, and `QuaiVaultClient.now`.

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
