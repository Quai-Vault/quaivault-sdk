# Response: pin the Supabase dependencies exactly

**To:** the `quaivault-cli` effort
**Re:** [`request-dependency-pinning.md`](./request-dependency-pinning.md)
**Against:** `@quaivault/sdk` 0.5.0
**Verdict:** taken. Both packages pinned exactly, bumped deliberately to 2.111.0, with
Dependabot added to discharge the obligation that a pin creates.

Three specifics in the request are wrong, and one thing it does not mention cuts the other
way — but none of that changes the answer.

---

## Verification

Every figure was re-checked using the commands supplied. What holds:

- Declares `^2.110.9`, locks `2.110.9`, a consumer resolves **2.111.0**. Confirmed,
  including inside an `npm install -g` tree.
- The published tarball contains **only `package.json`** — no lockfile is ever shipped, so
  the SDK's lockfile governs its own CI and nothing else.
- `overrides` in a *dependency's* manifest is ignored. Confirmed → `2.111.0`.
- `npm install -g` has no lockfile. Confirmed.
- `zod` 3.x is frozen: **0** releases in 30 days. Excluding it was correct.
- `ci.yml`'s tarball job does fresh-resolve, as credited.
- The `quais` precedent and the inconsistency are real.

### Correction 1 — the release figure overstates the exposure

32 releases per package in 30 days, but only **12 are stable**. The other 20 are canaries,
and a caret does not install prereleases. The caret-admitted surface is 12/month/package,
not 32 — still substantial, and still the core of a sound argument, but roughly 2.6× smaller
than stated. Worth getting right, because the number is doing persuasive work.

### Correction 2 — consumers *can* fix this, except in the case that matters to you

Dependency-level `overrides` is ignored, as reported. But **root-level `overrides` works**:

```
root package.json with overrides: { "@supabase/postgrest-js": "2.110.9" }
  → resolved 2.110.9
```

So an application consumer is not helpless. What is genuinely unfixable is
`npm install -g` and `npx`, which have no manifest to host an override — and that is the
CLI's distribution model. The conclusion survives; the stated reason is broader than the
evidence supports. It is a global-install argument, not a general one, and it is stronger
for being narrowed.

### Correction 3 — the middle option is not a middle, and fails its own purpose

`~2.110.9` admits exactly **one** version — `2.110.9` itself — because upstream has already
moved to 2.111 and will not back-patch the 2.110 line. It is an exact pin with a misleading
name.

Worse, it was offered so security patches would still flow automatically, and it would not
deliver them: a fix shipped as `2.111.1` falls outside the range. The option fails the test
it was proposed to pass, so it is declined on evidence rather than preference. It also has a
latent hazard — if Supabase ever *did* back-patch 2.110, a range everyone had stopped
thinking about would quietly start admitting versions again.

## What the request does not consider

**Exact pinning in a library causes duplicate installs**, because a pin cannot be deduped
against a consumer's own dependency on the same package. The `quais` pin from 0.2.0 already
does this today:

```
node_modules/quais                              -> 1.0.0-alpha.56   (the consumer's)
node_modules/@quaivault/sdk/node_modules/quais  -> 1.0.0-alpha.55   (our pin)
```

That is ~200 KB gzip duplicated, which dwarfs the 34 KB saved in 0.2.0 by dropping the
Supabase umbrella package. Checked whether it is also *broken*: it is not. quais duck-types
rather than using `instanceof`, so a consumer-built provider and signer both work through
the SDK's copy — verified against mainnet with a live read and a signer address.

For the two packages actually under request the objection is weak: only
`@supabase/supabase-js` depends on those subpackages, so duplication requires a consumer
using supabase-js directly. Which means **the strongest objection to this request applies
mostly to the pin already in place**, not to the one being asked for. See the follow-up
below.

## What changed

- `@supabase/postgrest-js` and `@supabase/realtime-js`: `^2.110.9` → **`2.111.0`**, exact.

  Bumped rather than frozen at the previously-locked 2.110.9, because "pin and bump
  deliberately" is only meaningful if the pinned version is one somebody reviewed. 2.111.0
  is a version this SDK had never run against, and the hand-rolled PostgREST auth wiring
  (`/rest/v1`, `apikey` + `Authorization: Bearer`) fails at runtime rather than compile
  time — so it was verified against the live mainnet indexer, not just the offline suite:
  authenticated read, paged select with estimated count, and a realtime channel reaching
  `SUBSCRIBED`.

- `.github/dependabot.yml`: weekly version-update PRs, scoped to the three pinned
  dependencies only. The two Supabase packages are **grouped** — they release in lockstep,
  both having walked 2.109 → 2.110 → 2.111 over the same month, so separate PRs would
  conflict and neither would be mergeable alone.

  This is not optional garnish. The request is right that pinning inverts the failure mode:
  without a standing reminder, "pinned" decays into "stuck on a known-vulnerable version",
  which is the same immovability the request objects to, pointed the other way. Dependabot
  over Renovate purely because it needs no app install — a file in the repo cannot silently
  fail to be enabled.

`zod` untouched, as requested and for the reason given.

## Follow-up, not bundled here

**Reconsider the `quais` pin.** The SDK's public API exposes quais types — `Provider`,
`Signer`, `InterfaceAbi` — which means consumer and library must agree on that object graph
for the types to line up. That is the textbook signal for a `peerDependency`, and it would
guarantee a single copy rather than the duplication measured above. npm 7+ auto-installs
peers, so zero-config install mostly survives.

Not done here because it is a breaking change and it contradicts an explicit decision in
`PLAN.md` ("`quais` is a direct dependency, not a peer"). Reversing that deserves its own
discussion rather than being smuggled into a dependency-pinning commit.

## On the process

Four of five earlier asks were withdrawn once the CLI team found they could handle them
themselves. That filter is why this one was worth reading closely, and it is worth saying
so: a request that has already survived "can we just do this ourselves?" arrives with most
of the noise removed. The three corrections above are refinements to the argument, not
reasons to doubt the instinct behind it.
