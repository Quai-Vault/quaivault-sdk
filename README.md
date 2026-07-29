# @quaivault/sdk

TypeScript SDK for [QuaiVault](https://quaivault.org) multisig vaults on Quai Network.

Reads go through the indexer when it is fresh and the chain when it is not; writes always
re-validate on chain before signing. Works in Node and the browser, with any signer.

```bash
npm install @quaivault/sdk
```

**Documentation:** [quaivault.org/docs/sdk](https://quaivault.org/docs/sdk) —
[guides](https://quaivault.org/docs/sdk-guides) ·
[API reference](https://quaivault.org/docs/sdk-reference)

## Quick start

```ts
import { connect } from '@quaivault/sdk';

// Read-only. No wallet, no key.
const qv = connect({ network: 'mainnet' });

const vault = qv.vault('0x005f2629A632962f4944d23686efDa5c160d535b');
const info = await vault.info();
console.log(`${info.threshold}-of-${info.owners.length}, balance ${info.balance}`);

for (const tx of await vault.pendingTransactions()) {
  console.log(tx.status, `${tx.approvalCount}/${tx.threshold}`, tx.summary);
}
```

Add a signer to write:

```ts
const qv = connect({ network: 'mainnet', privateKey: process.env.QUAIVAULT_PRIVATE_KEY });

const { txHash } = await qv.vault(address).propose.transfer({
  to: '0x00…',
  amount: 1_000000000000000000n, // 1 QUAI
});
```

## Configuration

Everything is configurable by environment variable, explicit option, or network preset.
**Explicit options win, then the environment, then the preset.** Nothing is read at import
time, so importing the SDK never touches `process.env`.

See [`.env.example`](./.env.example) for the full list. The essentials:

| Variable | Purpose |
|---|---|
| `QUAIVAULT_NETWORK` | `mainnet` or `testnet` |
| `QUAIVAULT_RPC_URL` | Quai RPC base URL (shard path appended automatically) |
| `QUAIVAULT_PRIVATE_KEY` | Signing key — required only for writes |
| `QUAIVAULT_INDEXER_ANON_KEY` | Override the shipped read-only indexer key |
| `QUAIVAULT_CONSISTENCY` | `auto` (default), `indexed`, or `chain` |

Networks:

| Preset | Chain ID | RPC | Indexer schema |
|---|---|---|---|
| `mainnet` | 9 | `https://rpc.quai.network` | `mainnet` |
| `testnet` (Orchard) | 15000 | `https://orchard.rpc.quai.network` | `testnet` |

Indexer credentials ship with the SDK, so discovery, history and realtime work with no
configuration. The publishable key is a public credential — the indexer's RLS grants `anon`
`SELECT` and nothing else, with every write reserved for `service_role`. Override it only
to point at a self-hosted indexer or if it is rotated ahead of a release.

## Three things worth knowing

### 1. A successful receipt does not mean the transaction executed

QuaiVault has three paths where the Quai transaction succeeds but the vault transaction did
not run. `execute()` returns a discriminated result rather than a receipt:

```ts
const result = await vault.execute(txHash);

switch (result.outcome) {
  case 'executed':          break;                          // the target call succeeded
  case 'failed':            result.decodedRevert;           // target reverted; TERMINAL
  case 'timelock_started':  result.executableAfter;         // clock started, retry later
  case 'approved_only':     result.approvalsNeeded;         // needs more signatures
}
console.log(result.message); // plain-language explanation
```

- **`failed`** — the vault marks the transaction executed *permanently* and emits
  `TransactionFailed` instead of reverting. It cannot be retried; propose a replacement.
- **`timelock_started`** — a timelocked transaction that reached quorum without
  `approvedAt` being set (e.g. the threshold was lowered mid-flight) has its clock started
  by the first `execute` call, which then returns without executing.
- **`approved_only`** — `approveAndExecute` returned `false`, which a receipt cannot show.

### 2. Deploying requires mining a CREATE2 salt

Quai addresses are shard-scoped, so a vault must land on the deployer's shard or it is
unreachable. `create()` mines a salt automatically:

```ts
const { address, salt, predictionMatched } = await qv.factory.create(
  { owners: [a, b, c], threshold: 2, minExecutionDelay: 86_400 },
  { onProgress: (p) => console.log(p.step, p.message) },
);
```

The predicted address is a pure function of `(factory, implementation, deployer, salt,
create params)` — including `initialModules` and `initialDelegatecallTargets`. Mining with
different params than you deploy with predicts the wrong address, so pass the real ones.

To mine ahead of time and deploy later, keep the salt and reuse it with identical params:

```ts
const mined = await qv.factory.mineSalt(params);
await qv.factory.create({ ...params, salt: mined.salt });
```

### 3. Indexed approval counts can over-report

The contract invalidates an owner's in-flight approvals when that owner is removed
(approval epochs). The indexer marks a confirmation inactive only on an explicit
`ApprovalRevoked`, so its stored `confirmation_count` is too high after any owner removal.

The SDK intersects confirmations with the current owner set to reproduce the contract's
count, and every write path re-reads the chain before signing. A stale count never gates a
signature.

## Knowing what you can do

`affordances()` answers "what may this address legally do to this transaction right now,
and if not now, when" — derived from the contract's actual rules, so you can plan instead
of discovering constraints through reverts.

```ts
for (const a of await vault.affordances(txHash, caller)) {
  console.log(a.allowed ? 'YES' : 'no', a.action, a.reason, a.availableAt);
}
```

It encodes the subtle ones: proposer-cancel is permanently blocked once quorum is reached
(even if approvals are later revoked), self-calls bypass the timelock, and `expire` is
permissionless once past the deadline.

`describe(txHash)` renders the same information as a compact human-readable block.

## API

### Client

```ts
connect(options?): QuaiVaultClient
qv.vault(address): Vault
qv.vaults.forOwner(address) / forGuardian(address) / exists(address)
qv.factory.create(params, options?) / mineSalt(params) / predictAddress(deployer, salt, params)
qv.factory.implementation() / verify() / vaultCount() / vaultAt(i) / register(vault)
qv.indexerHealth()
```

### Vault reads

```ts
vault.info() / owners() / threshold() / balance() / modules() / delegatecallTargets()
vault.isOwner(a) / isModuleEnabled(m) / isDelegatecallAllowed(t) / isValidSignature(hash)
vault.transaction(txHash) / transactions(txHashes) / pendingTransactions(page?)
vault.transactionHistory(page?) / transactionHash(to, value, data, nonce?)
vault.hasApproved(txHash, owner)
vault.affordances(txHash, caller?, at?) / describe(txHash, caller?)
vault.view() / pinned(view)                       // explicit owners+threshold snapshot
vault.balances(opts?) / deposits(page?) / tokenTransfers(page?) / signedMessages()
vault.waitForExecutable(txHash, opts?)
vault.watch(handler, opts?)                       // Supabase Realtime
```

### Social recovery

```ts
vault.recovery.config() / isGuardian(a) / isEnabled() / hasPending()
vault.recovery.get(hash) / pending() / history(page?) / approvals(hash)
vault.recovery.predictHash(newOwners, newThreshold)
vault.recovery.initiate({ newOwners, newThreshold })   // guardians only
vault.recovery.approve(h) / revokeApproval(h) / execute(h) / cancel(h) / expire(h)
vault.recovery.affordances(hash, caller?)
```

Configuring guardians goes through the owner multisig
(`vault.propose.setupRecovery({ guardians, threshold, recoveryPeriodSeconds })`); everything
after that is guardian-driven. `cancel` is callable by any current vault owner — the owners'
defence against a hostile or mistaken guardian action.

Recovery status is derived from timestamps rather than read from a stored flag. Nothing
transitions a recovery to expired on its own: `expireRecovery` is a permissionless cleanup
call somebody has to make, so an un-cleaned recovery still reads as `pending` in the
indexer long after its deadline. `execute()` also pre-checks the transient owner count,
because new owners are added before old ones are removed and a fully disjoint replacement
can momentarily exceed the 20-owner cap.

### Vault writes

```ts
vault.propose.call / transfer / erc20Transfer / erc721Transfer / erc1155Transfer / batch
vault.propose.addOwner / removeOwner / changeThreshold / setMinExecutionDelay
vault.propose.enableModule / disableModule
vault.propose.addDelegatecallTarget / removeDelegatecallTarget
vault.propose.cancelByConsensus / signMessage / approveHashForEip1271 / setupRecovery

vault.approve(h) / approveAndExecute(h) / execute(h) / revokeApproval(h) / cancel(h) / expire(h)
```

`waitForExecutable` polls the chain until a transaction is `ready`, and fails fast rather
than spinning when waiting cannot help — below quorum, or already terminal.

Every `propose.*` accepts `{ expiration, executionDelay, dryRun }`. With `dryRun: true` you
get the encoded calldata, a gas estimate, and any predicted revert — without signing.

Preconditions are checked client-side against the contract's real rules, so failures name
the fix. Removing an owner below the threshold, batching without MultiSendCallOnly
whitelisted, or executing a `disableModule` proposal whose module list has since changed all
raise typed errors rather than reverting on chain.

### Errors

All errors extend `QuaiVaultError` with a stable `code`, a `remediation` string, and
`toJSON()`. Reverts are decoded against every QuaiVault ABI — 73 custom error selectors —
and rendered with guidance:

```
NotEnoughApprovals — The approval threshold has not been reached yet.
DelegateCallNotAllowed(0x00…) — DelegateCall targets must be explicitly whitelisted.
  Propose addDelegatecallTarget for this address first.
```

### Balances

```ts
const { native, tokens } = await vault.balances();
```

Token discovery is indexer-driven — the chain cannot answer "which contracts has this
address touched" without scanning every log. Amounts are then verified on chain by default,
because replaying transfers misses anything the indexer did not observe. Pass
`{ verify: false }` to skip the reads.

### Waiting for the indexer

A transaction confirmed at block N is not queryable until the indexer reaches N. Proposing
and then immediately listing will silently miss it:

```ts
const { txHash, chainTxHash } = await vault.propose.transfer({ to, amount });

await vault.waitForIndexer();          // or waitForIndexer(blockNumber)
const pending = await vault.pendingTransactions();   // now includes it
```

Returns `{ reached, lastIndexedBlock }` rather than throwing on timeout — a lagging indexer
is an expected operating condition, and the caller may prefer to fall back to a chain read.
With no argument it targets the current head of the vault's own Quai zone, derived from its
address (there is no single chain head on a sharded network).

### Realtime

```ts
const sub = vault.watch((e) => console.log(e.topic, e.type), {
  topics: ['transactions', 'confirmations', 'owners'],
});
await sub.unsubscribe();
```

All topics share one channel per vault. Events fire after the *indexer* processes a block,
so treat them as a signal to re-read rather than as state themselves.

### Standalone utilities

Usable without a client:

```ts
import {
  predictVaultAddress, mineSalt, shardPrefixOf,   // CREATE2
  selfCall, tokenCalls, encodeMultiSend,          // encoding
  decodeCall, decodeMultiSendPayload,             // decoding
  classifyExecution, deriveStatus, deriveRecoveryStatus, computeAffordances,
  decodeRevert, knownErrorSelectors,
} from '@quaivault/sdk';

import { QuaiVaultAbi, QuaiVaultFactoryAbi } from '@quaivault/sdk/abi';
```

## Quai addresses only

Quai has two ledgers. **Qi is a UTXO ledger with no contract execution**, so a Qi address
can never sign a vault transaction, approve a recovery, or receive value that stays on the
Quai side. The contracts do not check for this — `_addOwner` rejects only the zero address,
the vault itself, and the module sentinel — so a Qi owner is dead weight against the
threshold, and enough of them brick the vault permanently.

Two independent properties are encoded in an address, and both must hold:

| Property | Where | Valid |
|---|---|---|
| Zone | first byte | `0x00`–`0x02`, `0x10`–`0x12`, `0x20`–`0x22` |
| Ledger | 9th bit (high bit of the second byte) | clear = Quai, set = Qi |

They are orthogonal: `0x0081…` is in a real zone but is Qi, and `0x7E11…` is Quai-ledger
but in no zone. The SDK rejects both wherever an address is committed to a role or receives
value — owners, guardians, recovery owners, modules, delegatecall targets, transfer
recipients, the signing key, and the vault address itself.

Removals stay permissive on purpose: a vault that admitted a bad address before this check
existed must still be able to remove it.

```ts
import { assertQuaiAddress, isUsableQuaiAddress, inspectAddress } from '@quaivault/sdk';

isUsableQuaiAddress('0x0081…');   // false — Qi ledger
inspectAddress('0x0081…');        // { valid: false, zone: '0x00', ledger: 'qi', reason: … }
```

## Resilience

Reads retry transient RPC and indexer failures with exponential backoff and full jitter:

```ts
const qv = connect({
  network: 'mainnet',
  retry: { maxAttempts: 4, baseDelayMs: 250, onRetry: ({ attempt, error }) => log(attempt, error) },
});
```

**Writes are never retried.** A resubmit that looks like a timeout to the client may already
be in the mempool, so retrying risks a double broadcast. Only reads go through the policy.

The classifier errs toward *not* retrying: reverts (`CALL_EXCEPTION`), user rejections,
nonce and funds errors are permanent by definition, and anything unrecognised is treated as
permanent too — so a genuine bug surfaces immediately instead of hiding behind three slow
attempts. Rate limits, 5xx and raw transport failures are retried.

## Describing calls to contracts the SDK doesn't know

`decodeCall` ships ABIs for the vault, factory, recovery module, MultiSend and the token
standards. Anything else renders honestly but bluntly:

```
Call 0x0033…3333 (selector 0xa9059cbb)
```

Supply an ABI and it gets described instead:

```ts
const qv = connect({
  network: 'mainnet',
  abis: abiRegistry({ '0x0033…': stakingAbi }),
});
```

Every decode carries `abiSource` — `builtin`, `supplied`, or `none` — and it is a required
field, not an optional one. In a multisig the summary is what owners read before approving,
so "we decoded this" and "we decoded this using an ABI someone handed us" must not render
identically.

Supplied ABIs are address-keyed, consulted only after every built-in match, and cannot
change how a vault self-call or a known module call is read. `DecodedCall.selector` is
surfaced so a reviewer can check the claimed function against an independent source — the
only defence against a colliding selector, which the SDK cannot detect on its own.

The SDK does not fetch ABIs. See the
[ABI resolution design note](https://github.com/Quai-Vault/quaivault-sdk/blob/main/docs/design-abi-resolution.md)
for why — including measurements against the Quai IPFS gateways, one of which does not
exist and the other of which resolves some contracts and hangs on others.

## Clock skew

The contracts decide with `block.timestamp`. Everything the SDK derives locally — a
transaction's `ready` vs `timelocked`, what a caller may do next, whether a recovery period
has elapsed — predicts that, and a machine whose clock is wrong predicts wrongly.
Containers, CI runners and VMs resumed from a snapshot drift in ways a desktop usually
does not.

If you have measured the offset, feed it back in:

```ts
const block = await qv.provider.getBlock('latest');
const skew = Date.now() / 1000 - Number(block.timestamp);   // positive: local clock ahead

const qv = connect({ network: 'mainnet', now: () => Date.now() / 1000 - skew });
```

A function rather than a scalar offset on purpose: an offset needs a sign convention, and
getting it backwards doubles the error instead of cancelling it, silently. Here the
arithmetic sits in your code, where it reads as what it means.

Detection is deliberately yours. Deriving the offset costs an RPC call the SDK should not
make on your behalf, and caching one has no clear invalidation.

**This never touches elapsed-time measurement** — retry backoff, timeouts, poll intervals
and cache TTLs stay on the raw local clock. A clock being 12 seconds fast does not make 30
seconds of backoff into 18.

Nothing here can change an on-chain outcome; the chain is the authority and a wrong local
time fails safe into a revert or a refusal. What it changes is what the SDK *tells* you,
which is most of what the SDK is for.

## Development

```bash
npm run sync-abis     # regenerate src/abi from quaivault-contracts artifacts
npm run sync-abis -- --check   # CI drift check
npm run typecheck
npm test
npm run build
```

ABIs are generated from `quaivault-contracts/artifacts`. The SDK is the single distribution
point — do not hand-edit `src/abi/*.json`.

## Publishing

The package is `@quaivault/sdk` — scoped, so `publishConfig.access` is set to `public`
(scoped packages default to restricted and would otherwise fail to publish).

```bash
npm run sync-abis -- --check   # fail if ABIs drifted from quaivault-contracts
npm run typecheck
npm test
npm run build
npm pack                       # inspect the tarball before publishing
npm publish
```

`prepublishOnly` runs the first four automatically, so `npm publish` cannot ship a build
that fails a check or a stale ABI.

Releases go out through **npm trusted publishing**: push a `v*` tag and the release
workflow exchanges a GitHub OIDC token for a short-lived, workflow-scoped npm credential.
There is no `NPM_TOKEN` to leak or rotate, and provenance attestations are generated
automatically because the repository is public.

The trusted publisher is configured in the package's settings on npmjs.com and names
`release.yml` exactly. npm does not validate that configuration when it is saved, so a
mismatch in the org, repo or workflow filename only surfaces as a failed publish.

`npm publish` from a workstation still works and is what bootstrapped `0.1.0` — a package
must exist before a trusted publisher can be attached to it.

**Version pinning.** `quais` is tracked with `~1.0.0-alpha.53` rather than `^`. It is still
pre-1.0, so a caret range would allow 1.x minors that may change the API before release;
the tilde keeps consumers on the alpha line this SDK is verified against (alpha.53 and
alpha.55).

## License

MIT
