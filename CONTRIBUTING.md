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

## Tests

Unit tests are pure and offline; a few (`salt`, `address`) construct clients but make no
network calls in assertions. When adding a test that would hit the network, prefer a
recorded fixture.

Behaviour that mirrors a contract rule should say so in the test name or a comment, so the
test explains the constraint rather than just pinning current output.
