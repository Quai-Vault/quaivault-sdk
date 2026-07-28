import { describe, expect, it } from 'vitest';
import { deriveRecoveryStatus } from '../src/lifecycle/status.js';
import type { RawRecoveryState } from '../src/lifecycle/status.js';

const NOW = 1_800_000_000;

function state(overrides: Partial<RawRecoveryState> = {}): RawRecoveryState {
  return {
    executed: false,
    approvalCount: 0,
    requiredThreshold: 2,
    executionTime: NOW + 86_400,
    expiration: NOW + 172_800,
    ...overrides,
  };
}

describe('deriveRecoveryStatus', () => {
  it('is pending below the guardian threshold', () => {
    expect(deriveRecoveryStatus(state({ approvalCount: 1 }), NOW)).toBe('pending');
  });

  it('is timelocked once approved but before the recovery period elapses', () => {
    expect(deriveRecoveryStatus(state({ approvalCount: 2 }), NOW)).toBe('timelocked');
  });

  it('is ready once approved and the period has elapsed', () => {
    const s = state({ approvalCount: 2, executionTime: NOW - 1 });
    expect(deriveRecoveryStatus(s, NOW)).toBe('ready');
  });

  it('is executed regardless of the other fields', () => {
    expect(deriveRecoveryStatus(state({ executed: true, approvalCount: 0 }), NOW)).toBe('executed');
  });

  it('derives expiry from the deadline rather than a stored flag', () => {
    // Nothing transitions a recovery to expired on its own — expireRecovery is a
    // permissionless cleanup call. The indexer only records an expired status when it
    // observes RecoveryExpiredEvent, so an un-cleaned recovery reads as 'pending'
    // there long after it died. Observed live on mainnet.
    const s = state({ approvalCount: 2, executionTime: NOW - 172_800, expiration: NOW - 1 });
    expect(deriveRecoveryStatus(s, NOW)).toBe('expired');
  });

  it('prefers executed over expired', () => {
    const s = state({ executed: true, expiration: NOW - 1 });
    expect(deriveRecoveryStatus(s, NOW)).toBe('executed');
  });

  it('prefers expired over threshold and timelock states', () => {
    // A recovery can expire while still short of quorum.
    const under = state({ approvalCount: 0, expiration: NOW - 1 });
    expect(deriveRecoveryStatus(under, NOW)).toBe('expired');

    const locked = state({ approvalCount: 2, executionTime: NOW + 10, expiration: NOW - 1 });
    expect(deriveRecoveryStatus(locked, NOW)).toBe('expired');
  });

  it('treats expiration 0 as no deadline', () => {
    const s = state({ approvalCount: 2, executionTime: NOW - 1, expiration: 0 });
    expect(deriveRecoveryStatus(s, NOW)).toBe('ready');
  });

  it('uses the threshold captured at initiation, not the current config', () => {
    // requiredThreshold is stored per-recovery precisely so a mid-recovery config
    // change cannot lower the bar.
    const s = state({ approvalCount: 2, requiredThreshold: 3, executionTime: NOW - 1 });
    expect(deriveRecoveryStatus(s, NOW)).toBe('pending');
  });
});
