# SDK review — July 2026

Full-surface review of `@quaivault/sdk` at v0.1.1 for security, stability, efficiency,
scalability and succinctness, carried out while the CLI was being built against it.

Baseline at time of review: `npm run typecheck`, `npm run lint` and `npm test` (163 tests,
12 files) all pass clean.

Findings are numbered for reference from commit messages and the task list. Severity:

- **P0** — correctness. Produces wrong answers or fails outright under normal use.
- **P1** — security and robustness. Wrong behaviour under hostile or degraded conditions.
- **P2** — efficiency and scalability. Correct, but costs more than it should.
- **P3** — succinctness and consistency. No behavioural impact.

---

## P0 — Correctness

### 1. `transferScanLimit` is silently clamped to 200

`src/balances.ts:79` defaults `transferScanLimit` to 500 and passes it straight to
`queries.tokenTransfers`. `bounds()` in `src/indexer/queries.ts:38` clamps every limit to
`MAX_LIMIT = 200`. The documented default is therefore unreachable.

Worse, `truncated.transfers` is derived from `transfers.hasMore` on the *clamped* page, so
the "we told you the result was incomplete" guarantee is computed off the wrong window. A
vault with 201–500 transfers reports truncation it could have avoided; the option's
contract is a fiction.

**Fix:** page internally until the caller's scan budget is spent, rather than issuing one
clamped request, and report truncation against the budget the caller actually asked for.

### 2. `VaultTransaction.proposedAt` means two different things

`types.ts:155` documents it as "Unix seconds when the proposal was recorded on chain".

- Chain path (`src/vault.ts:451`): `Number(raw.timestamp ?? 0)` — Unix seconds. Correct.
- Indexer path (`src/vault.ts:385`): `toNumber(row.submitted_at_block)` — a **block number**.

Any consumer formatting this as a date prints 1970 for indexed reads, which is every read
under the default `auto` consistency while the indexer is healthy.

**Fix:** add a distinct `proposedAtBlock` field and populate `proposedAt` only where a real
timestamp exists.

### 3. `activeConfirmationsBatch` builds an unbounded `IN` clause

`src/indexer/queries.ts:161` places every transaction hash into a PostgREST `in(...)`
filter on a GET request. Each hash contributes ~68 characters of query string; at
`MAX_LIMIT = 200` that is roughly 14 KB, past the 8 KB request-line cap that most reverse
proxies apply by default.

`pendingTransactions({ limit: 200 })` therefore returns a 414 rather than data — and it
does so only on vaults busy enough to have that many pending transactions, which is exactly
where it matters.

**Fix:** chunk to ~50 hashes per request and merge the results.

### 4. Write-path preconditions read through the indexer

`propose.removeOwner` (`src/vault.ts:629`) and `propose.changeThreshold`
(`src/vault.ts:643`) call `this.owners()`, which prefers the indexer under `auto`.

This contradicts the invariant the SDK states in `types.ts:52-57` and in the README —
that writes always re-validate against the chain — and it is load-bearing: a lagging
indexer can reject a valid `removeOwner` or admit one that leaves the vault below its
threshold, which the caller then discovers as an on-chain revert.

**Fix:** use chain reads in both paths.

---

## P1 — Security and robustness

### 5. Token metadata flows unsanitised into display strings

`src/balances.ts:146-148` returns `meta.symbol` and `meta.name` verbatim from the indexer.
Token metadata is attacker-controlled: anyone can deploy an ERC20 whose `symbol()` contains
ANSI escape sequences, bidirectional-override characters, or homoglyphs, and transfer one
unit to a vault to get it indexed.

In a browser this is inert. In a terminal it is not — ANSI escapes can rewrite earlier
lines, hide text, or forge what looks like SDK output. This is the finding with the most
direct bearing on the CLI.

**Fix:** sanitise at the SDK boundary — strip C0/C1 control characters and bidi marks, cap
length — so every consumer inherits the protection rather than each reimplementing it.

### 6. `quais` floats across alpha prereleases

