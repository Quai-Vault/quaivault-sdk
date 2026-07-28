# QuaiVault SDK — Build-Out Plan

Target: `@quaivault/sdk`, a TypeScript SDK for operating QuaiVault multisig vaults on Quai
Network, with a CLI built on top of it afterwards.

---

## 0. Status

**Scope changes from the original plan:**

- **Agent tooling descoped.** No `@quaivault/agent-tools`, no MCP server, no tool manifest.
  Affordances, `describe()`, `dryRun` and typed error codes remain — they pay for
  themselves for ordinary developers and for the CLI. See §6.
- **Single package, not a monorepo.** The CLI becomes a sibling repo. See §3.
- **`quais` is a direct dependency**, not a peer.
- **Config is environment-driven**, with the indexer publishable key **shipped in the
  presets** so the SDK works with no configuration at all. See §7.

**Built and verified** (Phases 0–3 of §10 complete):

| Area | State |
|---|---|
| ABI generation + drift check | `scripts/sync-abis.ts`, 5 contracts |
| Config resolution (explicit → env → preset) | `src/config/` |
| Typed errors + revert decoding | `src/errors/`, 73 selectors with remediation |
| CREATE2 prediction + salt mining | `src/salt/`, sync + `worker_threads` |
| Chain reads/writes | `src/chain/`, `src/vault.ts`, `src/factory.ts` |
| Indexer reads (Supabase, zod-validated) | `src/indexer/` |
| Realtime subscriptions | `src/indexer/watch.ts` |
| Social recovery (reads, writes, affordances) | `src/recovery.ts` |
| Token/NFT balance aggregation | `src/balances.ts` |
| Encoding / decoding | `src/encode/`, `src/decode/` |
| Lifecycle: outcomes, status, affordances, waiting | `src/lifecycle/`, `waitForExecutable` |
| RPC/indexer resilience | `src/chain/retry.ts` — reads only, never writes |
| Write-then-read consistency | `waitForIndexer` / `IndexerClient.waitForBlock` |
| Quai-only address enforcement | `src/address.ts` — zone + ledger, at every role/value entry point |
| Tests | 163 passing |

**Verified against both live networks:**

- Off-chain `predictVaultAddress` matches `factory.predictWalletAddress` on **mainnet and
  Orchard testnet**, for every overload shape including modules and delegatecall targets.
- Salt mining produces shard-valid addresses the factory agrees with.
- Indexer reads, decoding, `describe()` and affordances work on real vault data.
- Recovery reads work against a live mainnet vault (2 guardians, 2-of-2, 24h period, one
  pending and two cancelled recoveries).
- Balance aggregation verified for ERC20 (testnet) and ERC1155 (mainnet, 4 token ids).
- Realtime subscribes and unsubscribes cleanly.

**Resolved along the way:**

- **Orchard testnet RPC** moved to `https://orchard.rpc.quai.network` (the old
  `rpc.orchard.quai.network` is NXDOMAIN). Preset updated; chainId 15000 confirmed on chain.
  The public DeveloperGuide and the frontend `.env.testnet` still point at the dead host.
- **`testnet` schema is exposed** in PostgREST — confirmed by querying it directly. This
  closes the open question from the first draft.

**New finding — indexer recovery status goes stale.** A live mainnet recovery reads as
`pending` in the indexer while the chain says `expired`. The indexer only writes an expired
status when it observes `RecoveryExpiredEvent`, which requires somebody to call the
permissionless `expireRecovery`. The SDK derives recovery status from timestamps on both
paths (`deriveRecoveryStatus`), trusting the indexer only for `cancelled`, which the chain
cannot report at all — `cancelRecovery` deletes the struct. The same class of issue as
§5.3, and worth fixing indexer-side too.

**Not yet built:** the CLI (Phase 5) and the frontend migration (Phase 6).

**Audit pass (2026-07-28).** Six defects found and fixed, all verified against the packed
tarball in a clean project:

