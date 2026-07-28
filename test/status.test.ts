import { describe, expect, it } from 'vitest';
import { deriveStatus, executableAfterOf, isTerminal } from '../src/lifecycle/status.js';
import type { RawTransactionState } from '../src/lifecycle/status.js';

const NOW = 1_800_000_000;

function state(overrides: Partial<RawTransactionState> = {}): RawTransactionState {
  return {
    executed: false,
    cancelled: false,
    expiration: 0,
    executionDelay: 0,
    approvedAt: 0,
    approvalCount: 0,
    threshold: 2,
    ...overrides,
  };
}

describe('deriveStatus', () => {
  it('is pending below the threshold', () => {
    expect(deriveStatus(state({ approvalCount: 1 }), NOW)).toBe('pending');
  });

  it('is ready at quorum with no timelock', () => {
    expect(deriveStatus(state({ approvalCount: 2 }), NOW)).toBe('ready');
  });

  it('is timelocked at quorum before the delay elapses', () => {
    const s = state({ approvalCount: 2, executionDelay: 3600, approvedAt: NOW - 60 });
    expect(deriveStatus(s, NOW)).toBe('timelocked');
  });

  it('is ready once the delay elapses', () => {
    const s = state({ approvalCount: 2, executionDelay: 3600, approvedAt: NOW - 3601 });
    expect(deriveStatus(s, NOW)).toBe('ready');
  });

  it('is timelocked when quorum is met but the clock never started', () => {
    // Threshold lowered after approvals: approvedAt is still 0, so the first execute
    // call starts the clock and returns rather than executing.
    const s = state({ approvalCount: 2, executionDelay: 3600, approvedAt: 0 });
    expect(deriveStatus(s, NOW)).toBe('timelocked');
  });

  it('distinguishes expired from cancelled', () => {
    // expireTransaction sets cancelled AND expiredTxs; a voluntary cancel sets only cancelled.
    expect(deriveStatus(state({ cancelled: true, isExpired: true }), NOW)).toBe('expired');
    expect(deriveStatus(state({ cancelled: true, isExpired: false }), NOW)).toBe('cancelled');
  });

  it('reports expired past the deadline even before formal cleanup', () => {
    const s = state({ approvalCount: 2, expiration: NOW - 1 });
    expect(deriveStatus(s, NOW)).toBe('expired');
  });

  it('prefers executed over every non-failed state', () => {
    expect(deriveStatus(state({ executed: true, expiration: NOW - 1 }), NOW)).toBe('executed');
  });

  it('reports failed for an executed transaction whose target reverted', () => {
    expect(deriveStatus(state({ executed: true, failed: true }), NOW)).toBe('failed');
  });
});

describe('executableAfterOf', () => {
  it('is 0 while the clock has not started', () => {
    expect(executableAfterOf(0, 3600)).toBe(0);
  });

  it('adds the delay to the quorum timestamp', () => {
    expect(executableAfterOf(1000, 3600)).toBe(4600);
  });
});

describe('isTerminal', () => {
  it('covers exactly the states admitting no further transitions', () => {
    expect(['executed', 'failed', 'cancelled', 'expired'].every(isTerminal as never)).toBe(true);
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('ready')).toBe(false);
    expect(isTerminal('timelocked')).toBe(false);
  });
});
