import type { Interface, InterfaceAbi, Provider, Signer } from 'quais';
// Type-only, and `verbatimModuleSyntax` erases it, so the cycle with config/networks.ts
// exists in the type graph and never in the emitted module graph.
import type { NetworkName } from './config/networks.js';

export type Address = string;
export type Hex = string;
export type Bytes32 = string;

export type { Provider, Signer };

/** Zodiac IAvatar operation type. Mirrors `Enum.Operation` in the contracts. */
export enum Operation {
  Call = 0,
  DelegateCall = 1,
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ContractAddresses {
  implementation: Address;
  factory: Address;
  socialRecovery?: Address;
  multiSendCallOnly?: Address;
}

export interface IndexerConfig {
  /** Supabase project URL. */
  url: string;
  /** Public anon key. Read-only by RLS policy — safe to distribute. */
  anonKey: string;
  /** Postgres schema for this network (`mainnet`, `testnet`, `dev`). */
  schema: string;
  /** Base URL of the indexer health server, used for lag/liveness checks. */
  healthUrl?: string;
}

export interface NetworkConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl?: string;
  contracts: ContractAddresses;
  indexer?: IndexerConfig;
}

/**
 * How reads resolve between the indexer and the chain.
 *
 * - `indexed` — indexer only. Fastest; may be stale; fails if the indexer is down.
 * - `chain`   — RPC only. Authoritative; slower; some history queries are unavailable.
 * - `auto`    — indexer when it is fresh enough (see {@link ClientOptions.maxIndexerLagBlocks}),
 *               otherwise the chain. This is the default.
 *
 * Write paths always re-validate preconditions against the chain regardless of this
 * setting — indexed approval counts can diverge from on-chain reality after an owner
 * is removed (approval epochs), so they must never gate a signature.
 */
export type Consistency = 'auto' | 'indexed' | 'chain';

/**
 * Source of "now", in Unix **seconds**, for decisions compared against chain time.
 *
 * The contracts decide with `block.timestamp`. Everything the SDK derives locally —
 * a transaction's `ready` vs `timelocked`, what a caller may do next, whether a
 * recovery period has elapsed — is a *prediction* of that, and a machine whose clock is
 * wrong predicts wrongly. Containers, CI runners and VMs resumed from a snapshot drift
 * in ways a desktop usually does not.
 *
 * Supplying a clock lets a consumer that has measured the offset feed it back in:
 *
 * ```ts
 * const skew = localSeconds - blockTimestamp;      // positive: local clock is ahead
 * connect({ now: () => Date.now() / 1000 - skew });
 * ```
 *
 * A function rather than a scalar offset on purpose. An offset needs a sign convention,
 * and getting it backwards doubles the error instead of cancelling it — silently. Here
 * the arithmetic sits in the caller's own code, where it reads as what it means.
 *
 * This never affects elapsed-time measurement (retry backoff, timeouts, poll
 * intervals). Those are durations: if the clock is 12 seconds fast, 30 seconds is still
 * 30 seconds.
 *
 * Detection is deliberately not the SDK's job — it would mean an RPC call on behalf of
 * a consumer who may not want one, and a cached value with no clear invalidation.
 */
export type Clock = () => number;

export interface ClientOptions {
  network?: NetworkConfig | NetworkName;
  provider?: Provider;
  signer?: Signer;
  /** Private key for a local signer. Prefer the `QUAIVAULT_PRIVATE_KEY` env var. */
  privateKey?: string;
  rpcUrl?: string;
  indexer?: Partial<IndexerConfig>;
  contracts?: Partial<ContractAddresses>;
  consistency?: Consistency;
  /** Beyond this many blocks behind, `auto` reads fall through to the chain. Default 50. */
  maxIndexerLagBlocks?: number;
  /** Read env vars for anything not passed explicitly. Default true. */
  useEnv?: boolean;
  /**
   * Source of "now" for time compared against chain timestamps. See {@link Clock}.
   * Defaults to the local clock.
   */
  now?: Clock;
  /**
   * ABIs for contracts the SDK does not ship, so proposals targeting them get a real
   * description instead of a bare selector. See {@link AbiLookup}.
   */
  abis?: AbiLookup;
  /**
   * Retry policy for transient RPC and indexer failures. Applies to reads only —
   * writes are never retried, since a resubmit risks a double broadcast.
   */
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  };
}

// ---------------------------------------------------------------------------
// Vault domain model
// ---------------------------------------------------------------------------

