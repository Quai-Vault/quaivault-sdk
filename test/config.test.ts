import { afterEach, describe, expect, it } from 'vitest';
import { ENV_VARS, resolveConfig } from '../src/config/resolve.js';
import { ConfigError } from '../src/errors/index.js';
import { mainnet, testnet } from '../src/config/networks.js';

const SAVED = { ...process.env };

afterEach(() => {
  for (const key of Object.values(ENV_VARS)) delete process.env[key];
  Object.assign(process.env, SAVED);
});

function clearEnv() {
  for (const key of Object.values(ENV_VARS)) delete process.env[key];
}

describe('resolveConfig', () => {
  it('defaults to mainnet with no input', () => {
    clearEnv();
    const config = resolveConfig();
    expect(config.network.name).toBe('mainnet');
    expect(config.rpcUrl).toBe(mainnet.rpcUrl);
    expect(config.contracts.factory).toBe(mainnet.contracts.factory);
    expect(config.consistency).toBe('auto');
  });

  it('reads the network from the environment', () => {
    clearEnv();
    process.env[ENV_VARS.network] = 'testnet';
    expect(resolveConfig().network.name).toBe('testnet');
    expect(resolveConfig().contracts.factory).toBe(testnet.contracts.factory);
  });

  it('lets explicit options override the environment', () => {
    clearEnv();
    process.env[ENV_VARS.network] = 'testnet';
    process.env[ENV_VARS.rpcUrl] = 'https://env.example';
    const config = resolveConfig({ network: 'mainnet', rpcUrl: 'https://explicit.example' });
    expect(config.network.name).toBe('mainnet');
    expect(config.rpcUrl).toBe('https://explicit.example');
  });

  it('lets the environment override preset defaults', () => {
    clearEnv();
    process.env[ENV_VARS.rpcUrl] = 'https://env.example';
    expect(resolveConfig().rpcUrl).toBe('https://env.example');
  });

  it('ignores the environment when useEnv is false', () => {
    clearEnv();
    process.env[ENV_VARS.rpcUrl] = 'https://env.example';
    expect(resolveConfig({ useEnv: false }).rpcUrl).toBe(mainnet.rpcUrl);
  });

  it('ships a working indexer config out of the box', () => {
    clearEnv();
    const config = resolveConfig();
    expect(config.indexer?.url).toBe(mainnet.indexer?.url);
    expect(config.indexer?.anonKey).toBe(mainnet.indexer?.anonKey);
    expect(config.indexer?.anonKey).toBeTruthy();
    expect(config.indexer?.schema).toBe('mainnet');
  });

  it('uses the matching schema per network', () => {
    clearEnv();
    expect(resolveConfig({ network: 'mainnet' }).indexer?.schema).toBe('mainnet');
    expect(resolveConfig({ network: 'testnet' }).indexer?.schema).toBe('testnet');
  });

  it('lets the environment override the shipped indexer key', () => {
    clearEnv();
    process.env[ENV_VARS.indexerAnonKey] = 'rotated-key';
    expect(resolveConfig().indexer?.anonKey).toBe('rotated-key');
  });

  it('drops indexer config when any of url, key or schema is blank', () => {
    clearEnv();
    const config = resolveConfig({
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
    expect(config.indexer).toBeUndefined();
  });

  it("rejects consistency 'indexed' with no indexer configured", () => {
    clearEnv();
    // A custom network with no indexer block — the built-in presets always have one.
    expect(() =>
      resolveConfig({
        consistency: 'indexed',
        network: {
          name: 'local',
          chainId: 1337,
          rpcUrl: 'http://127.0.0.1:8545',
          contracts: {
            factory: '0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            implementation: '0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
        },
      }),
    ).toThrow(ConfigError);
  });

  it('accepts a fully custom network', () => {
    clearEnv();
    const config = resolveConfig({
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
    expect(config.network.name).toBe('local');
    expect(config.contracts.socialRecovery).toBeUndefined();
  });

  it('rejects an unknown network name', () => {
    clearEnv();
    expect(() => resolveConfig({ network: 'nope' as never })).toThrow(ConfigError);
  });

  it('rejects a malformed contract address', () => {
    clearEnv();
    process.env[ENV_VARS.factory] = 'not-an-address';
    expect(() => resolveConfig()).toThrow(ConfigError);
  });

  it('rejects an invalid consistency value from the environment', () => {
    clearEnv();
    process.env[ENV_VARS.consistency] = 'sometimes';
    expect(() => resolveConfig()).toThrow(ConfigError);
  });

  it('picks up the private key from the environment', () => {
    clearEnv();
    process.env[ENV_VARS.privateKey] = '0x' + '11'.repeat(32);
    expect(resolveConfig().privateKey).toBe('0x' + '11'.repeat(32));
  });

  it('never mutates the built-in presets', () => {
    clearEnv();
    process.env[ENV_VARS.rpcUrl] = 'https://env.example';
    resolveConfig();
    expect(mainnet.rpcUrl).toBe('https://rpc.quai.network');
  });
});
