# Design note: ABI resolution in the SDK

**Question:** should `@quaivault/sdk` resolve ABIs for arbitrary contracts, the way
`quaivault-frontend/src/services/utils/ContractMetadataService.ts` does, so that proposals
targeting third-party contracts can be described rather than shown as a raw selector?

**Answer:** split three ways. The pure part is the SDK's job and is now implemented.
Network resolution is defensible but belongs behind an explicit opt-in, and one of the two
proposed gateways does not exist. Explorer-sourced ABIs should not be a default.

---

## Why the ABI is a security boundary here

In a multisig, N owners independently review a proposal before approving it. The ABI is
what turns opaque calldata into a human-readable claim about what the transaction will do —
and `DecodeResult.summary` is the sentence they actually read.

If the ABI lies, every reviewer sees the same lie. The multisig's entire defence is that
its approvers are independent; a shared wrong ABI defeats that in one move, and produces
the worst available outcome: N genuine approvals on a transaction nobody understood.

What a hostile ABI can and cannot do:

| | |
|---|---|
| **Types** | Pinned. The 4-byte selector fixes the signature, so `transfer(address,uint256)` cannot be relabelled as a different shape. |
| **Parameter names** | Not pinned. `foo(uint256 harmless)` and `foo(uint256 lifeSavings)` share a selector, and the SDK's own `describeErc20` reads `args.amount` by name. |
| **Selectors** | Collidable. Four bytes is 2³², and finding a second signature with a chosen selector is a documented attack. A contract can ship an ABI whose function collides with what it actually does; decoding "succeeds" and displays the wrong thing. |

The SDK cannot detect a collision. What it can do is refuse to hide the ambiguity — which
is what drove the shape below.

## The counter-argument, which nearly wins

Before this change, an unrecognised call rendered as:

```
Call 0x0033…3333 (selector 0xa9059cbb)
```

Unhelpful, but *honest*: it says "I do not know what this does." ABI resolution replaces a
safe non-answer with a possibly-wrong answer, and in a system where the wrong answer gets
approved by three people, that is a real downgrade in the failure case.

This is why the frontend's design — one `fetchAbi()` returning a `source` field the caller
is free to ignore — is the wrong shape to port. The flattening of three very different
trust levels into one call is a bigger risk than any individual source.

## What was implemented (0.4.0)

Pure, synchronous, no dependency, no network, no trust decision made on the caller's
behalf.

**`AbiSource` on every `DecodeResult`, required.** A UI cannot render a summary without
having the provenance in hand, because it is not an optional field.

The field is named for where the ABI came from, but what it measures is **how the ABI was
bound to this address** — which is the part that can be wrong. Both the vault ABI and the
ERC20 fragments ship with the SDK, so by provenance alone both would be `builtin`; yet one
is matched because the target *is* the vault, and the other because four bytes of calldata
looked familiar.

| Level | Bound how | Example |
|---|---|---|
| `builtin` | The SDK knows which contract this address is | vault self-call, configured recovery module, configured MultiSend, bare value transfer |
| `heuristic` | Selector shape alone, against an unknown address | `transfer(address,uint256)` read as ERC20; `execTransactionFromModule` against any target |
| `supplied` | The caller said so | `connect({ abis })` |
| `none` | Nothing matched | raw selector only |

`heuristic` was added in 0.5.0 after the CLI team found that an ERC20-shaped call to an
address with *no code at all* returned `builtin` — labelled identically to a vault
self-call. Their report named the three token blocks; `module_execution` had the same
flaw and was found while verifying it, since it parses the vault ABI against any target.

Summaries are not hedged for `heuristic`, deliberately. An ordinary ERC20 transfer is the
overwhelmingly common case, and phrasing every one of them as uncertain would make the
hedge worthless by repetition. The field carries the uncertainty instead.

**`AbiLookup`, address-keyed and synchronous.** Keyed by address rather than a list to try,
deliberately: attempting a pile of ABIs against arbitrary calldata until one parses is how
a call gets confidently decoded as the wrong thing. Synchronous because `decodeCall` is
pure and runs per row across a whole history page — a lookup that could touch the network
would put an unbounded fetch in that loop.

**Ordering.** Supplied ABIs are consulted *after* every built-in match and *before* the
token selector heuristics.

- After the built-ins, so a supplied ABI can never change how a vault self-call or a known
  module call is read. `test/abi-decode.test.ts` pins this with a hostile registry that
  tries to shadow `addOwner` and `setupRecovery`.
