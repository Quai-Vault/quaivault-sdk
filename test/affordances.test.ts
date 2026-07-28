import { describe, expect, it } from 'vitest';
import { computeAffordances } from '../src/lifecycle/affordances.js';
import type { Affordance, VaultTransaction } from '../src/types.js';

const NOW = 1_800_000_000;
const VAULT = '0x00112233445566778899aabbccddeeff00112233';
const ALICE = '0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = '0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = '0x00cccccccccccccccccccccccccccccccccccccc';

function tx(overrides: Partial<VaultTransaction> = {}): VaultTransaction {
  return {
    hash: '0x' + 'ab'.repeat(32),
    vault: VAULT,
    to: CAROL,
    value: 1000n,
    data: '0x',
    proposer: ALICE,
    proposedAt: NOW - 1000,
    kind: 'transfer',
    summary: 'Transfer',
    status: 'pending',
    approvals: [],
    approvalCount: 0,
    threshold: 2,
    expiration: 0,
    executionDelay: 0,
    approvedAt: 0,
    executableAfter: 0,
    source: 'chain',
    ...overrides,
  };
}

function find(list: Affordance[], action: Affordance['action']): Affordance {
  const found = list.find((a) => a.action === action);
  if (!found) throw new Error(`no affordance for ${action}`);
  return found;
}

describe('computeAffordances', () => {
  it('blocks every owner-gated action for a non-owner', () => {
    const list = computeAffordances({
      tx: tx(),
      caller: BOB,
      isOwner: false,
      hasApproved: false,
      at: NOW,
    });
    for (const action of ['approve', 'execute', 'cancel', 'revokeApproval'] as const) {
      expect(find(list, action).allowed).toBe(false);
      expect(find(list, action).blockedBy).toBe('not_owner');
    }
  });

  it('lets an owner who has not approved approve, but not revoke', () => {
    const list = computeAffordances({
      tx: tx(),
      caller: BOB,
      isOwner: true,
      hasApproved: false,
      at: NOW,
    });
    expect(find(list, 'approve').allowed).toBe(true);
    expect(find(list, 'revokeApproval').allowed).toBe(false);
    expect(find(list, 'revokeApproval').blockedBy).toBe('not_approved');
  });

  it('lets an owner who has approved revoke, but not approve again', () => {
    const list = computeAffordances({
      tx: tx({ approvalCount: 1 }),
      caller: BOB,
      isOwner: true,
      hasApproved: true,
      at: NOW,
    });
    expect(find(list, 'approve').allowed).toBe(false);
    expect(find(list, 'approve').blockedBy).toBe('already_approved');
    expect(find(list, 'revokeApproval').allowed).toBe(true);
  });

  it('blocks execute below the threshold', () => {
    const list = computeAffordances({
      tx: tx({ approvalCount: 1 }),
      caller: BOB,
      isOwner: true,
      hasApproved: true,
      at: NOW,
    });
    expect(find(list, 'execute').allowed).toBe(false);
    expect(find(list, 'execute').blockedBy).toBe('threshold');
  });

  it('blocks execute during the timelock and reports when it lifts', () => {
    const approvedAt = NOW - 60;
    const list = computeAffordances({
      tx: tx({
        status: 'timelocked',
        approvalCount: 2,
        executionDelay: 3600,
        approvedAt,
        executableAfter: approvedAt + 3600,
      }),
      caller: BOB,
      isOwner: true,
      hasApproved: true,
      at: NOW,
    });
    const execute = find(list, 'execute');
    expect(execute.allowed).toBe(false);
    expect(execute.blockedBy).toBe('timelock');
    expect(execute.availableAt).toBe(approvedAt + 3600);
  });

  it('allows execute at quorum with the timelock elapsed', () => {
    const list = computeAffordances({
      tx: tx({ status: 'ready', approvalCount: 2, approvedAt: NOW - 100 }),
      caller: BOB,
      isOwner: true,
      hasApproved: true,
      at: NOW,
    });
    expect(find(list, 'execute').allowed).toBe(true);
  });

  it('ignores the timelock for self-calls', () => {
    // The vault forces executionDelay to 0 on self-calls, so a stored delay must not
    // gate them.
    const list = computeAffordances({
      tx: tx({ to: VAULT, status: 'ready', approvalCount: 2, executionDelay: 3600, approvedAt: NOW }),
      caller: BOB,
      isOwner: true,
      hasApproved: true,
      at: NOW,
    });
    expect(find(list, 'execute').allowed).toBe(true);
  });

  it('lets the proposer cancel before quorum is ever reached', () => {
    const list = computeAffordances({
      tx: tx({ approvalCount: 1, approvedAt: 0 }),
      caller: ALICE,
      isOwner: true,
      hasApproved: true,
      at: NOW,
    });
    expect(find(list, 'cancel').allowed).toBe(true);
  });

  it('permanently blocks proposer-cancel once quorum was reached, even after revocations', () => {
    // approvedAt is written once and never cleared, so dropping back below the
    // threshold does not re-open the cancel path.
    const list = computeAffordances({
      tx: tx({ approvalCount: 1, approvedAt: NOW - 500 }),
      caller: ALICE,
      isOwner: true,
      hasApproved: true,
      at: NOW,
    });
    const cancel = find(list, 'cancel');
    expect(cancel.allowed).toBe(false);
    expect(cancel.blockedBy).toBe('quorum_locked');
    expect(find(list, 'proposeCancelByConsensus').allowed).toBe(true);
  });

  it('blocks cancel for an owner who is not the proposer', () => {
    const list = computeAffordances({
      tx: tx(),
      caller: BOB,
      isOwner: true,
      hasApproved: false,
      at: NOW,
    });
    expect(find(list, 'cancel').blockedBy).toBe('not_proposer');
  });

  it('allows expire only past the deadline, and reports when that is', () => {
    const before = computeAffordances({
      tx: tx({ expiration: NOW + 100 }),
      caller: BOB,
      isOwner: false,
      hasApproved: false,
      at: NOW,
    });
    expect(find(before, 'expire').allowed).toBe(false);
    expect(find(before, 'expire').availableAt).toBe(NOW + 101);

    // Permissionless: no ownership required.
    const after = computeAffordances({
      tx: tx({ expiration: NOW - 1, status: 'expired' }),
      caller: BOB,
      isOwner: false,
      hasApproved: false,
      at: NOW,
    });
    expect(find(after, 'expire').allowed).toBe(true);
  });

  it('reports that a transaction with no expiration can never be expired', () => {
    const list = computeAffordances({
      tx: tx({ expiration: 0 }),
      caller: BOB,
      isOwner: true,
      hasApproved: false,
      at: NOW,
    });
    expect(find(list, 'expire').blockedBy).toBe('no_expiration');
  });

  it('blocks everything in terminal states', () => {
    for (const status of ['executed', 'failed', 'cancelled'] as const) {
      const list = computeAffordances({
        tx: tx({ status, approvalCount: 2 }),
        caller: ALICE,
        isOwner: true,
        hasApproved: true,
        at: NOW,
      });
      expect(list.every((a) => !a.allowed)).toBe(true);
    }
  });

  it('explains that approveAndExecute will not execute when the threshold is still unmet', () => {
    const list = computeAffordances({
      tx: tx({ threshold: 3, approvalCount: 0 }),
      caller: BOB,
      isOwner: true,
      hasApproved: false,
      at: NOW,
    });
    const affordance = find(list, 'approveAndExecute');
    expect(affordance.allowed).toBe(true);
    expect(affordance.reason).toMatch(/returns without executing/);
  });
});
