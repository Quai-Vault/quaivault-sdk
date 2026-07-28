import type { RecoveryStatus, TransactionStatus } from '../types.js';

export interface RawTransactionState {
  executed: boolean;
  cancelled: boolean;
  /** From `expiredTxs[txHash]` — distinguishes expiry from voluntary cancellation. */
  isExpired?: boolean;
  expiration: number;
  executionDelay: number;
  approvedAt: number;
  approvalCount: number;
  threshold: number;
  /** Set when a TransactionFailed event was indexed. */
  failed?: boolean;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * `approvedAt + executionDelay`, or 0 when the timelock clock has not started.
 *
 * `approvedAt` is written once, on the first threshold crossing, and is never
 * cleared — revoking approvals below the threshold does not reset the clock.
 */
export function executableAfterOf(approvedAt: number, executionDelay: number): number {
  return approvedAt > 0 ? approvedAt + executionDelay : 0;
}

/**
 * Derive the lifecycle status from raw contract state.
 *
 * `ready` and `timelocked` refine the contract's "pending": both mean not yet
 * executed with quorum reached, differing only on whether the delay has elapsed.
 * The contract has no such distinction — it is computed here so callers do not
 * have to reimplement the timelock arithmetic.
 */
export function deriveStatus(state: RawTransactionState, at: number = nowSeconds()): TransactionStatus {
  if (state.failed) return 'failed';
  if (state.executed) return 'executed';

  // expireTransaction sets both `cancelled` and `expiredTxs`, so check expiry first
  // to avoid reporting a timed-out transaction as voluntarily cancelled.
  if (state.cancelled) return state.isExpired ? 'expired' : 'cancelled';

  // Past its deadline but not yet formally closed by expireTransaction.
  if (state.expiration > 0 && at > state.expiration) return 'expired';

  if (state.approvalCount < state.threshold) return 'pending';

  const executableAfter = executableAfterOf(state.approvedAt, state.executionDelay);
  // approvedAt === 0 with quorum met means the clock has not started (e.g. the
  // threshold was lowered after approvals were collected). The first execute call
  // will start it rather than execute — treat that as timelocked, not ready.
  if (state.executionDelay > 0 && (state.approvedAt === 0 || at < executableAfter)) {
    return 'timelocked';
  }
  return 'ready';
}

/** Whether the status admits no further state transitions. */
export function isTerminal(status: TransactionStatus): boolean {
  return status === 'executed' || status === 'failed' || status === 'cancelled' || status === 'expired';
}

export interface RawRecoveryState {
  executed: boolean;
  approvalCount: number;
  /** Threshold captured at initiation, not the current config. */
  requiredThreshold: number;
  executionTime: number;
  expiration: number;
}

/**
 * Derive a recovery's lifecycle status from raw module state.
 *
 * Expiry is computed from `expiration` rather than taken from a stored flag, because
 * nothing transitions a recovery to expired on its own — `expireRecovery` is a
 * permissionless cleanup call somebody has to make. The indexer only writes an
 * expired status when it sees `RecoveryExpiredEvent`, so an un-cleaned recovery reads
 * as `pending` there long after it died. Computing it here keeps the SDK honest
 * regardless of which side the data came from.
 *
 * `cancelled` is never returned: `cancelRecovery` deletes the on-chain struct, so it
 * is only observable through indexed history.
 */
export function deriveRecoveryStatus(
  state: RawRecoveryState,
  at: number = nowSeconds(),
): Exclude<RecoveryStatus, 'cancelled'> {
  if (state.executed) return 'executed';
  if (state.expiration > 0 && at > state.expiration) return 'expired';
  if (state.approvalCount < state.requiredThreshold) return 'pending';
  if (at < state.executionTime) return 'timelocked';
  return 'ready';
}
