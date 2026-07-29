import { describe, expect, it } from 'vitest';
import { Interface } from 'quais';
import { abiRegistry, decodeCall } from '../src/decode/index.js';
import { selfCall, token as tokenCalls } from '../src/encode/index.js';
import { mainnet } from '../src/config/networks.js';

const VAULT = '0x00112233445566778899aabbccddeeff00112233';
const STAKING = '0x0033333333333333333333333333333333333333';
const ALICE = '0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** A contract the SDK knows nothing about. */
const STAKING_ABI = [
  'function stake(uint256 amount, address onBehalfOf)',
  'function withdraw(uint256 amount)',
];
const stakingIface = new Interface(STAKING_ABI);

function ctx(over: Partial<Parameters<typeof decodeCall>[0]> = {}) {
  return {
    vault: VAULT,
    to: STAKING,
    value: 0n,
    data: '0x' as string,
    socialRecovery: mainnet.contracts.socialRecovery,
    multiSendCallOnly: mainnet.contracts.multiSendCallOnly,
    ...over,
  };
}

describe('abiSource provenance', () => {
  it('marks SDK-shipped decodes as builtin', () => {
    const result = decodeCall(ctx({ to: VAULT, data: selfCall.addOwner(ALICE) }));
    expect(result.abiSource).toBe('builtin');
    expect(result.decoded?.name).toBe('addOwner');
  });

  it('marks a bare value transfer as builtin', () => {
    expect(decodeCall(ctx({ data: '0x', value: 1n })).abiSource).toBe('builtin');
  });

  it('marks an unrecognised call as none, and says so rather than guessing', () => {
    const result = decodeCall(ctx({ data: stakingIface.encodeFunctionData('withdraw', [1n]) }));
    expect(result.abiSource).toBe('none');
    expect(result.decoded).toBeUndefined();
    expect(result.summary).toMatch(/selector 0x/);
  });

  it('marks a caller-supplied decode as supplied', () => {
    const data = stakingIface.encodeFunctionData('stake', [500n, ALICE]);
    const result = decodeCall(ctx({ data, abis: abiRegistry({ [STAKING]: STAKING_ABI }) }));
    expect(result.abiSource).toBe('supplied');
    expect(result.decoded?.name).toBe('stake');
    expect(result.decoded?.target).toBe('external');
    expect(result.decoded?.args.amount).toBe(500n);
    expect(result.summary).toContain('stake');
  });
});

describe('supplied ABIs are address-scoped', () => {
  const registry = abiRegistry({ [STAKING]: STAKING_ABI });

  it('is not consulted for a different address', () => {
    const data = stakingIface.encodeFunctionData('withdraw', [1n]);
    const other = '0x0044444444444444444444444444444444444444';
    // Same calldata, different target: without an entry for that address the SDK
    // declines to identify it rather than reaching for any ABI that happens to parse.
    expect(decodeCall(ctx({ to: other, data, abis: registry })).abiSource).toBe('none');
  });

  it('matches regardless of address casing', () => {
    const data = stakingIface.encodeFunctionData('withdraw', [1n]);
    const upper = STAKING.toUpperCase().replace('0X', '0x');
    expect(decodeCall(ctx({ to: upper, data, abis: registry })).abiSource).toBe('supplied');
  });

  it('accepts a prebuilt Interface as well as a raw ABI', () => {
    const data = stakingIface.encodeFunctionData('withdraw', [7n]);
    const result = decodeCall(
      ctx({ data, abis: abiRegistry({ [STAKING]: stakingIface }) }),
    );
    expect(result.decoded?.name).toBe('withdraw');
  });
});

describe('supplied ABIs cannot override the SDK', () => {
  // The load-bearing property. A supplied ABI may add detail the SDK lacks; it must
  // never change how a vault self-call or a known module call is read, or a hostile
  // registry could make `addOwner` render as something innocuous.
  it('does not shadow a vault self-call', () => {
    const hostile = abiRegistry({
      [VAULT]: ['function addOwner(address harmlessLookingParameter)'],
    });
    const result = decodeCall(
      ctx({ to: VAULT, data: selfCall.addOwner(ALICE), abis: hostile }),
    );
    expect(result.abiSource).toBe('builtin');
    expect(result.decoded?.target).toBe('vault');
    expect(result.summary).toMatch(/Add owner/);
  });

  it('does not shadow a social-recovery module call', () => {
    const module = mainnet.contracts.socialRecovery!;
    const hostile = abiRegistry({ [module]: ['function setupRecovery(address a)'] });
    const data = new Interface([
      'function setupRecovery(address wallet, address[] guardians, uint256 threshold, uint256 recoveryPeriod)',
    ]).encodeFunctionData('setupRecovery', [VAULT, [ALICE], 1, 86_400]);

    const result = decodeCall(ctx({ to: module, data, abis: hostile }));
    expect(result.abiSource).toBe('builtin');
    expect(result.decoded?.target).toBe('socialRecovery');
  });

  it('takes precedence over the ERC20 selector heuristic', () => {
    // `transfer(address,uint256)` on a contract the caller has identified. The
    // heuristic would call this an ERC20 transfer; the caller's ABI is better evidence
    // about what the contract actually is.
    const data = tokenCalls.erc20Transfer(ALICE, 1n);
    const asToken = decodeCall(ctx({ data }));
    expect(asToken.kind).toBe('erc20_transfer');

    const identified = decodeCall(
      ctx({
        data,
        abis: abiRegistry({ [STAKING]: ['function transfer(address to, uint256 shares)'] }),
      }),
    );
    expect(identified.abiSource).toBe('supplied');
    expect(identified.decoded?.args.shares).toBe(1n);
  });
});

describe('selector is exposed for independent review', () => {
  it('is carried on every decode', () => {
    const data = stakingIface.encodeFunctionData('stake', [1n, ALICE]);
    const result = decodeCall(ctx({ data, abis: abiRegistry({ [STAKING]: STAKING_ABI }) }));
    // A supplied ABI can only mislabel a call via a selector collision, which the SDK
    // cannot detect. Surfacing the raw selector is what lets a reviewer check the
    // claimed function against a source that is not the one making the claim.
    expect(result.decoded?.selector).toBe(data.slice(0, 10));
    expect(result.decoded?.selector).toHaveLength(10);
  });

  it('matches the built-in decodes too', () => {
    const data = selfCall.addOwner(ALICE);
    expect(decodeCall(ctx({ to: VAULT, data })).decoded?.selector).toBe(data.slice(0, 10));
  });
});

describe('a broken registry entry degrades to none', () => {
  it('does not throw the whole decode away', () => {
    const broken = abiRegistry({ [STAKING]: ['not a valid fragment'] as unknown as string[] });
    const data = stakingIface.encodeFunctionData('withdraw', [1n]);
    // One malformed entry costs that row its detail, not the page.
    expect(decodeCall(ctx({ data, abis: broken })).abiSource).toBe('none');
  });

  it('tolerates a lookup that throws', () => {
    const hostile = () => {
      throw new Error('resolver exploded');
    };
    const data = stakingIface.encodeFunctionData('withdraw', [1n]);
    expect(() => decodeCall(ctx({ data, abis: hostile }))).not.toThrow();
  });
});
