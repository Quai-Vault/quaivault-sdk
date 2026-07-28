import type { Provider, Signer } from 'quais';

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

export interface ClientOptions {
  network?: NetworkConfig | keyof typeof import('./config/networks.js').networks;
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

export interface DecodedCall {
  /** Function name, e.g. `addOwner`. */
  name: string;
  signature: string;
  args: Record<string, unknown>;
  /** Contract the selector was resolved against. */
  target: 'vault' | 'socialRecovery' | 'multiSend' | 'erc20' | 'erc721' | 'erc1155';
}

export interface VaultTransaction {
  hash: Bytes32;
  vault: Address;
  to: Address;
  value: bigint;
  data: Hex;

  proposer: Address;
  /** Unix seconds when the proposal was recorded on chain. */
  proposedAt: number;

  kind: TransactionKind;
  decoded?: DecodedCall;
  /** One-line human-readable description. */
  summary: string;

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
  /** Guardians who have approved. Only populated on indexer reads. */
  approvedBy?: Address[];
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
  total: number;
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