1. `client.config` exposed `privateKey` — a `console.log(qv.config)` or `--verbose` flag
   would have leaked it. The client now holds only a redacted view; the key is consumed
   once when building the signer.
2. The indexer retry wrapper was dead code — `postgrest-js` returns errors as resolved
   values, not rejections, and already retries GET internally. Removed rather than
   "fixed", which would have compounded to 9 attempts.
3. Six `vault.ts` write paths tolerated a null receipt in the status check then
   dereferenced it, turning a replaced transaction into a `TypeError`. Unified behind
   `assertReceipt`.
4. `delegatecallTargets()` swallowed a failure and reissued the identical query.
5. Private keys not derivable to a Quai zone were accepted, failing opaquely on the first
   transaction. Now rejected up front — and the first version of that guard checked
   `isQuaiAddress` (the Quai/Qi ledger bit) rather than zone membership, which let
   zone-less addresses through.
6. `balances()` silently truncated at three hidden caps; all three are now configurable
   and reported via `truncated`.

**Qi-ledger enforcement (2026-07-28).** Quai has two ledgers and Qi has no contract
execution, so a Qi address can never sign, approve, or usefully receive value. The
contracts do not check this, making a Qi owner permanent dead weight against the threshold
— enough of them brick a vault. The signer guard already covered it, but every other entry
point used a bare `isAddress()`, which accepts Qi.

`assertQuaiAddress` now validates zone **and** ledger — genuinely orthogonal properties
(`0x0081…` is zone-valid but Qi; `0x7E11…` is Quai-ledger but zone-less) — at owners,
guardians, recovery owners, modules, delegatecall targets, transfer recipients, batch
sub-call targets and the vault address. Removals stay permissive so a vault that already
admitted a bad address can clean it up.

Writing those tests exposed a second issue: `propose.*` was a **mix** of async methods
(rejecting) and plain arrows (throwing synchronously), so `propose.addOwner(bad).catch(h)`
would throw before `.catch` attached. All are async now.

Packaging is publish-ready: LICENSE, repository/bugs/homepage metadata, `sideEffects:
false`, a `prepublishOnly` gate, and ESM + CJS + strict-mode types verified from the
tarball.

**Added after the indexer fixes landed:** a retry policy for transient RPC and indexer
failures (reads only — retrying a write risks a double broadcast), and `waitForIndexer`,
which closes the write-then-read race that would otherwise bite the CLI on its first
propose-then-list. Both are prerequisites for a CLI that has to behave against a shared
public RPC.

---

## 1. What already exists (inventory)

### 1.1 Contracts — `quaivault-contracts/`

| Contract | LOC | Role |
|---|---|---|
| `QuaiVault.sol` | 1331 | Core multisig implementation (behind proxies) |
| `QuaiVaultFactory.sol` | 276 | CREATE2 factory, 4 `createWallet` overloads, `predictWalletAddress`, `registerWallet` |
| `QuaiVaultProxy.sol` | 53 | ERC1967 constructor proxy, no upgrade path |
| `modules/SocialRecoveryModule.sol` | 695 | Guardian-based recovery |
| `libraries/MultiSendCallOnly.sol` | 85 | Batching (must be delegatecall-whitelisted per vault) |
| `libraries/Enum.sol` | 16 | `Operation.Call` / `Operation.DelegateCall` |

ABIs already exist in **three** places: `quaivault-contracts/artifacts/`,
`quaivault-indexer/abis/*.json`, `quaivault-frontend/src/config/abi/`. Typechain types are
generated in `quaivault-contracts/typechain-types/`. **The SDK becomes the fourth copy unless
we fix distribution (see §9).**

Deployed addresses live in `quaivault-www/contracts.md` and the frontend `.env.*.bak` profiles.

### 1.2 Indexer — `quaivault-indexer/`