export interface VaultInfo {
  address: Address;
  owners: Address[];
  threshold: number;
  /** Vault-level minimum timelock for external calls, in seconds. 0 = simple quorum. */
  minExecutionDelay: number;
  nonce: number;
  balance: bigint;
  moduleCount: number;
}

export type TransactionKind =
  | 'transfer'
  | 'erc20_transfer'
  | 'erc721_transfer'
  | 'erc1155_transfer'
  | 'wallet_admin'
  | 'module_config'
  | 'module_execution'
  | 'message_signing'
  | 'recovery_setup'
  | 'batched_call'
  | 'external_call'
  | 'unknown';

/**
 * Lifecycle state of a vault transaction.
 *
 * `ready` and `timelocked` are SDK-derived refinements of the contract's "pending":
 * both mean not-yet-executed with quorum reached, differing only on whether the
 * execution delay has elapsed.
 */
export type TransactionStatus =
  | 'pending' // awaiting approvals
  | 'timelocked' // quorum reached, execution delay not yet elapsed
  | 'ready' // quorum reached, executable now
  | 'executed'
  | 'failed' // executed, but the external call reverted (terminal)
  | 'cancelled'
  | 'expired';

export interface ApprovalRecord {
  owner: Address;
  /** Whether this approval currently counts toward the threshold. */
  active: boolean;
}

/**
 * How strongly the SDK can vouch for a decode.
 *
 * Named for where the ABI came from, but what it actually measures is **how the ABI was
 * bound to this address** — which is the part that can be wrong. Both the vault ABI and
 * the ERC20 fragments ship with the SDK, so by provenance alone both would be `builtin`;
 * yet one is matched because the target *is* the vault, and the other because four bytes
 * of calldata looked familiar. Those are not the same claim.
 *
 * Load-bearing, not decorative. In a multisig the summary is what owners read before
 * approving, so decodes of different strength must not render identically. Present on
 * every {@link DecodeResult}, including the ones that decoded nothing.
 *
 * - `builtin`   — an ABI the SDK ships, matched because the SDK knows *which contract
 *                 this address is*: a vault self-call, the configured recovery module,
 *                 the configured MultiSend. Also a bare value transfer, which needs no
 *                 ABI at all. As trustworthy as the SDK itself.
 * - `heuristic` — an ABI the SDK ships, matched on selector shape alone against an
 *                 address it knows nothing about. `transfer(address,uint256)` is read as
 *                 an ERC20 transfer whether the target is a token, an unrelated contract
 *                 that happens to expose that signature, or an address with no code.
 *                 Usually right, never verified.
 * - `supplied`  — an ABI the caller provided for this address. Trust is theirs to
 *                 establish; the SDK does not and cannot verify it corresponds to the
 *                 deployed code.
 * - `none`      — nothing matched. Only the 4-byte selector is known, and the summary
 *                 says exactly that rather than guessing.
 *
 * Summaries are not hedged for `heuristic`, deliberately: an ordinary ERC20 transfer is
 * the overwhelmingly common case, and phrasing every one of them as uncertain would make
 * the warning worthless by repetition. This field is the mechanism instead.
 */
export type AbiSource = 'builtin' | 'heuristic' | 'supplied' | 'none';

/**
 * Supplies the ABI for a contract the SDK does not ship, keyed by address.
 *
 * Address-keyed rather than a list to try, deliberately. Attempting a pile of ABIs
 * against arbitrary calldata until one parses is how a call gets confidently decoded as
 * the wrong thing — a 4-byte selector collides far too easily to treat a successful
 * parse as identification. Binding each ABI to the address it belongs to keeps a
 * successful decode meaningful.
 *
 * Synchronous on purpose. `decodeCall` is pure and runs per row across a whole page of
 * history; a lookup that could touch the network would put an unbounded fetch in that
 * loop. Resolve ahead of time and hand the results in.
 */
export type AbiLookup = (address: Address) => InterfaceAbi | Interface | undefined;

export interface DecodedCall {
  /** Function name, e.g. `addOwner`. */
  name: string;
  signature: string;
  args: Record<string, unknown>;
  /** Contract the selector was resolved against. */
  target: 'vault' | 'socialRecovery' | 'multiSend' | 'erc20' | 'erc721' | 'erc1155' | 'external';
  /**
   * The call's 4-byte selector.
   *
   * Surfaced so a reviewer can check the claimed function against an independent
   * source. That is the only defence against a colliding selector in a supplied ABI,
   * which the SDK cannot detect on its own.
   */
  selector: Hex;
}

