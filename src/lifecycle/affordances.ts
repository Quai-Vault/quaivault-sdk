import type { Address, Affordance, VaultTransaction } from '../types.js';
import { executableAfterOf, isTerminal, nowSeconds } from './status.js';

export interface AffordanceContext {
  tx: VaultTransaction;
  caller: Address;
  isOwner: boolean;
  /** Whether `caller` currently has a threshold-counting approval. */
  hasApproved: boolean;
  at?: number;
}

function terminalReason(tx: VaultTransaction): string {
  switch (tx.status) {
    case 'executed':
      return 'The transaction has already been executed.';
    case 'failed':
      return 'The transaction executed but its target call reverted. This state is terminal.';
    case 'cancelled':
      return 'The transaction has been cancelled.';
    case 'expired':
      return 'The transaction passed its expiration timestamp.';
    default:
      return 'The transaction is in a terminal state.';
  }
}

/**
 * Enumerate which actions `caller` may legally take on `tx` right now, and when a
 * blocked action becomes available.
 *
 * Every rule here mirrors an on-chain check, so callers can plan instead of
 * discovering constraints through reverted transactions:
 *
 * - `onlyOwner` on approve / revoke / execute / cancel
 * - epoch-based approvals (`_approvalValid`) for already-approved / not-approved
 * - `approvedAt != 0` permanently locking proposer-cancel, even after revocations
 * - the timelock on external calls (self-calls bypass it)
 * - expiration, and the permissionless `expireTransaction` cleanup path
 */