- Node service polling Quai RPC → Supabase Postgres. 31 event types + ERC20/721/1155 wildcards.
- **One Supabase project, per-network Postgres schemas** (`mainnet`, `testnet`, `dev`) created by
  `create_quaivault_schema(network_name)` in `supabase/migrations/schema.sql`.
- RLS: `"Public read access" … FOR SELECT USING (true)` on every table, plus
  `GRANT SELECT ON ALL TABLES … TO authenticated, anon` (schema.sql:802–882).
  **Read access via the anon key is a designed property, not an accident** — safe to bake in.
- Writes are `service_role` only.
- 16 tables. The ones the SDK cares about: `wallets`, `wallet_owners`, `transactions`,
  `confirmations`, `wallet_modules`, `wallet_delegatecall_targets`, `deposits`, `tokens`,
  `token_transfers`, `signed_messages`, `module_executions`, `social_recovery_*`, `indexer_state`.
- Health HTTP server: `GET /health` `/ready` `/live` with `lastIndexedBlock` / `blocksBehind`.
- Supabase Realtime is enabled and already used by the frontend.

### 1.3 Frontend — `quaivault-frontend/`

**This is where the de-facto SDK already lives.** `src/services/` is ~13k LOC of largely
framework-agnostic TypeScript:

```
services/core/       BaseService, WalletService, TransactionService, OwnerService, saltMiner.worker
services/indexer/    IndexerService + Wallet/Transaction/Module/Token/Subscription/Health services
services/modules/    BaseModuleService, SocialRecoveryModuleService
services/utils/      GasEstimator, TransactionErrorHandler, TransactionVerifier,
                     TransactionConverter, ContractMetadataService, TokenBalanceService,
                     NftMetadataService
services/            MultisigService (facade, indexer-first + chain fallback),
                     TransactionBuilderService (self-call calldata encoders)
utils/               transactionDecoder, formatting, blockTime, clockSkew, errorMessages
types/database.ts    Zod schemas for every indexer row type
```

Browser coupling is **shallow and enumerable**:
1. `import.meta.env` read at module load (`config/contracts.ts`, `config/supabase.ts`).
2. `new Worker(new URL('./saltMiner.worker.ts', import.meta.url))` in `WalletService.mineSalt`.
3. `config/provider.ts` holds a module-global `BrowserProvider`.
4. Module-level singletons (`multisigService`, `indexerService`, `transactionBuilderService`).

Everything else is plain `quais` + `@supabase/supabase-js`. **Extraction, not rewrite.**

### 1.4 Docs — `quaivault-www/`

`src/pages/docs/DeveloperGuide.tsx` (549 lines) is the current integrator doc. It has drifted
from the contracts — see §9.2. It is hand-written JSX, so it will keep drifting.

---

## 2. Design principles

1. **Signer-agnostic core.** No `window`, no `import.meta.env`, no browser-only APIs in the main
   entry. A private-key signer, a keystore signer, a browser provider, or a remote signer all
   plug into the same surface. Non-negotiable — the CLI depends on it.
2. **Explicit config, zero implicit env reads.** Network presets are data, passed in.
3. **Two data planes, one API.** Indexer for reads (fast, historical, no RPC needed);
   chain for writes and for anything safety-critical. Callers choose consistency; the
   default is safe.
4. **Every write returns a *semantic* outcome, not a receipt.** On QuaiVault, `receipt.status === 1`
   does **not** mean the vault action happened (§5.2). This is the single highest-value thing the
   SDK provides over raw `quais`.
5. **Errors are typed and decoded.** Custom-error selectors from all four ABIs are mapped to typed
   error classes with remediation text.
6. **Preconditions are legible.** Every operation has a machine-readable precondition set,
   and the SDK can answer "what can address X legally do to transaction Y right now, and if
   not now, when?" — so callers plan rather than discover constraints through reverts.
7. **No hidden network calls in constructors.** Everything lazy, everything cancellable.
8. **Read-only works with no signer and no wallet.** `QuaiVault.connect({ network: 'mainnet' })`
   must fully work for observation and analytics.

