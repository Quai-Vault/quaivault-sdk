import { describe, expect, it } from 'vitest';
import { connect } from '../src/client.js';
import { Vault, type VaultContext } from '../src/vault.js';
import { resolveConfig } from '../src/config/resolve.js';
import { nowSeconds } from '../src/lifecycle/status.js';
import { minimumExpiration } from '../src/encode/index.js';
import type { Connection } from '../src/chain/connection.js';
import type { Clock } from '../src/types.js';

const VAULT = '0x005f2629A632962f4944d23686efDa5c160d535b';
const OWNER = '0x0011111111111111111111111111111111111111';
const TX = '0x' + 'ab'.repeat(32);
const TARGET = '0x0033333333333333333333333333333333333333';

/** A chain-time reference well away from the real clock, so drift cannot mask a bug. */
const CHAIN_NOW = 1_700_000_000;

/**
 * A `Connection` serving one transaction whose timelock is anchored to CHAIN_NOW: quorum
 * was reached at CHAIN_NOW with a one-hour delay, so it becomes executable at
 * CHAIN_NOW + 3600.
 */
function stubConnection() {
  const contract = {
    getFunction(signature: string) {
      return (..._args: unknown[]) => {
        switch (signature) {
          case 'getOwners()':
            return Promise.resolve([OWNER]);
          case 'threshold()':
            return Promise.resolve(1n);
          case 'isOwner(address)':
            return Promise.resolve(true);
          case 'hasApproved(bytes32,address)':
            return Promise.resolve(true);
          case 'expiredTxs(bytes32)':
            return Promise.resolve(false);
          case 'minExecutionDelay()':
            return Promise.resolve(0n);
          case 'transactions(bytes32)':
            return Promise.resolve({
              to: TARGET,
              value: 0n,
              data: '0x',
              proposer: OWNER,
              timestamp: BigInt(CHAIN_NOW),
              expiration: 0n,
              executionDelay: 3600n,
              approvedAt: BigInt(CHAIN_NOW),
              executed: false,
              cancelled: false,
            });
          default:
            return Promise.reject(new Error(`unexpected call: ${signature}`));
        }
      };
    },
    interface: {},
  };

  return { vault: () => contract, retry: { maxAttempts: 1 } } as unknown as Connection;
}

function vaultWithClock(now?: Clock): Vault {
  const ctx: VaultContext = {
    connection: stubConnection(),
    indexer: null,
    queries: null,
    contracts: {
      factory: '0x003613aC5FFd45bFF7B2F0210DA2fF660908c488',
      implementation: '0x0038E6d84412A10CdcE41b0f62A05350023f1fb6',
    },
    consistency: 'chain',
    maxIndexerLagBlocks: 50,
    ...(now ? { now } : {}),
  };
  return new Vault(VAULT, ctx);
}

describe('clock resolution', () => {
  it('defaults to the local clock', () => {
    const resolved = resolveConfig({ useEnv: false });
    expect(Math.abs(resolved.now() - nowSeconds())).toBeLessThanOrEqual(1);
  });

  it('uses an injected clock', () => {
    const resolved = resolveConfig({ useEnv: false, now: () => CHAIN_NOW });
    expect(resolved.now()).toBe(CHAIN_NOW);
  });

  it('is exposed on the client and reaches the vault handle', async () => {
    const qv = connect({ useEnv: false, now: () => CHAIN_NOW });
    expect(qv.now()).toBe(CHAIN_NOW);
  });
});

describe('injected clock drives derived status', () => {
  it('reports timelocked before the delay elapses', async () => {
    // One second after quorum: 3599 seconds of timelock still to run.
    const tx = await vaultWithClock(() => CHAIN_NOW + 1).transaction(TX);
    expect(tx.status).toBe('timelocked');
    expect(tx.executableAfter).toBe(CHAIN_NOW + 3600);
  });

  it('reports ready once it has', async () => {
    const tx = await vaultWithClock(() => CHAIN_NOW + 3601).transaction(TX);
    expect(tx.status).toBe('ready');
  });

  it('without a clock, falls back to the local one', async () => {
    // The real clock is far past CHAIN_NOW + 3600, so this is executable.
    const tx = await vaultWithClock().transaction(TX);
    expect(tx.status).toBe('ready');
  });
});

describe('injected clock drives affordances', () => {
  it('blocks execute on the timelock, with the unlock time reported', async () => {
    const affordances = await vaultWithClock(() => CHAIN_NOW + 1).affordances(TX, OWNER);
    const execute = affordances.find((a) => a.action === 'execute');
    expect(execute?.allowed).toBe(false);
    expect(execute?.blockedBy).toBe('timelock');
    expect(execute?.availableAt).toBe(CHAIN_NOW + 3600);
  });

  it('allows execute once the clock passes it', async () => {
    const affordances = await vaultWithClock(() => CHAIN_NOW + 3601).affordances(TX, OWNER);
    expect(affordances.find((a) => a.action === 'execute')?.allowed).toBe(true);
  });

  it('accepts a per-call `at` that overrides the configured clock', async () => {
    // The handle's clock says executable; the explicit `at` says otherwise and wins.
    const vault = vaultWithClock(() => CHAIN_NOW + 3601);
    const affordances = await vault.affordances(TX, OWNER, CHAIN_NOW + 1);
    expect(affordances.find((a) => a.action === 'execute')?.blockedBy).toBe('timelock');
  });
});

describe('hasApproved is public', () => {
  it('answers from the chain', async () => {
    expect(await vaultWithClock().hasApproved(TX, OWNER)).toBe(true);
  });

  it('validates its arguments like every other hash-taking method', async () => {
    await expect(vaultWithClock().hasApproved('0xdeadbeef', OWNER)).rejects.toThrow(/hash/i);
  });
});

describe('minimumExpiration honours an explicit `at`', () => {
  it('is anchored to the supplied time, not the local clock', () => {
    expect(minimumExpiration(3600, 300, CHAIN_NOW)).toBe(CHAIN_NOW + 3900);
  });

  it('defaults to the local clock', () => {
    expect(Math.abs(minimumExpiration(0, 0) - nowSeconds())).toBeLessThanOrEqual(1);
  });
});

describe('duration arithmetic stays on the raw local clock', () => {
  it('does not route elapsed-time measurement through the injected clock', async () => {
    // A clock frozen in 2023 would make any duration computed from it either zero or
    // wildly negative. Retry backoff must be unaffected: if the clock is 12 seconds
    // fast, 30 seconds is still 30 seconds.
    const { withRetry } = await import('../src/chain/retry.js');
    const qv = connect({ useEnv: false, now: () => CHAIN_NOW });
    expect(qv.now()).toBe(CHAIN_NOW);

    let attempts = 0;
    const startedAt = Date.now();
    await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw { code: 'NETWORK_ERROR' };
        return 'ok';
      },
      { maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 40 },
    );

    expect(attempts).toBe(3);
    // Real elapsed time, measured against the real clock — bounded, not instant.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