export interface VaultTransaction {
  hash: Bytes32;
  vault: Address;
  to: Address;
  value: bigint;
  data: Hex;

  proposer: Address;
  /**
   * Unix seconds when the proposal was recorded on chain, or 0 when unknown.
   *
   * Only chain reads carry a timestamp: the vault stores one in the transaction
   * struct, but the indexer records the *block* instead. On an indexed read this is 0
   * and {@link proposedAtBlock} carries the position. Never render 0 as a date.
   */
  proposedAt: number;
  /** Block the proposal was recorded in. Only populated on indexer reads. */
  proposedAtBlock?: number;

  kind: TransactionKind;
  decoded?: DecodedCall;
  /** One-line human-readable description. */
  summary: string;
  /** Provenance of the ABI behind {@link summary} and {@link decoded}. */
  abiSource: AbiSource;

  status: TransactionStatus;
  approvals: ApprovalRecord[];
  /** Count of approvals that currently count toward the threshold. */
  approvalCount: number;
  threshold: number;

  /** Unix seconds after which the tx can no longer execute. 0 = never expires. */
  expiration: number;
  /** Seconds of timelock locked in at proposal time. */
  executionDelay: number;
  /** Unix seconds when quorum was first reached. 0 = never reached. */
  approvedAt: number;
  /** `approvedAt + executionDelay`, or 0 if the clock has not started. */
  executableAfter: number;

  /** Raw revert data from a `TransactionFailed` event. */
  failedReturnData?: Hex;
  decodedRevert?: DecodedRevert;

  /** Where this record came from. */
  source: 'indexer' | 'chain';
  /** Indexer head at read time; absent for chain reads. */
  indexedAtBlock?: number;
}