**Non-goals (v1):** transaction relaying/gas sponsorship, a hosted API, key management/storage,
custom module authoring framework, React bindings (the frontend keeps its own hooks and consumes
the SDK underneath).

---

## 3. Repo & package layout

`quaivault-sdk/` is its own git repo, matching the repo-per-component pattern. With agent
tooling descoped it is a **single package**, not a workspace:

```
quaivault-sdk/
├── package.json              # @quaivault/sdk
├── tsup.config.ts            # ESM + CJS + .d.ts
├── .env.example
├── scripts/sync-abis.ts      # pulls ABIs from quaivault-contracts artifacts
├── src/
│   ├── index.ts              # public surface
│   ├── client.ts             # connect() / QuaiVaultClient
│   ├── vault.ts              # Vault handle: reads, proposals, lifecycle writes
│   ├── factory.ts            # deploy, predict, register
│   ├── types.ts
│   ├── abi/                  # generated — do not hand-edit
│   ├── chain/                # connection, typed contract facades
│   ├── config/               # network presets, env resolution
│   ├── indexer/              # supabase client, zod row schemas, queries
│   ├── encode/               # self-calls, token calls, multisend
│   ├── decode/               # calldata classification + summaries
│   ├── errors/               # typed errors + revert decoding
│   └── salt/                 # CREATE2 prediction + shard-prefix mining
└── test/
```

The CLI becomes a sibling package (`quaivault-cli`) depending on `@quaivault/sdk`, rather
than a workspace member — nothing in the SDK needs to know it exists.

**Runtime deps:** `quais` (direct), `@supabase/supabase-js`, `zod`. Nothing else.
**Targets:** Node ≥20, modern browsers, ESM + CJS dual build (tsup), full `.d.ts`.

`quais` as a direct dependency (rather than a peer) was chosen deliberately: the CLI and
most consumers are Node applications that do not already have `quais` installed, and the
dual-instance risks that motivate peer deps mostly bite in browser bundles that pin their
own copy. Consumers who do bundle their own can dedupe via their package manager.

---

## 4. Public API surface

### 4.1 Client

```ts
import { QuaiVault, networks } from '@quaivault/sdk';

// Read-only. Uses baked-in indexer creds + public RPC. No wallet required.
const qv = QuaiVault.connect({ network: 'mainnet' });

// Read-write.
const qv = QuaiVault.connect({ network: 'mainnet', signer });

// Full override (self-hosted indexer, custom RPC, unreleased deployment)
const qv = QuaiVault.connect({
  network: { ...networks.testnet, rpcUrl, indexer: { url, anonKey, schema } },
  signer,
  consistency: 'auto',           // 'auto' | 'indexed' | 'chain'
  maxIndexerLagBlocks: 25,       // beyond this, 'auto' falls through to chain
});
```

### 4.2 Discovery & factory

```ts
qv.vaults.forOwner(address)                  // indexer: wallet_owners join
qv.vaults.forGuardian(address)               // indexer: social_recovery_guardians join
qv.vaults.get(address)                       // → Vault handle
qv.vaults.exists(address)                    // factory.isWallet + code check

qv.factory.predictAddress(params)            // mirrors predictWalletAddress
qv.factory.mineSalt(params, { onProgress })  // Quai shard-prefix CREATE2 mining (§5.1)
await qv.factory.create({
  owners, threshold,
  minExecutionDelay?, initialModules?, initialDelegatecallTargets?,
  salt?,                                     // omit → mined automatically
  onProgress?,
})                                           // → { address, txHash, salt, receipt }
qv.factory.register(vaultAddress)            // registerWallet for externally deployed proxies
```

### 4.3 Vault handle