`package.json` declares `~1.0.0-alpha.53`, which resolves to `>=1.0.0-alpha.53 <1.1.0`.
The installed version is already `alpha.55`. Alpha releases carry no compatibility promise,
so an `npm install` on any given day can pull a breaking change into a published SDK.

**Fix:** pin exactly and bump deliberately.

### 7. The worker-thread miner cannot degrade

`src/salt/mine.ts:127` inlines a worker whose source calls `require('quais')`. Under any
bundler — a packaged CLI, Vite, webpack — that string is not traced, the require fails, and
`worker.on('error')` rejects with `SaltMiningError`. There is no fallback: the sync
strategy is only reached when `import('node:worker_threads')` itself throws.

The result is that salt mining, and therefore vault deployment, fails outright in a bundled
consumer rather than running slower.

**Fix:** fall back to `syncStrategy` on worker startup failure, not just on missing
`worker_threads`.

### 8. Untyped `Error('Aborted')` escapes the typed-error contract

Every other error in the SDK is a `QuaiVaultError` carrying a stable `code`. These are not:

- `src/indexer/client.ts:146`
- `src/chain/retry.ts:117`, `:127`, `:146`

And `Vault.waitForExecutable` (`src/vault.ts:1193`) throws `PreconditionError` for the same
condition, so abort is reported three different ways. A consumer switching on `err.code`
cannot handle Ctrl-C uniformly.

**Fix:** add `AbortError` with code `ABORTED` and use it everywhere abort is signalled.

### 9. Health probe body read is unbounded

`src/indexer/client.ts:165-169` clears the abort timer as soon as `fetch` resolves, then
awaits `res.json()` with no deadline. A server that returns headers promptly and then
stalls the body hangs the probe indefinitely — and `health()` gates every `auto` read.

**Fix:** clear the timer only after the body has been read.

### 10. Balance reads bypass both the retry policy and the Connection layer

`src/balances.ts` constructs `new Contract(...)` directly against `connection.provider`
(lines 159, 165, 180, and inside `filterOwned`). Every other read path in the SDK goes
through a facade that applies `withRetry`. These get no transient-failure handling, which
is precisely backwards: they are also the highest-volume reads the SDK issues.

**Fix:** route them through a small token-contract facade like the other three.

### 11. `QUAIVAULT_PRIVATE_KEY` is resolved even when a signer was supplied

`resolveConfig` (`src/config/resolve.ts:232`) always evaluates
`pick(options.privateKey, env[ENV_VARS.privateKey])`, so `connect({ signer })` pulls the
environment's private key into the resolved config even though `Connection` will never use
it. Harmless in practice — the object is local and discarded — but there is no reason to
bring a secret into memory that cannot be used.

**Fix:** skip private-key resolution when `options.signer` is present.

---

## P2 — Efficiency and scalability

### 12. Unbounded RPC fan-out in `balances()`

`src/balances.ts:110` fans out over up to `maxTokens` (default 50) tokens with
`Promise.all`. For each ERC721, `filterOwned` fans out again over up to `maxTokenIdChecks`
(default 100) `ownerOf` calls. Worst case is ~5,000 concurrent RPC calls from a single
`balances()` invocation, unthrottled and — per finding 10 — unretried.

**Fix:** add a concurrency pool (8–12) around both levels.

### 13. A redundant Supabase round trip on every indexed read

`hydrateRows` (`src/vault.ts:277`) and `fromIndexer` (`src/vault.ts:303`) each call
`indexer.state()` solely to populate `indexedAtBlock`. `health()` already carries
`lastIndexedBlock` and is cached for 5 s; `useIndexer()` has just called it on the same
code path.

**Fix:** read it from the cached health result.

### 14. `describe()` fetches the transaction twice

`src/vault.ts:1245` calls `this.transaction(txHash)`, then `this.affordances(txHash)` at
line 1269 re-fetches the same record.

**Fix:** add an overload that accepts an already-fetched transaction.

### 15. An indexed `transaction()` costs 5–6 round trips

health → owners → threshold → transaction → confirmations → state. `threshold()` always
goes to chain regardless of consistency setting.

A correction to the original framing: the *list* methods were already fine.
`pendingTransactions` and `transactionHistory` read owners and threshold once per page and
batch confirmations — roughly four round trips for a whole page. The exposure was
`transaction(hash)` called in a loop.

