import { describe, expect, it } from 'vitest';
import { Vault, type VaultContext, type VaultView } from '../src/vault.js';
import type { Connection } from '../src/chain/connection.js';

const VAULT = '0x005f2629A632962f4944d23686efDa5c160d535b';
const OWNER_A = '0x0011111111111111111111111111111111111111';
const OWNER_B = '0x0033333333333333333333333333333333333333';

/**
 * A `Connection` that answers vault reads from a script and counts the calls, so a
 * test can assert what actually reached the chain rather than what it hoped would.
 */
function stubConnection(chain: { owners: string[]; threshold: bigint }) {
  const calls: string[] = [];

  const contract = {
    getFunction(signature: string) {
      return (...args: unknown[]) => {
        calls.push(signature);
        if (signature === 'getOwners()') return Promise.resolve(chain.owners);
        if (signature === 'threshold()') return Promise.resolve(chain.threshold);
        if (signature === 'isOwner(address)') {
          const who = String(args[0]).toLowerCase();
          return Promise.resolve(chain.owners.some((o) => o.toLowerCase() === who));
        }
        return Promise.reject(new Error(`unexpected call: ${signature}`));
      };
    },
    interface: {},
  };

  const connection = {
    retry: { maxAttempts: 1 },
    vault: () => contract,
  } as unknown as Connection;

  return { connection, calls };
}

function context(connection: Connection, view?: VaultView): VaultContext {
  return {
    connection,
    indexer: null,
    queries: null,
    contracts: {
      factory: '0x003613aC5FFd45bFF7B2F0210DA2fF660908c488',
      implementation: '0x0038E6d84412A10CdcE41b0f62A05350023f1fb6',
    },
    // No indexer configured, so `auto` degrades to chain reads — which is what makes
    // the call counts below unambiguous.
    consistency: 'auto',
    maxIndexerLagBlocks: 50,
    ...(view ? { view } : {}),
  };
}

describe('Vault.view', () => {
  it('captures owners and threshold with a visible timestamp', async () => {
    const { connection } = stubConnection({ owners: [OWNER_A, OWNER_B], threshold: 2n });
    const view = await new Vault(VAULT, context(connection)).view();

    expect(view.owners).toHaveLength(2);
    expect(view.threshold).toBe(2);
    expect(view.source).toBe('chain');
    expect(view.capturedAt).toBeGreaterThan(1_700_000_000);
  });
});

describe('Vault.pinned', () => {
  it('answers owners and threshold from the snapshot without reading', async () => {
    const { connection, calls } = stubConnection({ owners: [OWNER_A], threshold: 1n });
    const vault = new Vault(VAULT, context(connection));

    const view = await vault.view();
    const before = calls.length;
    expect(before).toBeGreaterThan(0);

    const pinned = vault.pinned(view);
    await pinned.owners();
    await pinned.threshold();
    await pinned.owners();

    expect(calls.length).toBe(before);
  });

  it('serves the snapshot even once the chain has moved on', async () => {
    const chain = { owners: [OWNER_A, OWNER_B], threshold: 2n };
    const { connection } = stubConnection(chain);
    const vault = new Vault(VAULT, context(connection));
    const pinned = vault.pinned(await vault.view());

    chain.owners = [OWNER_A];
    chain.threshold = 1n;

    // The point of an explicit snapshot: it is stable, and the caller knows it.
    expect(await pinned.owners()).toHaveLength(2);
    expect(await pinned.threshold()).toBe(2);
    // The unpinned handle still sees the truth.
    expect(await vault.owners()).toHaveLength(1);
  });

  it('never lets a stale snapshot gate a write', async () => {
    // The load-bearing property. `propose.removeOwner` reads owners and threshold to
    // decide whether the removal would drop the vault below quorum. If a pinned view
    // could answer that, a caller holding a snapshot from before an earlier removal
    // would build a proposal that bricks the vault — the exact failure the SDK reads
    // from chain to prevent.
    const chain = { owners: [OWNER_A, OWNER_B], threshold: 2n };
    const { connection, calls } = stubConnection(chain);
    const vault = new Vault(VAULT, context(connection));
    const pinned = vault.pinned(await vault.view());

    // One owner leaves; removing another would now leave 0 owners against a threshold of 1.
    chain.owners = [OWNER_A];
    chain.threshold = 1n;

    calls.length = 0;
    await expect(pinned.propose.removeOwner(OWNER_B)).rejects.toThrow(/not an owner/i);

    // It reached the chain rather than trusting the snapshot.
    expect(calls).toContain('getOwners()');
    expect(calls).toContain('threshold()');
  });

  it('shares the connection with the handle it came from', async () => {
    const { connection } = stubConnection({ owners: [OWNER_A], threshold: 1n });
    const vault = new Vault(VAULT, context(connection));
    const pinned = vault.pinned(await vault.view());

    expect(pinned.address).toBe(vault.address);
    expect(pinned.recovery).toBeDefined();
  });
});