```ts
const vault = qv.vaults.get('0x00…');

// --- reads
await vault.info()                  // owners, threshold, minExecutionDelay, balance, moduleCount
await vault.owners()
await vault.modules()               // paginated linked-list traversal, ordered
await vault.delegatecallTargets()
await vault.balances()              // native + ERC20/721/1155 from indexer `tokens`/`token_transfers`
await vault.deposits({ limit, cursor })
await vault.signedMessages()

// --- transactions
await vault.transactions.pending()
await vault.transactions.history({ status?, limit, cursor })
await vault.transactions.get(txHash)         // → VaultTransaction (see 4.4)
await vault.transactions.hashFor({ to, value, data, nonce? })   // getTransactionHash

// --- writes: propose
await vault.propose.call({ to, value, data, expiration?, executionDelay? })
await vault.propose.transfer({ to, amount, ... })
await vault.propose.erc20Transfer({ token, to, amount, ... })
await vault.propose.erc721Transfer({ token, to, tokenId, ... })
await vault.propose.erc1155Transfer({ token, to, id, amount, data?, ... })
await vault.propose.batch([ …calls ])        // MultiSendCallOnly; asserts it is whitelisted first
// self-calls (encoded correctly, incl. the disableModule prevModule lookup)
await vault.propose.addOwner(address)
await vault.propose.removeOwner(address)
await vault.propose.changeThreshold(n)
await vault.propose.setMinExecutionDelay(seconds)
await vault.propose.enableModule(address)
await vault.propose.disableModule(address)          // resolves prevModule at build time
await vault.propose.addDelegatecallTarget(address)
await vault.propose.removeDelegatecallTarget(address)
await vault.propose.cancelByConsensus(txHash)
await vault.propose.signMessage(bytes)
await vault.propose.approveHashForEip1271(hash)     // encodes abi.encode(hash) — see §5.4
await vault.propose.unsignMessage(bytes)

// --- writes: lifecycle
await vault.approve(txHash)
await vault.approveAndExecute(txHash)        // → ExecuteResult
await vault.execute(txHash)                  // → ExecuteResult
await vault.revokeApproval(txHash)
await vault.cancel(txHash)                   // proposer-cancel; throws typed error post-quorum
await vault.expire(txHash)                   // permissionless

// --- social recovery
vault.recovery.config() / .isGuardian(a) / .pending() / .history()
vault.recovery.initiate({ newOwners, newThreshold })
vault.recovery.approve(h) / .revokeApproval(h) / .execute(h) / .cancel(h) / .expire(h)
vault.propose.setupRecovery({ guardians, threshold, recoveryPeriod })

// --- realtime
const unsub = vault.watch(['transactions','confirmations','owners'], (evt) => …)
```

### 4.4 `VaultTransaction` — the unified read model

Merges the on-chain struct, indexer decoding, and derived lifecycle state:

```ts
interface VaultTransaction {
  hash: `0x${string}`;
  vault: Address;
  to: Address; value: bigint; data: `0x${string}`;
  proposer: Address; proposedAt: number;

  kind: TransactionKind;              // 'transfer' | 'wallet_admin' | 'erc20_transfer' | …
  decoded?: DecodedCall;              // function name + named args + human summary
  summary: string;                    // one-line, human & LLM readable

  status: 'pending' | 'ready' | 'timelocked' | 'executed' | 'failed'
        | 'cancelled' | 'expired';
  approvals: { owner: Address; active: boolean }[];
  approvalCount: number;              // *chain-valid* count (see §5.3)
  threshold: number;

  expiration: number;                 // 0 = none
  executionDelay: number;
  approvedAt: number;                 // 0 = quorum never reached
  executableAfter: number;            // approvedAt + executionDelay, 0 if not started

  failedReturnData?: `0x${string}`;
  decodedRevert?: { name: string; args: unknown[] };

  source: 'indexer' | 'chain';
  indexedAtBlock?: number;            // provenance/staleness
}
```

### 4.5 Affordances — the agent primitive