**Fixed, in three parts, in the order they pay off:**

1. `threshold()` now honours the consistency setting. The indexer stores it
   (`wallets.threshold`, via the previously-unused `IndexerQueries.wallet`), so the
   singular indexed read no longer needs an RPC call at all. This was arguably a
   consistency bug rather than a performance idea.
2. `Vault.transactions(hashes)` — the plural form, backed by a new chunked
   `transactionsByHash`, reusing the same `hydrateRows` path the listings use. Hashes the
   indexer lacks fall back to pooled chain reads; hashes that exist nowhere are absent
   from the returned map rather than throwing, so one unknown hash does not cost the
   caller the other forty-nine.
3. `Vault.view()` / `Vault.pinned(view)` — an explicit snapshot rather than an implicit
   TTL cache. The deciding argument against a default cache: the owner set determines
   which approvals count, and `buildTransaction` already intersects indexed confirmations
   with the live owner set precisely because the indexer over-reports after an
   `OwnerRemoved`. A silent TTL would reintroduce that bug class through the back door,
   intermittently. An explicit snapshot puts the staleness window in the caller's own code
   with a visible `capturedAt` — and `chainOwners`/`chainThreshold` mean it can never
   reach a write precondition. `test/view.test.ts` pins that last property.

### 16. `count: 'exact'` on three paginated queries

`src/indexer/queries.ts:117`, `:201`, `:216`. Exact counts force Postgres to scan the full
matching set on every page request, which degrades as vault history grows.

**Fix:** use an estimated count, or drop the count and rely on `hasMore`.

### 17. `@supabase/supabase-js` is a hard dependency

Originally written as an 8.6 MB problem. That was installed size, which is the wrong metric
for a library consumers bundle. Measured properly (esbuild, `--bundle --minify`, browser
platform, gzip):

| Bundle | gzip |
|---|---|
| Whole SDK, everything bundled | 231 KB |
| `quais` alone | 201 KB |
| `@supabase/supabase-js` | 57 KB |
| `postgrest-js` + `realtime-js` | 22 KB |
| `postgrest-js` alone | 5 KB |

Two conclusions. First, `quais` dominates and is not removable — it *is* the chain library,
so every Supabase optimisation competes for the remaining sliver. Second, the lazy-import
fix originally proposed was the wrong one: the SDK uses two of the umbrella's five
subpackages, and pulls `auth-js`, `storage-js` and `functions-js` only because
`SupabaseClient`'s constructor references them unconditionally, which is why no bundler can
shake them out.

**Fixed** by depending on `@supabase/postgrest-js` and `@supabase/realtime-js` directly —
57 KB → 22 KB, with no async API change, because `IndexerClient`'s constructor stays
synchronous. Measured end result: **231 KB → 197 KB gzip for the whole SDK.**

The cost is reproducing what `createClient` was doing: the `/rest/v1` and `/realtime/v1`
paths, and the `apikey` + `Authorization: Bearer` header pair PostgREST needs to select the
`anon` role the RLS policies are written against. That wiring fails at runtime rather than
at compile time if it is wrong, so it was verified against the live mainnet indexer — an
authenticated `wallets` read and a Realtime channel reaching `SUBSCRIBED` — not just by the
offline suite.

The Realtime client is constructed lazily, so nothing opens a WebSocket unless `watch()` is
called. If the last ~17 KB ever matters, lazy-*importing* `realtime-js` behind `watch()` is
the natural next step; it is already the only genuinely optional feature and `watch()` is
async-shaped anyway. Not done here — it buys little against a 197 KB baseline.

---

## P3 — Succinctness and consistency

