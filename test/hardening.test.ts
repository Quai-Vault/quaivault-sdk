import { describe, expect, it } from 'vitest';
import { Wallet, getZoneForAddress, isQuaiAddress } from 'quais';
import { connect } from '../src/client.js';
import { redactConfig, resolveConfig } from '../src/config/resolve.js';
import { watchVault } from '../src/indexer/watch.js';
import { ConfigError, ValidationError } from '../src/errors/index.js';
import type { IndexerClient } from '../src/indexer/client.js';

/** First key whose derived address lands in a real Quai zone. */
function shardValidKey(): string {
  for (let i = 1; i < 500_000; i++) {
    const key = '0x' + i.toString(16).padStart(64, '0');
    if (getZoneForAddress(new Wallet(key).address)) return key;
  }
  throw new Error('no shard-valid key found');
}

describe('private key validation', () => {
  it('rejects a key whose address is in no Quai zone', () => {
    // An arbitrary secp256k1 key almost never lands in a shard prefix. Without this
    // guard the failure surfaces as an opaque RPC error on the first transaction.
    expect(() => connect({ privateKey: '0x' + '11'.repeat(32), useEnv: false })).toThrow(
      ConfigError,
    );
  });

  it('rejects a zone-less key even when it passes isQuaiAddress', () => {
    // These are independent checks: isQuaiAddress tests the Quai/Qi ledger bit, not
    // shard membership. 0x7E5F… passes the ledger test but maps to no zone, so a
    // guard that only checked the ledger would wrongly accept it.
    const key = '0x' + '0'.repeat(63) + '1';
    const address = new Wallet(key).address;
    expect(isQuaiAddress(address)).toBe(true);
    expect(getZoneForAddress(address)).toBeNull();
    expect(() => connect({ privateKey: key, useEnv: false })).toThrow(ConfigError);
  });

  it('accepts a shard-valid key', () => {
    const qv = connect({ privateKey: shardValidKey(), useEnv: false });
    expect(qv.signer).not.toBeNull();
  });

  it('rejects malformed hex before touching the curve', () => {
    expect(() => connect({ privateKey: 'not-hex', useEnv: false })).toThrow(ConfigError);
    expect(() => connect({ privateKey: '0x1234', useEnv: false })).toThrow(ConfigError);
  });

  it('accepts a key with or without the 0x prefix', () => {
    const key = shardValidKey();
    expect(() => connect({ privateKey: key, useEnv: false })).not.toThrow();
    expect(() => connect({ privateKey: key.slice(2), useEnv: false })).not.toThrow();
  });
});

describe('config redaction', () => {
  it('never exposes the private key on the client', () => {
    const key = shardValidKey();
    const qv = connect({ privateKey: key, useEnv: false });

    expect((qv.config as { privateKey?: string }).privateKey).toBeUndefined();
    expect(JSON.stringify(qv.config)).not.toContain(key.slice(2));
  });

  it('masks the indexer key in both places it appears', () => {
    const qv = connect({ useEnv: false });
    const dumped = JSON.stringify(qv.config);

    // `network` carries its own copy of the indexer block; masking only the
    // top-level one would still print the key in full on a config dump.
    expect(qv.config.indexer?.anonKey).toMatch(/…/);
    expect(qv.config.network.indexer?.anonKey).toMatch(/…/);
    expect(dumped).not.toContain('sb_publishable_EO-sTB');
  });

  it('leaves the resolved config intact for internal use', () => {
    // Redaction must be a view, not a mutation — the real key still has to reach
    // the signer and the Supabase client.
    const key = shardValidKey();
    const resolved = resolveConfig({ privateKey: key, useEnv: false });
    expect(resolved.privateKey).toBe(key);
    expect(resolved.indexer?.anonKey).not.toContain('…');

    const redacted = redactConfig(resolved);
    expect(redacted.privateKey).toBeUndefined();
    expect(resolved.privateKey).toBe(key); // original untouched
  });

  it('handles a config with no indexer', () => {
    const resolved = resolveConfig({
      useEnv: false,
      network: {
        name: 'local',
        chainId: 1337,
        rpcUrl: 'http://127.0.0.1:8545',
        contracts: {
          factory: '0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          implementation: '0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      },
    });
    expect(() => redactConfig(resolved)).not.toThrow();
    expect(redactConfig(resolved).indexer).toBeUndefined();
  });
});

describe('watchVault input validation', () => {
  // The address is interpolated into a PostgREST filter string, and watchVault is
  // exported rather than reachable only through Vault.watch().
  const fakeClient = { config: { schema: 'mainnet' }, raw: {} } as unknown as IndexerClient;

  it('rejects a non-address before building the filter', () => {
    expect(() => watchVault(fakeClient, 'not-an-address', () => {})).toThrow(ValidationError);
    expect(() => watchVault(fakeClient, "0x00'; DROP TABLE--", () => {})).toThrow(ValidationError);
    expect(() => watchVault(fakeClient, '', () => {})).toThrow(ValidationError);
  });
});