```ts
vault.affordances(txHash, caller): Promise<Affordance[]>

interface Affordance {
  action: 'approve' | 'revokeApproval' | 'execute' | 'approveAndExecute'
        | 'cancel' | 'expire' | 'proposeCancelByConsensus';
  allowed: boolean;
  reason: string;                          // why not, in plain language
  availableAt?: number;                    // unix ts when a time gate lifts
  blockedBy?: 'not_owner' | 'already_approved' | 'not_approved' | 'threshold'
           | 'timelock' | 'expired' | 'terminal_state' | 'quorum_locked';
}
```

This is derived directly from the contract's real rules (`onlyOwner`, epoch approvals,
`approvedAt != 0` locking proposer-cancel, timelock, expiration, terminal flags). It is what
lets an agent plan instead of trial-and-error against reverts.

---

## 5. The hard parts (get these right or the SDK is worse than raw `quais`)

### 5.1 Quai shard-prefixed CREATE2 salt mining

Quai addresses are shard-scoped: a vault must land on the deployer's shard or it is unusable.
The factory computes `fullSalt = keccak256(abi.encodePacked(msg.sender, userSalt))`, so the
caller must brute-force `userSalt` until `getCreate2Address(factory, fullSalt, bytecodeHash)`
both starts with the sender's 2-byte prefix and passes `isQuaiAddress`. Reference implementation:
`quaivault-frontend/src/services/core/saltMiner.worker.ts` + `WalletService.mineSalt`.

The `bytecodeHash` depends on the **exact** `initialize(owners, threshold, minExecutionDelay,
initialModules, initialDelegatecallTargets)` encoding — mine with the wrong args and the predicted
address is wrong. The frontend currently hardcodes `[], []` for modules/targets, which silently
breaks mining for the 5- and 6-arg factory overloads. **The SDK must derive initData from the
actual create params.**

Design: `MiningStrategy` interface with three implementations, auto-selected:
- `sync` — plain loop, chunked with yields (universal fallback)
- `worker_threads` — Node, N cores
- `web-worker` — browser, via a bundled blob URL so consumers need no bundler config

Expose `mineSalt()` standalone so the CLI can do it offline/ahead of time, and support
`salt` passthrough so a mined salt can be reused.

### 5.2 Execution outcome ≠ receipt status ← **highest-value SDK feature**

Three distinct cases where the outer Quai transaction succeeds but the vault action did not:

1. **Lazy timelock clock** (`QuaiVault.sol:561-567`): if a timelocked tx reached quorum via a path
   that never set `approvedAt` (e.g. threshold was lowered mid-flight), `executeTransaction`
   *sets `approvedAt`, emits `ThresholdReached`, and returns* — deliberately not reverting,
   because a revert would roll back the clock start. Receipt status 1, nothing executed.
2. **`approveAndExecute` returns `false`** (line 519, 523-528) when the threshold is unmet or the
   timelock has not elapsed. Return values are invisible from a receipt.
3. **Option B external-call failure** (line 656-664): a failed external call emits
   `TransactionFailed` and **permanently marks `executed = true`**. The vault transaction is dead,
   the outer receipt says success.

The SDK classifies by parsing receipt logs against the vault interface:

```ts
type ExecuteResult =
  | { outcome: 'executed';         txHash, receipt }
  | { outcome: 'failed';           txHash, receipt, returnData, decodedRevert }  // terminal
  | { outcome: 'timelock_started'; txHash, receipt, executableAfter }            // retry later
  | { outcome: 'approved_only';    txHash, receipt, approvalsNeeded }            // needs more sigs
```

Plus `vault.waitForExecutable(txHash, { timeout })` so callers/agents can express intent instead
of polling.

### 5.3 Approval-epoch invalidation vs. indexer confirmation counts — **known correctness gap**

On chain, removing an owner increments `ownerVersions[owner]`, which atomically invalidates every
in-flight approval from that address (`_approvalValid`, `QuaiVault.sol:676-680`).

