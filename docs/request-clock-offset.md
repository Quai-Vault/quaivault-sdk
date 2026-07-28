# Request: expose a clock offset on `connect()`

**From:** the `quaivault-cli` effort
**Against:** `@quaivault/sdk` 0.2.0
**Status:** request for comment — no code written, nothing assumed
**Severity:** important, not blocking. The CLI can ship v1 without it.

---

## The ask, in one paragraph

Add an optional clock offset to `ClientOptions` — `clockOffsetSeconds?: number` or
`now?: () => number` — and thread it into the default `at` that the SDK's own lifecycle
functions already accept. Roughly ten call sites. No behaviour changes when the option is
absent.

## What this is *not*

An earlier draft of the CLI plan phrased this as "the SDK dropped clock-skew support." That was
wrong, and we want to correct it up front, because it misrepresents work you already did.

**The SDK already parameterises time at every decision point:**

| Function | Signature | Exported |
|---|---|---|
| `deriveStatus` | `(state, at: number = nowSeconds())` | yes |
| `deriveRecoveryStatus` | `(state, at: number = nowSeconds())` | yes |
| `computeAffordances` | `(ctx: AffordanceContext)` where `AffordanceContext.at?: number` | yes |

The design work is done, and it was done correctly — time is an input, not an ambient read, in
exactly the three places where the contract's rules are reproduced. This request is narrower: the
**ergonomic layer that consumers actually call does not expose what its own internals accept.**

## What's actually missing

Every public path below computes time internally with no way for a caller to influence it. Line
numbers are 0.2.0.

**Never passes an `at` to a function that accepts one:**

| Call site | Method | Consequence |
|---|---|---|
| `vault.ts:533` | `transaction()` / list hydration (indexer) | `VaultTransaction.status` |
| `vault.ts:627` | `transaction()` (chain) | `VaultTransaction.status` |
| `vault.ts:689` | `affordances()` | every `allowed` / `availableAt` |
| `recovery.ts:172` | `pending()` / `history()` | recovery status |
| `recovery.ts:505` | `get()` | recovery status |

**Reads the clock inline, not parameterised at all:**

| Call site | Method | Consequence |
|---|---|---|
| `outcome.ts:125` | `classifyExecution()` — `Math.floor(Date.now()/1000)` | picks `timelock_started` vs `approved_only` |
| `recovery.ts:311, 388, 556` | recovery preconditions | client-side gate before a write |
| `vault.ts:1445` | `waitForExecutable()` | poll/backoff arithmetic |
| `vault.ts:211` | `view()` → `capturedAt` | cosmetic; staleness display only |

`outcome.ts:125` is the one we'd highlight. It runs immediately after a write, on a receipt, and
picks between two *discriminated outcomes* — the feature the README leads with. A skewed clock
makes it report `approved_only` when the timelock actually started, or the reverse. The consumer
then tells the user the wrong thing about a transaction that just touched their funds, and any
script switching on `outcome` branches wrong.

## Why we think it's fair to ask, rather than just handle ourselves

**1. It is not a CLI-specific problem.** `quaivault-frontend` independently hit this and built
`src/utils/clockSkew.ts` — `detectClockSkew(blockTimestamp)`, `getAdjustedNowSeconds()`,
`hasClockSkew()`, a 60-second threshold — and routes its timelock and expiry decisions through it,
with a user-facing warning banner. Two of the three known consumers have needed this. The third
(the SDK's own test suite) doesn't, because it controls the clock.

**2. The workaround requires abandoning the public API.** A consumer wanting adjusted affordances
must rebuild `AffordanceContext` by hand. That needs `hasApproved`, which is **not public on
`Vault`** — it exists only on the internal contract facade (`vault.ts:686`). So the options are to
reimplement `affordances()` against the raw contract, or accept unadjusted time. Neither is a
good outcome for a feature the SDK is right to consider its best.

**3. It is small and additive.** One option, one resolved value on the context, ~10 threading
sites, no behaviour change when unset. It does not expand the SDK's network surface, add a
dependency, or change any existing signature incompatibly.

**4. A CLI runs where clocks are worse.** Browsers are usually NTP-synced by the OS and corrected
aggressively. Containers, CI runners, VMs resumed from snapshot, and air-gapped machines are not.
This doesn't make it our problem exclusively — it makes it the environment where the existing
`Date.now()` assumption breaks most often.

## Proposed shape

Preference is (A) for its smaller surface, but (B) composes better with testing.

**(A) A scalar offset**

```ts
connect({ network: 'mainnet', clockOffsetSeconds: -12 });
```

Resolved once into `ResolvedConfig`, applied as `nowSeconds() - offset` wherever the SDK currently
calls `nowSeconds()`. The consumer decides how to obtain it. Trivial to serialise, log, and
display.

**(B) An injectable clock**

```ts
connect({ network: 'mainnet', now: () => Date.now() / 1000 - offset });
```

Strictly more general, and it gives the test suite a deterministic clock without
`vi.useFakeTimers()`. Slightly larger conceptual surface.

Either way we'd suggest **also accepting `at` on the public methods that already have somewhere to
put it** — `affordances(txHash, caller, at?)` and friends — since that costs nothing once the
plumbing exists and makes the behaviour testable per call.

**Explicitly not requested:** automatic detection. Deriving the offset means fetching a block
timestamp, and we don't think the SDK should make an extra RPC call on behalf of a consumer who
may not want it, or cache a value with unclear invalidation. Detection is the consumer's job.
`indexerHealth()` already gives us a cheap hook to do it near.

## Where we might be wrong

Recording the counter-arguments, because we don't think they're weak:

- **"Time is the consumer's responsibility."** Defensible. The pure functions take `at`; a
  consumer sufficiently motivated can use them. Our counter is that `hasApproved` being private
  makes the composition path genuinely blocked rather than merely inconvenient — but if you'd
  rather make `hasApproved` public and leave the clock alone, **that would satisfy us too**, and
  it's a smaller change.
- **"An offset is itself a footgun."** A stale or wrongly-signed offset is worse than none. Real
  risk. Mitigations: make it explicit rather than auto-detected, and give it a sign convention in
  the type docs (we'd suggest *positive = local clock ahead of chain*, matching the frontend's
  `clockOffsetSeconds = localNow - blockTimestamp`).
- **"Nobody has actually hit this in production."** True as far as we know. The argument here is
  structural rather than incident-driven, and we'd understand weighting it accordingly.

## If you decline

No hard feelings and no blocker. The CLI will:

1. Detect skew against a block timestamp in `qv doctor` and at startup.
2. Print a warning on any output whose correctness depends on local time.
3. Tell the user to fix their clock rather than silently compensating.

That's a legitimate posture — it just relocates a correctness concern onto the user, in a place
the SDK is better positioned to absorb once, for everyone.

## Verification

Every claim above was checked against 0.2.0 at `c8e5168`:

```bash
# time is already a parameter in all three lifecycle functions
grep -nE "at\??: ?number" src/lifecycle/status.ts src/lifecycle/affordances.ts

# ...and every place the ergonomic layer declines to pass one
grep -nE "deriveStatus\(|computeAffordances\(|deriveRecoveryStatus\(" src/vault.ts src/recovery.ts

# the inline reads
grep -rn "nowSeconds()" src/
grep -n "Date.now" src/lifecycle/outcome.ts

# hasApproved is not public on Vault
grep -n "hasApproved" src/vault.ts
```