export interface DecodedRevert {
  /** Custom error name, or `Error` / `Panic` for the builtins. */
  name: string;
  args: unknown[];
  selector: Hex;
  /** Human-readable rendering. */
  message: string;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface ProposeOptions {
  /** Unix seconds after which the tx can no longer execute. 0 / omitted = no expiry. */
  expiration?: number;
  /** Extra delay beyond the vault floor, in seconds. */
  executionDelay?: number;
  /** Build and return the call without signing. */
  dryRun?: boolean;
}

export interface ProposeResult {
  /** The vault-transaction hash (bytes32), not the Quai transaction hash. */
  txHash: Bytes32;
  /** The on-chain Quai transaction hash that carried the proposal. */
  chainTxHash: Hex;
  to: Address;
  value: bigint;
  data: Hex;
}

/** Result of a dry-run write: everything needed to inspect or submit later. */
export interface DryRunResult {
  dryRun: true;
  to: Address;
  data: Hex;
  value: bigint;
  /** Estimated gas, or null if estimation reverted. */
  gasEstimate: bigint | null;
  /** Decoded revert if estimation failed. */
  wouldRevert?: DecodedRevert;
  description: string;
}

/**
 * Outcome of an execute attempt.
 *
 * A successful Quai transaction receipt does NOT imply the vault transaction ran.
 * See `docs/execution-outcomes.md`.
 */
export type ExecuteOutcome =
  | 'executed' // TransactionExecuted emitted — the target call succeeded
  | 'failed' // TransactionFailed emitted — target reverted; vault tx is terminal
  | 'timelock_started' // lazy clock: approvedAt was set, nothing executed; retry after the delay
  | 'approved_only'; // approveAndExecute recorded an approval but could not execute

export interface ExecuteResult {
  outcome: ExecuteOutcome;
  txHash: Bytes32;
  chainTxHash: Hex;
  blockNumber: number;
  gasUsed: bigint;
  /** Set when `outcome === 'failed'`. */
  returnData?: Hex;
  decodedRevert?: DecodedRevert;
  /** Set when `outcome === 'timelock_started'`. Unix seconds. */
  executableAfter?: number;
  /** Set when `outcome === 'approved_only'`. */
  approvalsNeeded?: number;
  /** Human-readable explanation of what happened and what to do next. */
  message: string;
}

// ---------------------------------------------------------------------------
// Affordances
// ---------------------------------------------------------------------------

export type VaultAction =
  | 'approve'
  | 'revokeApproval'
  | 'execute'
  | 'approveAndExecute'
  | 'cancel'
  | 'expire'
  | 'proposeCancelByConsensus';

export type AffordanceBlocker =
  | 'not_owner'
  | 'already_approved'
  | 'not_approved'
  | 'threshold'
  | 'timelock'
  | 'expired'
  | 'terminal_state'
  | 'quorum_locked'
  | 'not_proposer'
  | 'no_expiration';

export interface Affordance {
  action: VaultAction;
  allowed: boolean;
  /** Plain-language explanation, suitable for surfacing directly to a user. */
  reason: string;
  /** Unix seconds when a time gate lifts, if the only blocker is time. */
  availableAt?: number;
  blockedBy?: AffordanceBlocker;
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

export interface CreateVaultParams {
  owners: Address[];
  threshold: number;
  /** Vault-level minimum timelock in seconds. Max 30 days. Default 0. */
  minExecutionDelay?: number;
  /** Modules enabled at deploy time. */
  initialModules?: Address[];
  /** DelegateCall whitelist entries. Empty (default) means DelegateCall is disabled. */
  initialDelegatecallTargets?: Address[];
  /** Pre-mined salt. Omit to mine one automatically. */
  salt?: Bytes32;
}

export interface MinedSalt {
  salt: Bytes32;
  predictedAddress: Address;
  attempts: number;
  durationMs: number;
}

export interface CreateVaultResult {
  address: Address;
  chainTxHash: Hex;
  salt: Bytes32;
  /** Whether the deployed address matched the mined prediction. */
  predictionMatched: boolean;
}

// ---------------------------------------------------------------------------
// Social recovery
// ---------------------------------------------------------------------------

export interface RecoveryConfig {
  guardians: Address[];
  /** Guardian approvals required to execute a recovery. */
  threshold: number;
  /** Delay in seconds between initiation and executability. */
  recoveryPeriod: number;
  /** False when the vault has no recovery configured. */
  configured: boolean;
}

/**
 * Lifecycle state of a recovery request.
 *
 * `cancelled` is only ever reported from the indexer: `cancelRecovery` deletes the
 * on-chain struct, so a chain read cannot distinguish a cancelled recovery from one
 * that never existed.
 */
export type RecoveryStatus =
  | 'pending' // awaiting guardian approvals
  | 'timelocked' // approved, waiting out the recovery period
  | 'ready' // approved and executable now
  | 'executed'
  | 'cancelled'
  | 'expired';

export interface RecoveryRequest {
  hash: Bytes32;
  vault: Address;
  newOwners: Address[];
  newThreshold: number;
  approvalCount: number;
  /** Threshold captured at initiation — config changes mid-recovery do not move it. */
  requiredThreshold: number;
  /** Unix seconds after which execution is permitted. */
  executionTime: number;
  /** Unix seconds after which the recovery is dead and can be cleaned up. */
  expiration: number;
  status: RecoveryStatus;
  executed: boolean;
  /**
   * Who initiated the recovery. Only populated on indexer reads — the module's struct
   * does not retain it.
   */
  initiator?: Address;
  source: 'indexer' | 'chain';
}

export type RecoveryAction =
  | 'approve'
  | 'revokeApproval'
  | 'execute'
  | 'cancel'
  | 'expire';

export interface RecoveryAffordance {
  action: RecoveryAction;
  allowed: boolean;
  reason: string;
  availableAt?: number;
  blockedBy?:
    | 'not_guardian'
    | 'not_owner'
    | 'already_approved'
    | 'not_approved'
    | 'threshold'
    | 'timelock'
    | 'expired'
    | 'not_expired'
    | 'terminal_state'
    | 'module_disabled';
}

// ---------------------------------------------------------------------------
// Indexer
// ---------------------------------------------------------------------------

export interface Pagination {
  limit?: number;
  offset?: number;
}

export interface Page<T> {
  data: T[];
  /**
   * Approximate size of the full result set.
   *
   * Taken from the query planner rather than a full scan, so it is exact on small
   * tables and an estimate on large ones. Use it to size a progress bar, not to decide
   * whether to keep paging — {@link hasMore} is what answers that.
   */
  total: number;
  /** Whether another page exists. Always exact. */
  hasMore: boolean;
}

export interface IndexerHealth {
  available: boolean;
  lastIndexedBlock: number;
  chainHead?: number;
  blocksBehind?: number;
  isSyncing: boolean;
  /** Reason the indexer was judged unavailable. */
  error?: string;
}
