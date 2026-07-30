# Contributing

## Setup

```bash
npm install
npm run sync-abis     # generate src/abi from the quaivault-contracts artifacts
```

`sync-abis` expects `quaivault-contracts` as a sibling directory with compiled artifacts.
Point elsewhere with `npm run sync-abis -- --contracts <path>`.

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

All four run automatically via `prepublishOnly`, so a release cannot ship a failing build
or a stale ABI.

## Releasing

Tag and push: `git tag v0.2.0 && git push origin v0.2.0`. The release workflow verifies the
tag matches `package.json`, re-runs the gate against freshly compiled contracts, and
publishes through trusted publishing (OIDC — no token). Bump the version and update
`CHANGELOG.md` in the same commit the tag points at.

## Conventions

- **ABIs are generated.** Never hand-edit `src/abi/*.json`; change the contracts and re-run
  `sync-abis`. CI fails on drift.
- **Comments explain why, not what.** The contracts have several non-obvious behaviours —
  epoch-based approvals, the lazy timelock clock, Option-B execution failure — and the
  reason a code path exists is usually more valuable than a restatement of it.
- **Reads may retry; writes may not.** See `src/chain/retry.ts`.
- **Addresses entering a role or receiving value go through `assertQuaiAddress`.** Removal
  paths deliberately stay permissive.
- **No `console` in `src/`.** A library should return or throw, not print. Lint enforces it.
- **`quais` and the Supabase transport packages are pinned exactly, not ranged.** A
  published tarball ships no lockfile, so a range means the version CI validated is not the
  version consumers install — and `npm install -g` gives them no way to override it. Bump
  the pins deliberately, with the suite as the gate; `.github/dependabot.yml` raises the PRs.
  Do not "fix" these to ranges.
- **A Supabase bump needs a live check, not just the suite.** The PostgREST wiring is
  hand-rolled (`/rest/v1`, `apikey` + `Authorization: Bearer`) because the SDK depends on the
  subpackages rather than the umbrella. Break it and nothing fails until a real request is
  made against a real indexer.
- **Attacker-controlled strings go through `sanitizeText` before they land in a
  human-facing field.** Token `symbol`/`name` and revert reasons are chosen by whoever
  deployed the contract; consumers render them in terminals. Machine-readable fields
  (`DecodedRevert.args`) keep the raw bytes. See `src/text.ts`.

## Tests

Unit tests are pure and offline; a few (`salt`, `address`) construct clients but make no
network calls in assertions. When adding a test that would hit the network, prefer a
recorded fixture.

Behaviour that mirrors a contract rule should say so in the test name or a comment, so the
test explains the constraint rather than just pinning current output.