| # | Finding | Location |
|---|---|---|
| 18 | `SDK_VERSION` hardcoded as `'0.1.0'` against `package.json` 0.1.1 | `src/indexer/client.ts:7` |
| 19 | Sentinel / zero-address constants duplicated three times; `20` hardcoded instead of `MAX_OWNERS` | `src/encode/index.ts:28`, `src/recovery.ts:26-27,314`, `src/factory.ts:277-278` |
| 20 | `RecoveryModule` reaches around its own facade with raw `getFunction`, losing retry and typing | `src/recovery.ts:74,310,338,374` |
| 21 | `RecoveryRequest.approvedBy` declared but never populated by any code path | `src/types.ts:372` |
| 22 | `RecoveryModule.history()` returns `[]` with no indexer while every sibling throws `NoIndexerError` | `src/recovery.ts:141` |
| 23 | Dead exports: `zeroPadValue`/`toBeHex` re-exported to nowhere; `MAX_MODULES` never enforced | `src/encode/index.ts:25,226` |
| 24 | `ClientOptions.network` uses an inline `keyof typeof import(...)` where `NetworkName` exists | `src/types.ts:61` |
| 25 | `test/**` excluded from ESLint though included in tsconfig — the suite gets no lint coverage | `eslint.config.js:44` |
| 26 | `@types/node` is `^20` while `engines.node` is `>=22` | `package.json` |
| 27 | `PLAN.md` (600 lines) sits in the repo root now that its phases 0–3 are complete | repo root |

---

## Deliberately left alone

Two designs were examined and found correct; the comments justifying them are accurate and
should not be "simplified" away by a later pass:

- **The retry policy's reads-only scope** (`src/chain/retry.ts:1-7`). Retrying a write risks
  double-broadcasting a transaction that is already in the mempool. Every write path calls
  through unretried, deliberately.
- **The `auto` / `indexed` / `chain` consistency model** with mandatory chain
  re-validation on writes (`src/types.ts:46-57`). Indexed approval counts over-report after
  an owner removal, because the indexer does not react to `OwnerRemoved` while the contract
  invalidates approvals via epochs. `Vault.buildTransaction` intersecting confirmations with
  the live owner set is the right compensation, and `assertExecutable` reading only from
  chain is the right guard.

---

## Sequencing and status

| Step | Findings | Rationale | Status |
|---|---|---|---|
| 1 | 1–4 | Correctness. The CLI surfaces all four immediately. | Done |
| 2 | 5, 8, 12 | Most direct bearing on CLI behaviour: terminal safety, Ctrl-C, RPC load. | Done |
| 3 | 6, 7, 9, 10, 11 | Robustness. Mutually independent. | Done |
| 4 | 13, 14, 16 | Performance. Measurable, low risk. | Done |
| 5 | 18–27 | Cleanup, batchable. | Done |
| 6 | 15, 17 | Needed a design decision first; taken in a second pass. | Done |

All 27 findings are resolved.

### What landed beyond the literal finding

- **5** grew to cover revert reasons as well as token metadata. `Error(string)` data comes
  from whatever contract the vault called, which for an external call is an address the
  proposer chose — the same trust level as a token's `symbol()`, and it flows to the same
  terminal. `DecodedRevert.message` is now scrubbed; `args` deliberately are not.
- **7** introduced `createWorkerThreadsStrategy(load)` so the retreat path is testable. A
  fallback nothing exercises is a fallback nobody can trust, and this one only fires in
  environments the test suite does not otherwise run in.
- **16** also made `hasMore` exact. Switching the count to `estimated` would have made
  `hasMore` an estimate too, and a paging loop that stops early drops rows — so paged
  queries now fetch one row past the page and trim it.
- **23** kept `MAX_MODULES` and gave it a job (`validateCreateParams` now enforces it,
  mirroring the contract's `MaxModulesReached`) rather than deleting an unused export.

- **15** and **17** both turned out to be mis-framed in the original review, and the
  measurements changed the fix in each case. Recorded in full under those findings, because
  the reasoning is more reusable than the patch.

### Follow-ups created by this pass

- `proposedAt` is now `0` on indexed reads, with the block in `proposedAtBlock`. Anything
  wanting "proposed 3 days ago" from an indexed read needs either a chain read or a
  block-to-timestamp resolution the SDK does not currently offer. Worth revisiting once the
  CLI shows whether it actually needs wall-clock time there.
- `RecoveryModule.history()` now throws `NoIndexerError` instead of returning `[]`. That is
  the correct signal, but it is a behavioural change for any caller that was relying on the
  empty array.