In the indexer, `removeOwner` (`src/services/supabase.ts:277-301`) only flips
`wallet_owners.is_active = false`. It never touches `confirmations`. The
`update_confirmation_count` trigger (`schema.sql:624-641`) counts
`confirmations WHERE is_active = TRUE` with **no join to owner activity**.

⇒ After any owner removal, `transactions.confirmation_count` and `getActiveConfirmations()`
**over-report** relative to on-chain `_countValidApprovals`. An agent trusting that number will
attempt executions that revert with `NotEnoughApprovals`.

SDK mitigations (all three):
- Compute `approvalCount` as `confirmations ∩ active owners`, never the raw column.
- Mark `VaultTransaction.approvalCount` provenance and, under `consistency: 'chain'`, verify with
  `hasApproved()` per owner.
- **Every write path re-validates preconditions on chain before signing** (the frontend already
  does this in `TransactionService`; port it wholesale).

Separately, file an indexer issue to deactivate confirmations on `OwnerRemoved`. The SDK should
be correct regardless.

### 5.4 EIP-1271 is pre-approval, and only over exact 32-byte hashes

`isValidSignature(dataHash, sig)` checks
`signedMessages[getMessageHash(abi.encode(dataHash))]` (`QuaiVault.sol:1296`), while
`signMessage(data)` stores `getMessageHash(data)`.

**Correction to an earlier draft of this plan:** these are *not* different encodings.
`abi.encode` of a static `bytes32` is the identity on its 32 bytes, so
`signMessage(hash)` and `signMessage(abi.encode(hash))` produce byte-identical calldata.
There is no double-encoding trap. (Verified: `AbiCoder.encode(['bytes32'], [h]) === h`.)

The real trap is about **length**, not encoding: signing an arbitrary-length message `M`
makes `getMessageHash(M)` true, but `isValidSignature(keccak256(M))` checks
`getMessageHash(abi.encode(keccak256(M)))` — a different map key. Signing `M` therefore
does *not* make `keccak256(M)` validate. Only pre-approving the exact 32-byte hash works.

The SDK exposes both paths explicitly — `propose.signMessage(bytes)` for arbitrary
messages and `propose.approveHashForEip1271(hash)` for the 1271 path, the latter
enforcing the 32-byte precondition — plus `vault.isValidSignature(hash)` to verify.

Also note the model is **pre-approval, not ECDSA**: `_signature` is ignored entirely, so
protocols expecting live signatures will not work without a prior multisig round.

### 5.5 Module linked list & stale `disableModule` proposals

Modules are a Zodiac sentinel linked list; `disableModule(prevModule, module)` bakes in a
predecessor that goes stale whenever the list changes. `TransactionService.validateDisableModulePrevModule`
already handles this. The SDK must (a) resolve `prevModule` at propose time, and (b) re-validate
at execute time, throwing `StaleModuleProposalError` with a "cancel and re-propose" remediation.

### 5.6 Other contract semantics the SDK must encode

- `owners[]` uses swap-and-pop (`QuaiVault.sol:761-784`) — **order is not stable**. Never expose
  index-based owner APIs; same for `factory.deployedWallets(index)`.
- Self-calls always get `executionDelay = 0` and reject `value > 0` at propose time.
- `cancelTransaction` is proposer-only and permanently locked once `approvedAt != 0`, even if
  approvals are later revoked. Post-quorum cancellation requires a `cancelByConsensus` self-call
  proposal — which itself bypasses the timelock (deliberate, for emergency response).
- `expireTransaction` is permissionless and sets both `cancelled = true` and `expiredTxs = true`;
  distinguish expired from cancelled via `expiredTxs`, not the struct.
- `MAX_OWNERS = 20`, `MAX_MODULES = 50`, `MAX_EXECUTION_DELAY = 30 days`. Validate client-side.
- `ExpirationTooSoon` — expiration must exceed `now + effectiveDelay`. Provide a helper that
  computes a valid minimum expiration for given delay.
- Lowering the threshold can strand tight-expiration timelocked txs (contract note at line 790).
  Surface this as a warning on `propose.changeThreshold` when in-flight txs would be affected.
