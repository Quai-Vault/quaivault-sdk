# Request: pin the Supabase dependencies exactly

**From:** the `quaivault-cli` effort
**Against:** `@quaivault/sdk` 0.5.0
**Status:** request for comment
**Size:** two characters, or two lines if you take the middle option
**Severity:** low likelihood, high consequence. Not blocking.

---

## The ask

Change `@supabase/postgrest-js` and `@supabase/realtime-js` from `^2.110.9` to exact versions, and
bump them deliberately — the same treatment `quais` already gets.

`zod` is **not** part of this ask. See "what this excludes."

## The concrete gap, today

CI installs with `npm ci`, which uses the committed lockfile:

```
package-lock.json → @supabase/postgrest-js 2.110.9
                    @supabase/realtime-js  2.110.9
```

A consumer runs `npm install @quaivault/sdk`, which resolves the caret fresh:

```
2.111.0   (published 2026-07-28)
```

**The version CI validated is not the version consumers install.** That gap opened the day after
2.110.9 was locked, and it reopens roughly every day — those two packages published **31 releases
in the last 30 days**.

Credit where due: the tarball job (`ci.yml:54`) *does* fresh-resolve, so a hard break would be
caught at CI time. But it validates at *CI-run* time, not at *consumer-install* time, and those
diverge again with the next Supabase publish.

## Why, on general merit

The argument is **not** "Supabase will break the API." Semver says a 2.x minor should not, and we
have no evidence they have. It is three other things:

1. **Reproducibility.** `@quaivault/sdk@0.5.0` does not currently name a fixed dependency set, so
   it denotes different code on different days. For a library on a signing path, "which bytes ran"
   is a question worth being able to answer — for incident response as much as for debugging.
2. **Supply chain.** One publish per day is a large surface, and it reaches every fresh install with
   no human in the loop. The realistic threat here is a compromised publish, not a bad refactor,
   and npm account compromise has repeatedly been the vector in this ecosystem. An exact pin puts a
   person between a hostile version and every consumer.
3. **Precedent, and consistency.** `sdk-review-2026-07.md` finding 6 pinned `quais` on this
   reasoning: *"an `npm install` on any given day can pull a breaking change into a published
   SDK. Fix: pin exactly and bump deliberately."* The transport layer that speaks to the indexer is
   a smaller blast radius than the chain library, but it is the same class of exposure, and right
   now the SDK treats them differently for no stated reason.

## What we checked before asking

Whether the consumer can fix this themselves. **They cannot** — which is what turned this from a
preference into a request.

- `overrides` in a *dependency's* `package.json` is ignored. Tested directly: a package declaring
  `overrides: { "@supabase/postgrest-js": "2.110.9" }` alongside `@quaivault/sdk@0.5.0` still
  resolved **2.111.0**.
- `npm install -g` and `npx` ignore lockfiles entirely, so a CLI consumer cannot pin transitively
  even with a committed lockfile of its own.

Four of our five earlier asks were withdrawn once we found we could handle them ourselves. This one
survived that test.

## What this excludes

**`zod: ^3.25.76` — deliberately not part of the ask.** Zod's active line is 4.x, so 3.x is
effectively frozen: **zero releases in the last 30 days**. The caret there admits almost nothing,
and including it would pad the request without improving anything.

## The counter-argument

Recorded because it is real and may be decisive for you.

**Pinning exactly shifts the risk rather than removing it.** Today an unreviewed change arrives
automatically; with an exact pin, a needed security patch arrives only when a maintainer acts. If
the SDK pins and then goes quiet for a month, consumers are stuck on a known-vulnerable transitive
dependency with no way to override it — the same immovability that motivates this request, pointed
the other way.

For a library in a signing path we think the automatic-unreviewed-change risk is the worse one. But
it is a genuine trade, and pinning creates an obligation: something has to watch for advisories on
these two packages. Dependabot or Renovate scoped to security-only updates closes that, and is
probably a precondition for taking this at all.

**A middle option, if the obligation is unwelcome:** `~2.110.9` — patches, not minors. That removes
the minor-version surface (which is where the ~31 monthly releases mostly live) at a fraction of the
maintenance cost. We would consider that a good outcome, not a partial one.

## If you decline

No blocker. The CLI will:

1. Record the exposure in its own `SECURITY.md` rather than implying a guarantee it does not have.
2. Assert in CI that the resolved Supabase versions match a recorded expected set, so a change is
   *visible* to us even though we cannot prevent it.
3. Note in its install docs that `npm install -g` resolves transitive dependencies fresh.

That is strictly worse than a pin — it detects rather than prevents, and only for our own installs,
not for users'. But it is not nothing, and this is your call to make.

## Verification

Every figure above, reproducible:

```bash
# what the SDK declares
node -e "console.log(require('./package.json').dependencies)"

# what CI actually tests (lockfile)
node -e "const l=require('./package-lock.json');
  for (const k of Object.keys(l.packages)) if (/supabase/.test(k)) console.log(k, l.packages[k].version)"

# what a consumer gets today
npm view @supabase/postgrest-js version
npm view @supabase/realtime-js version

# release cadence
npm view @supabase/postgrest-js time --json   # count entries in the last 30 days
npm view zod time --json                      # for contrast: 3.x is frozen

# overrides in a dependency's manifest are ignored
mkdir -p /tmp/ovr/pkg && cd /tmp/ovr/pkg
cat > package.json <<'EOF'
{ "name":"ovr-test","version":"1.0.0",
  "dependencies":{"@quaivault/sdk":"0.5.0"},
  "overrides":{"@supabase/postgrest-js":"2.110.9"} }
EOF
npm pack && mkdir -p /tmp/ovr/consumer && cd /tmp/ovr/consumer && npm init -y
npm install /tmp/ovr/pkg/ovr-test-1.0.0.tgz
node -e "console.log(require('@supabase/postgrest-js/package.json').version)"  # → 2.111.0
```
