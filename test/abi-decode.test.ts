import { describe, expect, it } from 'vitest';
import { Interface } from 'quais';
import { abiRegistry, decodeCall } from '../src/decode/index.js';
import { selfCall, token as tokenCalls } from '../src/encode/index.js';
import { mainnet } from '../src/config/networks.js';

const VAULT = '0x00112233445566778899aabbccddeeff00112233';
const STAKING = '0x0033333333333333333333333333333333333333';
const ALICE = '0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ZERO = '0x0000000000000000000000000000000000000000';

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

describe('selector-matched decodes are heuristic, not builtin', () => {
  // The distinction `abiSource` actually draws is not where the ABI came from — the
  // ERC20 fragments and the vault ABI both ship with the SDK — but how it was bound to
  // this address. A self-call is matched because the target *is* the vault. A token
  // transfer is matched because four bytes looked familiar.

  it('reads ERC20 calldata against an unknown address as heuristic', () => {
    const result = decodeCall(ctx({ data: tokenCalls.erc20Transfer(ALICE, 0n) }));
    expect(result.kind).toBe('erc20_transfer');
    expect(result.abiSource).toBe('heuristic');
  });

  it('does the same for ERC721 and ERC1155', () => {
    const erc721 = decodeCall(ctx({ data: tokenCalls.erc721Transfer(VAULT, ALICE, 1n) }));
    expect(erc721.kind).toBe('erc721_transfer');
    expect(erc721.abiSource).toBe('heuristic');

    const erc1155 = decodeCall(ctx({ data: tokenCalls.erc1155Transfer(VAULT, ALICE, 1n, 1n) }));
    expect(erc1155.kind).toBe('erc1155_transfer');
    expect(erc1155.abiSource).toBe('heuristic');
  });

  it('reads a module execution against an arbitrary target as heuristic', () => {
    // Parsed from the vault ABI but aimed at any address, so the identification is a
    // guess exactly like the token blocks. This one was missed in the original report.
    const data = new Interface([
      'function execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation) returns (bool)',
    ]).encodeFunctionData('execTransactionFromModule', [STAKING, 0n, '0x', 0]);

    const result = decodeCall(ctx({ data }));
    expect(result.kind).toBe('module_execution');
    expect(result.abiSource).toBe('heuristic');
  });

  it('keeps address-matched decodes at builtin', () => {
    // The contrast that gives `heuristic` its meaning: these three are matched because
    // the SDK knows which contract the address is, not because the calldata parsed.
    expect(decodeCall(ctx({ to: VAULT, data: selfCall.addOwner(ALICE) })).abiSource).toBe(
      'builtin',
    );
    expect(decodeCall(ctx({ data: '0x', value: 1n })).abiSource).toBe('builtin');

    const module = mainnet.contracts.socialRecovery!;
    const setup = new Interface([
      'function setupRecovery(address wallet, address[] guardians, uint256 threshold, uint256 recoveryPeriod)',
    ]).encodeFunctionData('setupRecovery', [VAULT, [ALICE], 1, 86_400]);
    expect(decodeCall(ctx({ to: module, data: setup })).abiSource).toBe('builtin');
  });

  it('separates all four levels for the same kind of question', () => {
    const levels = {
      builtin: decodeCall(ctx({ to: VAULT, data: selfCall.addOwner(ALICE) })).abiSource,
      heuristic: decodeCall(ctx({ data: tokenCalls.erc20Transfer(ALICE, 0n) })).abiSource,
      supplied: decodeCall(
        ctx({
          data: stakingIface.encodeFunctionData('withdraw', [1n]),
          abis: abiRegistry({ [STAKING]: STAKING_ABI }),
        }),
      ).abiSource,
      none: decodeCall(ctx({ data: stakingIface.encodeFunctionData('withdraw', [1n]) }))
        .abiSource,
    };
    expect(levels).toEqual({
      builtin: 'builtin',
      heuristic: 'heuristic',
      supplied: 'supplied',
      none: 'none',
    });
  });

  it('an address with no code still decodes as a token, but says it is guessing', () => {
    // The reported case. The summary reads confidently because an ordinary ERC20
    // transfer is the common case and hedging every one would make the hedge worthless
    // — so `abiSource` is what carries the uncertainty.
    const result = decodeCall(ctx({ data: tokenCalls.erc20Transfer(ZERO, 0n) }));
    expect(result.summary).toMatch(/Transfer 0 units of token/);
    expect(result.abiSource).toBe('heuristic');
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