export function computeAffordances(ctx: AffordanceContext): Affordance[] {
  const { tx, isOwner, hasApproved } = ctx;
  const at = ctx.at ?? nowSeconds();
  const terminal = isTerminal(tx.status);
  const quorum = tx.approvalCount >= tx.threshold;
  const isSelfCall = tx.to.toLowerCase() === tx.vault.toLowerCase();
  const executableAfter = executableAfterOf(tx.approvedAt, tx.executionDelay);
  // Self-calls always execute immediately; the contract stores executionDelay 0 for
  // them, but guard here too so a malformed record cannot produce a wrong answer.
  const timelockActive =
    !isSelfCall && tx.executionDelay > 0 && (tx.approvedAt === 0 || at < executableAfter);
  const isProposer = tx.proposer.toLowerCase() === ctx.caller.toLowerCase();

  const out: Affordance[] = [];

  const notOwner = (action: Affordance['action']): Affordance => ({
    action,
    allowed: false,
    reason: 'Only owners of this vault may take this action.',
    blockedBy: 'not_owner',
  });
  const isTerminalBlocked = (action: Affordance['action']): Affordance => ({
    action,
    allowed: false,
    reason: terminalReason(tx),
    blockedBy: 'terminal_state',
  });

  // --- approve
  if (terminal) out.push(isTerminalBlocked('approve'));
  else if (!isOwner) out.push(notOwner('approve'));
  else if (hasApproved) {
    out.push({
      action: 'approve',
      allowed: false,
      reason: 'You have already approved this transaction.',
      blockedBy: 'already_approved',
    });
  } else {
    out.push({ action: 'approve', allowed: true, reason: 'You can approve this transaction.' });
  }

  // --- revokeApproval
  if (terminal) out.push(isTerminalBlocked('revokeApproval'));
  else if (!isOwner) out.push(notOwner('revokeApproval'));
  else if (!hasApproved) {
    out.push({
      action: 'revokeApproval',
      allowed: false,
      reason: 'You have no active approval on this transaction to revoke.',
      blockedBy: 'not_approved',
    });
  } else {
    out.push({
      action: 'revokeApproval',
      allowed: true,
      reason:
        tx.approvedAt > 0
          ? 'You can revoke your approval. Note that quorum was already reached, so the ' +
            'timelock clock keeps running and the proposer still cannot cancel.'
          : 'You can revoke your approval.',
    });
  }

  // --- execute
  if (terminal) out.push(isTerminalBlocked('execute'));
  else if (!isOwner) out.push(notOwner('execute'));
  else if (!quorum) {
    out.push({
      action: 'execute',
      allowed: false,
      reason: `Needs ${tx.threshold} approvals, has ${tx.approvalCount}.`,
      blockedBy: 'threshold',
    });
  } else if (timelockActive) {
    out.push({
      action: 'execute',
      allowed: false,
      reason:
        tx.approvedAt === 0
          ? 'Quorum is met but the timelock clock has not started. The next execute call will ' +
            `start it and return without executing; you must call execute again ${tx.executionDelay}s later.`
          : `Timelocked until ${new Date(executableAfter * 1000).toISOString()}.`,
      blockedBy: 'timelock',
      ...(tx.approvedAt > 0 ? { availableAt: executableAfter } : {}),
    });
  } else {
    out.push({ action: 'execute', allowed: true, reason: 'This transaction is ready to execute.' });
  }

  // --- approveAndExecute: approve and, if that meets quorum and the timelock allows, execute
  if (terminal) out.push(isTerminalBlocked('approveAndExecute'));
  else if (!isOwner) out.push(notOwner('approveAndExecute'));
  else if (hasApproved) {
    out.push({
      action: 'approveAndExecute',
      allowed: false,
      reason: 'You have already approved. Use execute instead.',
      blockedBy: 'already_approved',
    });
  } else {
    const wouldReachQuorum = tx.approvalCount + 1 >= tx.threshold;
    out.push({
      action: 'approveAndExecute',
      allowed: true,
      reason: !wouldReachQuorum
        ? `Your approval will be recorded, but execution needs ${tx.threshold} approvals ` +
          `(would be ${tx.approvalCount + 1}). The call returns without executing.`
        : timelockActive
          ? 'Your approval will be recorded and will start the timelock, but the call returns ' +
            'without executing. Execute again after the delay elapses.'
          : 'Your approval meets the threshold and the transaction will execute in the same call.',
    });
  }

  // --- cancel (proposer-only, and permanently locked once quorum is ever reached)
  if (terminal) out.push(isTerminalBlocked('cancel'));
  else if (!isOwner) out.push(notOwner('cancel'));
  else if (!isProposer) {
    out.push({
      action: 'cancel',
      allowed: false,
      reason: 'Only the proposer can cancel directly. Others need a cancelByConsensus proposal.',
      blockedBy: 'not_proposer',
    });
  } else if (tx.approvedAt !== 0) {
    out.push({
      action: 'cancel',
      allowed: false,
      reason:
        'This transaction reached quorum, which permanently blocks proposer-cancel — even though ' +
        'approvals may since have been revoked. Use a cancelByConsensus proposal instead.',
      blockedBy: 'quorum_locked',
    });
  } else {
    out.push({ action: 'cancel', allowed: true, reason: 'You proposed this and can cancel it.' });
  }

  // --- expire (permissionless once past the deadline)
  if (tx.status === 'executed' || tx.status === 'failed' || tx.status === 'cancelled') {
    out.push(isTerminalBlocked('expire'));
  } else if (tx.expiration === 0) {
    out.push({
      action: 'expire',
      allowed: false,
      reason: 'This transaction has no expiration and can never be expired.',
      blockedBy: 'no_expiration',
    });
  } else if (at <= tx.expiration) {
    out.push({
      action: 'expire',
      allowed: false,
      reason: `Not expired yet. Expires at ${new Date(tx.expiration * 1000).toISOString()}.`,
      blockedBy: 'expired',
      availableAt: tx.expiration + 1,
    });
  } else {
    out.push({
      action: 'expire',
      allowed: true,
      reason: 'Past its expiration — anyone may close it out and reclaim approval storage.',
    });
  }

  // --- proposeCancelByConsensus: the post-quorum cancellation path
  if (terminal) out.push(isTerminalBlocked('proposeCancelByConsensus'));
  else if (!isOwner) out.push(notOwner('proposeCancelByConsensus'));
  else {
    out.push({
      action: 'proposeCancelByConsensus',
      allowed: true,
      reason:
        'You can propose a cancelByConsensus self-call. It needs the same threshold as executing ' +
        'the original transaction, but self-calls bypass the timelock, so it always resolves faster.',
    });
  }

  return out;
}

/** The subset of actions currently allowed. */
export function allowedActions(affordances: Affordance[]): Affordance[] {
  return affordances.filter((a) => a.allowed);
}