- Before the heuristics, because those identify a call by selector shape alone and will
  read any contract exposing `transfer(address,uint256)` as an ERC20. A caller who has said
  *which contract this address is* has supplied better evidence than the selector.

**`DecodedCall.selector`.** Surfaced so a reviewer can check the claimed function against a
source that is not the one making the claim. Given selector collision is undetectable from
inside, this is the only defence available, and it costs nothing.

**Failure is contained.** A malformed ABI, or a lookup that throws, degrades that row to
`abiSource: 'none'`. It does not fail the page. The throwing-lookup case was found by the
test rather than by inspection.

**`abiRegistry()`** builds a lookup from an address-keyed object, matching case
insensitively — addresses arrive checksummed from `getAddress` and lowercased from the
indexer, and a case-sensitive miss would read as "could not decode" rather than "wrong key
case".

## What was not implemented, and what we learned trying

Network resolution — bytecode → CBOR metadata → IPFS → ABI. The full path was walked
against live mainnet contracts before writing this, and the results argue for keeping it
out of the decode path rather than for adding it:

| Contract | CID from bytecode | `ipfs.qu.ai` | `ipfs.quai.network` |
|---|---|---|---|
| QuaiVault implementation | `QmX9d8Wu…VdNjSC` | **200, 148 ms**, 121 ABI entries | — |
| QuaiVaultFactory | `QmZHZhX8…qpo24K` | **timeout at 45 s** | — |

Three findings:

1. **`ipfs.quai.network` does not resolve.** NXDOMAIN, not a timeout or a 5xx. Only
   `ipfs.qu.ai` is usable today.
2. **The mechanism works.** Solidity's CBOR trailer gives a CIDv0 that fetches real
   metadata with a complete ABI, in 148 ms. It is a genuinely good source: the hash is
   committed in the deployed bytecode, so it cannot be changed after deployment without
   changing the contract address.
3. **Availability is per-CID, not per-gateway.** Two contracts from the same deployment,
   one resolvable and one not — and the failure is a 45-second hang, not a fast negative.

Point 3 is decisive for the design. A resolver that hangs for 45 seconds on some fraction
of addresses cannot sit anywhere near a hot path, and needs a hard timeout with a definite
`unresolved` outcome rather than an exception. That is a fine thing to build; it is not a
thing to build into `decodeCall`.

The dependency cost is also non-trivial: `@ethereum-sourcify/bytecode-utils` measures
**22 KB gzip**, the same order as the entire saving from dropping the Supabase umbrella
package in 0.2.0. The CBOR trailer parse is roughly 50 lines, so reimplementing is a real
option if this proceeds.

## What should not be a default

Explorer-sourced ABIs (`?module=contract&action=getabi`). The explorer is a trusted third
party, and "verified source" is uploaded by the deployer — so this source carries close to
the same trust as the deployer's own claim about their contract, with none of the binding
that the bytecode-committed IPFS hash provides.

The SDK should define the interface and let each consumer plug in a resolver whose trust
they have decided to accept. It should not ship that decision.

## If network resolution proceeds

Sketch, for whoever picks it up:

- A separate entry point (`@quaivault/sdk/abi-resolver` or similar), so chain-only
  consumers do not pay the bundle cost.
- `resolveAbi(address): Promise<{ abi, source: 'bytecode' | 'explorer', cid? }>`, returning
  a definite "unresolved" rather than throwing.
- Hard per-attempt timeout, low single-digit seconds, given finding 3 above.
- Bounded cache with explicit eviction. The frontend's 200-entry LRU is a reasonable
  starting point.
- EIP-1967 proxy following, depth-capped — the frontend caps at 5, which seems right.
- Feed the results into `connect({ abis })`. The plumbing already exists.

The trust gradient must survive that layer: a `bytecode`-sourced ABI and an `explorer`-
sourced one should not collapse into the same `supplied` once they reach `decodeCall`.
That means widening `AbiSource` again — to something like
`'builtin' | 'heuristic' | 'supplied' | 'bytecode' | 'explorer' | 'none'`.

Those two members are deliberately **not** added ahead of the resolver. An unreachable
union member forces every consumer to handle a case that cannot occur, and a `switch` arm
nobody can exercise is a place for wrong code to hide. Add them with the code that
produces them.
