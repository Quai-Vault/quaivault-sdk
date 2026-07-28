import { describe, expect, it } from 'vitest';
import { isQuaiAddress } from 'quais';
import {
  computeFullSalt,
  encodeInitData,
  predictVaultAddress,
  shardPrefixOf,
} from '../src/salt/predict.js';
import { mineSalt, syncStrategy } from '../src/salt/mine.js';
import { mainnet } from '../src/config/networks.js';
import { SaltMiningError, ValidationError } from '../src/errors/index.js';

const FACTORY = mainnet.contracts.factory;
const IMPL = mainnet.contracts.implementation;
const DEPLOYER = '0x0022222222222222222222222222222222222222';
const SALT = '0x' + '11'.repeat(32);
const A = '0x0011111111111111111111111111111111111111';
const B = '0x0033333333333333333333333333333333333333';

describe('predictVaultAddress', () => {
  // Verified against the live mainnet factory's predictWalletAddress for all three
  // shapes below; these are the recorded expectations.
  const cases = [
    {
      label: '1-of-1, no delay, no modules',
      params: { owners: [A], threshold: 1 },
      expected: '0x591B69ABb8a0999F77a2AF2cF2572B2ce173ca60',
    },
    {
      label: '2-of-2 with modules and delegatecall targets',
      params: {
        owners: [A, B],
        threshold: 2,
        minExecutionDelay: 86400,
        initialModules: [mainnet.contracts.socialRecovery!],
        initialDelegatecallTargets: [mainnet.contracts.multiSendCallOnly!],
      },
      expected: '0x8B967008b7Fb9FC18775e6E49025D21c9Ec5F70c',
    },
  ];

  for (const { label, params, expected } of cases) {
    it(`matches the on-chain prediction: ${label}`, () => {
      const predicted = predictVaultAddress({
        factory: FACTORY,
        implementation: IMPL,
        deployer: DEPLOYER,
        salt: SALT,
        params,
      });
      expect(predicted).toBe(expected);
    });
  }

  it('depends on initialModules and initialDelegatecallTargets', () => {
    // Mining with empty arrays but deploying with modules predicts the wrong address,
    // because initData feeds the CREATE2 bytecode hash.
    const withModules = predictVaultAddress({
      factory: FACTORY,
      implementation: IMPL,
      deployer: DEPLOYER,
      salt: SALT,
      params: {
        owners: [A, B],
        threshold: 2,
        minExecutionDelay: 86400,
        initialModules: [mainnet.contracts.socialRecovery!],
        initialDelegatecallTargets: [mainnet.contracts.multiSendCallOnly!],
      },
    });
    const withoutModules = predictVaultAddress({
      factory: FACTORY,
      implementation: IMPL,
      deployer: DEPLOYER,
      salt: SALT,
      params: { owners: [A, B], threshold: 2, minExecutionDelay: 86400 },
    });
    expect(withModules).not.toBe(withoutModules);
  });

  it('namespaces the salt by deployer', () => {
    const other = '0x0055555555555555555555555555555555555555';
    expect(computeFullSalt(DEPLOYER, SALT)).not.toBe(computeFullSalt(other, SALT));
  });

  it('encodes initialize with the exact argument tuple the factory uses', () => {
    const data = encodeInitData({ owners: [A], threshold: 1 });
    // initialize(address[],uint256,uint32,address[],address[])
    expect(data.slice(0, 10)).toBe('0xc91304a6');
  });
});

describe('shardPrefixOf', () => {
  it('returns the leading byte', () => {
    expect(shardPrefixOf('0x00AbCdEf00000000000000000000000000000000')).toBe('0x00');
  });

  it('rejects a malformed address', () => {
    expect(() => shardPrefixOf('nope')).toThrow(ValidationError);
  });
});

describe('mineSalt', () => {
  it('produces a salt whose predicted address is on the deployer shard', async () => {
    const params = { owners: [A, B], threshold: 2, minExecutionDelay: 3600 };
    const mined = await mineSalt(
      {
        factory: FACTORY,
        implementation: IMPL,
        deployer: DEPLOYER,
        params,
        maxAttempts: 100_000,
        timeoutMs: 30_000,
      },
      syncStrategy,
    );

    expect(mined.predictedAddress.toLowerCase().startsWith('0x00')).toBe(true);
    expect(isQuaiAddress(mined.predictedAddress)).toBe(true);
    expect(mined.attempts).toBeGreaterThan(0);

    // The mined salt must reproduce the same address through the pure predictor.
    expect(
      predictVaultAddress({
        factory: FACTORY,
        implementation: IMPL,
        deployer: DEPLOYER,
        salt: mined.salt,
        params,
      }),
    ).toBe(mined.predictedAddress);
  }, 40_000);

  it('gives up with an actionable error when the attempt budget runs out', async () => {
    await expect(
      mineSalt(
        {
          factory: FACTORY,
          implementation: IMPL,
          deployer: DEPLOYER,
          params: { owners: [A], threshold: 1 },
          // A 4-byte prefix is far out of reach in 300 attempts.
          targetPrefix: '0x00dead',
          maxAttempts: 300,
          timeoutMs: 20_000,
        },
        syncStrategy,
      ),
    ).rejects.toThrow(SaltMiningError);
  }, 30_000);

  it('honours an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      mineSalt(
        {
          factory: FACTORY,
          implementation: IMPL,
          deployer: DEPLOYER,
          params: { owners: [A], threshold: 1 },
          targetPrefix: '0x00beef',
          signal: controller.signal,
        },
        syncStrategy,
      ),
    ).rejects.toThrow(/aborted/i);
  });
});
