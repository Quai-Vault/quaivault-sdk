# Response: clock offset on `connect()`

**To:** the `quaivault-cli` effort
**Re:** [`request-clock-offset.md`](./request-clock-offset.md)
**Against:** `@quaivault/sdk` 0.2.0 at `c8e5168`
**Verdict:** implement, with three modifications — one of which removes the need for the
option at the site the request calls most important.

---

## Verification

Every factual claim in the request was re-checked, using the commands it supplied. All of
them hold:

- `deriveStatus`, `deriveRecoveryStatus` and `computeAffordances` do take time as a
  parameter (`status.ts:39,91`, `affordances.ts:10,43`).
- All five listed call sites do decline to pass one (`vault.ts:533,627,689`,
  `recovery.ts:172,505`).
- The inline reads are where stated (`outcome.ts:125`, `recovery.ts:311,388,556`,
  `vault.ts:211`).
- `hasApproved` really is absent from `Vault`'s public surface — it appears only on the
  internal `VaultContract` facade (`vault.ts:593,686,1093,1112,1154`). The composition
  path is genuinely blocked, not merely awkward.
- `quaivault-frontend/src/utils/clockSkew.ts` exists and works as described, including the
  `localNow - blockTimestamp` sign convention.

Two corrections, and one addition:

**The `vault.ts:1445` label is wrong.** That line is in `describe()`, not
`waitForExecutable()`. The actual clock reads in `waitForExecutable` are at
`vault.ts:1380,1408,1411`. This matters more than a typo, because those three are
*duration* arithmetic — see "the distinction that must not be missed" below.

**The frontend does not depend on the SDK.** `@quaivault/sdk` is not in its
`package.json`; it has its own contract layer. So "two of three consumers have needed
this" is true of the *problem* but not of *this API* — the frontend never wanted a clock
option from us and could not have used one. That weakens the request's second-strongest
argument. It does not weaken the first: the problem is real and recurs in this domain.

**A sixth site the request missed, and it is not a minor one.** `minimumExpiration`
(`encode/index.ts:218-225`) is a *fourth* function that already accepts `at` and whose
callers already decline to pass it (`vault.ts:983,988`). It gates proposal validation
against the contract's `ExpirationTooSoon` rule, and line 988 prints a concrete timestamp
as remediation advice. Under skew the SDK will reject expirations the contract would
accept, and — worse — tell the user a specific wrong number to use instead, which they
then commit to a proposal. If the option lands, this site should be in scope.

---

## 1. The headline case should not be fixed with a clock at all

The request singles out `outcome.ts:125` — the `timelock_started` vs `approved_only`
discrimination — as the most consequential site. Agreed on the importance. Disagreed on
the fix.

The event carries everything needed:

```solidity
ThresholdReached(bytes32 txHash, uint48 approvedAt, uint256 executableAfter)
```

Both fields come from the same chain event, computed under the same `block.timestamp`.
The question "did a timelock start?" is exactly `executableAfter > approvedAt`:

- `executionDelay == 0` → `executableAfter == approvedAt` → `approved_only`
- `executionDelay > 0` → `executableAfter > approvedAt` → `timelock_started`

That is *exact*, needs no configuration, costs no RPC call, and cannot be defeated by a
skewed or wrongly-signed offset. The current `executableAfter > Date.now()/1000` is a
proxy for it that happens to work whenever local skew is smaller than the delay — so a
vault with a 60-second timelock misclassifies under two minutes of drift, while one with a
24-hour timelock never does. That difference is invisible and the failure is silent.

**This is a bug worth fixing on its own merits, independent of whether the option lands.**
It also means the request's strongest argument for the option no longer argues for it.

## 2. The distinction that must not be missed

The request treats every clock read as one category. They are two, and conflating them
would introduce bugs while fixing one:

| Kind | Examples | Gets the clock? |
|---|---|---|
| **Absolute** — a Unix-seconds value compared against a chain timestamp | `deriveStatus`, `computeAffordances`, `deriveRecoveryStatus`, `minimumExpiration`, recovery preconditions | **Yes** |
| **Duration** — elapsed local time, measured start-to-finish | retry backoff, salt-mining timeout, health-cache TTL, `waitForBlock`/`waitForExecutable` deadlines and poll intervals | **No** |

Offsetting a duration is a category error: if the clock is 12 seconds fast, a 30-second
timeout is still 30 seconds. A naive implementation replacing every `Date.now()` would
silently corrupt retry pacing and mining timeouts.

The rule is clean enough to state and enforce: **`nowSeconds()` gets the injected clock;
raw `Date.now()` used for elapsed time does not.** Today that splits the sites correctly
with two exceptions, both of which want fixing anyway — `outcome.ts:125` (removed by §1)
and `encode/index.ts:223` (should call `nowSeconds()`).

## 3. Shape: prefer (B), the injectable clock

The request prefers (A), the scalar `clockOffsetSeconds`. Recommend (B), `now?: () => number`:

- **It eliminates the footgun the request itself identified.** A scalar needs a documented
  sign convention, and `nowSeconds() - offset` is easy to write as `+ offset`. The failure
  is silent and doubles the error. With `now`, the consumer writes the arithmetic where
  the meaning is visible — `() => Date.now() / 1000 - offset` reads as what it does.
- **It subsumes (A).** Anything a scalar expresses, a closure expresses.
- **It makes the SDK's own tests better.** A deterministic clock without
  `vi.useFakeTimers()`, which currently cannot be used here anyway because the duration
  paths need real timers.

(A)'s genuine advantage — being serialisable and displayable — belongs to the consumer
regardless: the CLI must hold the scalar itself to have detected it, and `qv doctor` can
print it without the SDK knowing.

Agreed on also accepting `at` on the public methods that have somewhere to put it. Agreed
on **not** doing automatic detection, for exactly the reasons given.

## 4. `hasApproved` should be public regardless

The request offers this as an alternative that would satisfy it. It should happen either
way. `Vault` exposes `isOwner()` but not `hasApproved()`, which is an arbitrary gap in a
read surface that is otherwise complete — and it is the reason the documented composition
path is blocked rather than merely inconvenient. One method, no new concepts.

---

## Why implement

**The design is already committed; the boundary is where it stops.** Three — really four —
internal functions take time as a parameter, deliberately, with comments explaining why.
The ergonomic layer then hardcodes it. That is not a considered decision to own the clock;
it is an unfinished one, and the request is right to read it that way.

**Reporting correctness is this SDK's headline feature.** The strongest argument *against*
is that no clock skew can produce a wrong on-chain outcome — the contract uses
`block.timestamp`, so everything here is prediction and display, and every affected path
fails safe into a revert or a refusal. That is true and worth stating plainly. But the
SDK's distinguishing claims are the discriminated `ExecuteResult` and the affordance
model — *telling the user the truth about what happened and what they may do next*. A
library whose selling point is honest reporting should not report confidently from an
input it knows may be wrong.

**The cost is small and the blast radius is bounded.** One option, one resolved value on
`VaultContext`, ~10 threading sites, no signature changed incompatibly, no behaviour change
when unset, no new dependency, no new network call.

**It closes a real API gap on the way.** `hasApproved` and the `minimumExpiration` advice
path are worth fixing whether or not the clock option lands.

## Why one might not

Recorded honestly, because they are not weak:

- **Compensating silently leaves the machine broken.** A wrong clock breaks TLS, JWTs and
  log correlation too. Absorbing it in the SDK removes the pressure to fix the cause. The
  CLI's declared fallback — detect, warn, tell the user to fix it — is a defensible
  posture and arguably the more honest one.
- **No production incident.** The argument is structural. That is a legitimate reason to
  weight it below work with a known victim.
- **An offset can be stale.** Detected once at startup, it drifts, and a machine whose
  clock is wrong is often a machine whose clock is *moving* wrong. Mitigated by (B) —
  a closure can re-derive — but not eliminated.

None of these outweigh a half-day change that finishes work already begun. They do argue
for making the option explicit, never auto-detected, and documented as compensation rather
than a fix — which is what the request proposes.

## Recommendation

1. **Fix `classifyExecution` to use `executableAfter > approvedAt`.** Independent bug fix.
   Do this first, and regardless of the rest.
2. **Make `hasApproved` public on `Vault`.** Independent API gap.
3. **Add `now?: () => number` to `ClientOptions`**, resolve it into `ResolvedConfig` and
   `VaultContext`, and thread it into the absolute-time sites only — including
   `minimumExpiration`, which the request missed.
4. **Accept `at?: number` on `affordances()` and the status-returning reads**, now that the
   plumbing exists.
5. **Leave every duration path on the raw local clock**, with a comment saying why, so the
   next person does not "fix" the inconsistency.

Estimated: ~200 lines including tests, most of it threading. Items 1 and 2 are worth doing
even if 3–5 are declined.

---

## Outcome — shipped in 0.2.1

All five recommendations implemented. One deliberate narrowing against item 4:

**`at?` went onto the two `affordances()` methods only, not onto the status-returning
reads.** The response proposed both. On implementation the second half did not earn its
surface: asking "what was this transaction's status at time T" for a record you are
fetching *now* has no realistic caller, and `deriveStatus` is already exported for anyone
who genuinely wants it. The client-level clock covers the real case. Affordances kept the
parameter because per-call time control is what makes them testable.

Verification worth noting: the pre-existing `classifyExecution` tests passed unchanged
against both the old and new logic, because every fixture derived its timestamps from
`Date.now()`. A test suite that anchors to the same clock as the code cannot observe the
code depending on that clock. The replacement cases sit two decades either side of the
local clock and diverge from the old implementation in opposite directions.

Not done, and not requested: automatic skew detection. Still the consumer's job, for the
reasons the request itself gave.