- `fallback()` reverts on unknown selectors with zero value — a wrong-ABI call fails opaquely.
- DelegateCall is **whitelist-only and empty by default**; `propose.batch()` must check
  `delegatecallAllowed[MultiSendCallOnly]` and, if absent, return an actionable error naming
  the `addDelegatecallTarget` proposal needed first.

---

## 6. Agent tooling — descoped

Dropped from scope. The affordance model (§4.5), `describe()`, `dryRun` and the typed
error codes stayed, because they earn their place for ordinary developers and for the CLI:
they are what let any caller plan an action instead of discovering constraints through
reverted transactions.

No `@quaivault/agent-tools` package, no MCP server, no tool manifest. If that is wanted
later it layers on top of the SDK without changing it.

## 7. Network config & the indexer anon key

Presets ship contract addresses, RPC URLs and the indexer URL/schema. The **anon key is not
baked in** — it is supplied by `QUAIVAULT_INDEXER_ANON_KEY` or `connect({ indexer: { anonKey } })`.

```ts
export const mainnet: NetworkConfig = {
  name: 'mainnet', chainId: 9,
  rpcUrl: 'https://rpc.quai.network',
  explorerUrl: 'https://quaiscan.io',
  contracts: { implementation: '0x0038E6…', factory: '0x003613…',
               socialRecovery: '0x000dbc…', multiSendCallOnly: '0x003f62…' },
  indexer: { url: 'https://xbftgyuxaxagptudledv.supabase.co',
             anonKey: '',            // ← from the environment
             schema: 'mainnet',
             healthUrl: 'https://index.quaivault.org' },
};
```

Notes:

- **The key is safe to distribute** — the indexer's RLS grants `anon` `SELECT` only, with
  every write reserved for `service_role`. Keeping it in config rather than in the bundle
  is about **rotation**, not secrecy: a rotated key needs no SDK release. Worth a line in
  `SECURITY.md` so nobody files a leak report against it.
- **Degrade, don't fail.** Without the key the SDK still works; only indexer-backed
  features (discovery by owner/guardian, history, pending listing) are unavailable, and
  they raise `NoIndexerError` naming the variable to set. `consistency: 'indexed'` without
  an indexer is rejected at `connect()` rather than at first query.
- **Client identification.** The Supabase client sets
  `x-client-info: quaivault-sdk/<version>` so indexer traffic can be attributed and
  rate-limited per client rather than globally.
- **Freshness gating.** `consistency: 'auto'` consults `/health` (cached 5s, with an
  in-flight dedupe) and falls through to chain reads beyond
  `QUAIVAULT_MAX_INDEXER_LAG_BLOCKS` (default 50), so a stalled indexer degrades instead of
  serving stale state.
- **Still open:

1. **Frontend migration timing.** Migrate in Phase 6 (proves the extraction, large diff) or
   leave the duplication for now? Recommendation: migrate — it is the only real proof the
   SDK surface is complete.
2. **Indexer `/config` endpoint.** Worth adding so contract addresses and the publishable
   key can rotate without an SDK release, with the presets as fallback? Recommendation:
   yes, low cost.
3. **Stale docs point at a dead RPC.** The www DeveloperGuide and the frontend
   `.env.testnet` still reference `rpc.orchard.quai.network`, which no longer resolves.
   Both need updating to `orchard.rpc.quai.network`.
4. **Two indexer correctness gaps** the SDK works around but that should be fixed at the
   source, since other consumers read the same columns:
   - `confirmations` are not deactivated on `OwnerRemoved`, so `confirmation_count`
     over-reports (§5.3).
   - `social_recoveries.status` stays `pending` past a recovery's expiration until someone
     calls `expireRecovery` (§0).
5. **Off-chain metadata.** Vault names and address books would need a new table plus write
   policies. Out of scope for v1, but it decides whether an auth story is needed later.
