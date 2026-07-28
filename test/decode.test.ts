import { describe, expect, it } from 'vitest';
import { Interface, parseQuai } from 'quais';
import { decodeCall } from '../src/decode/index.js';
import { encodeMultiSend, selfCall, tokenCalls } from '../src/index.js';
import { mainnet } from '../src/config/networks.js';

const VAULT = '0x00112233445566778899aabbccddeeff00112233';
const ALICE = '0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN = '0x00dddddddddddddddddddddddddddddddddddddd';
const HASH = '0x' + 'ab'.repeat(32);

function decode(overrides: Partial<Parameters<typeof decodeCall>[0]> = {}) {
  return decodeCall({
    vault: VAULT,
    to: ALICE,
    value: 0n,
    data: '0x',
    socialRecovery: mainnet.contracts.socialRecovery,
    multiSendCallOnly: mainnet.contracts.multiSendCallOnly,
    ...overrides,
  });
}

describe('decodeCall — native transfers', () => {
  it('classifies empty calldata as a transfer and formats the amount', () => {
    const r = decode({ value: parseQuai('1.5'), data: '0x' });
    expect(r.kind).toBe('transfer');
    expect(r.summary).toContain('1.5');
    expect(r.summary).toContain('QUAI');
  });

  it('treats a zero-value empty call as a transfer too', () => {
    expect(decode({ value: 0n, data: '0x' }).kind).toBe('transfer');
  });
});

describe('decodeCall — vault self-calls', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['addOwner', selfCall.addOwner(ALICE), /Add owner/i],
    ['removeOwner', selfCall.removeOwner(ALICE), /Remove owner/i],
    ['changeThreshold', selfCall.changeThreshold(3), /threshold to 3/i],
    ['enableModule', selfCall.enableModule(ALICE), /Enable module/i],
    ['setMinExecutionDelay', selfCall.setMinExecutionDelay(86_400), /minimum execution delay/i],
    ['addDelegatecallTarget', selfCall.addDelegatecallTarget(ALICE), /Whitelist/i],
    ['cancelByConsensus', selfCall.cancelByConsensus(HASH), /Cancel transaction/i],
  ];

  for (const [name, data, summary] of cases) {
    it(`classifies ${name} as wallet_admin`, () => {
      const r = decode({ to: VAULT, data });
      expect(r.kind).toBe('wallet_admin');
      expect(r.decoded?.name).toBe(name);
      expect(r.decoded?.target).toBe('vault');
      expect(r.summary).toMatch(summary);
    });
  }

  it('classifies signMessage as message_signing, not wallet_admin', () => {
    const r = decode({ to: VAULT, data: selfCall.signMessage('0xdeadbeef') });
    expect(r.kind).toBe('message_signing');
    expect(r.summary).toMatch(/EIP-1271/);
  });

  it('renders a human duration for the execution delay', () => {
    expect(decode({ to: VAULT, data: selfCall.setMinExecutionDelay(86_400) }).summary).toContain('1 day');
    expect(decode({ to: VAULT, data: selfCall.setMinExecutionDelay(7_200) }).summary).toContain('2 hours');
  });

  it('only treats vault-ABI calldata as a self-call when `to` is the vault', () => {
    // Same bytes sent elsewhere are an external call, not vault admin.
    const r = decode({ to: ALICE, data: selfCall.addOwner(ALICE) });
    expect(r.kind).not.toBe('wallet_admin');
  });
});

describe('decodeCall — tokens', () => {
  it('classifies an ERC20 transfer', () => {
    const r = decode({ to: TOKEN, data: tokenCalls.erc20Transfer(ALICE, 1000n) });
    expect(r.kind).toBe('erc20_transfer');
    expect(r.decoded?.target).toBe('erc20');
    expect(r.summary).toContain('1000');
  });

  it('classifies an ERC20 approve', () => {
    const r = decode({ to: TOKEN, data: tokenCalls.erc20Approve(ALICE, 5n) });
    expect(r.kind).toBe('erc20_transfer');
    expect(r.summary).toMatch(/Approve/i);
  });

  it('classifies an ERC721 transfer with its token id', () => {
    const r = decode({ to: TOKEN, data: tokenCalls.erc721Transfer(VAULT, ALICE, 42n) });
    expect(r.kind).toBe('erc721_transfer');
    expect(r.summary).toContain('#42');
  });

  it('classifies ERC1155 single and batch transfers distinctly', () => {
    const single = decode({ to: TOKEN, data: tokenCalls.erc1155Transfer(VAULT, ALICE, 7n, 3n) });
    expect(single.kind).toBe('erc1155_transfer');
    expect(single.summary).toContain('#7');

    const batch = decode({
      to: TOKEN,
      data: tokenCalls.erc1155BatchTransfer(VAULT, ALICE, [1n, 2n], [3n, 4n]),
    });
    expect(batch.kind).toBe('erc1155_transfer');
    expect(batch.summary).toMatch(/batch/i);
  });
});

describe('decodeCall — modules and batching', () => {
  it('classifies a setupRecovery call to the module', () => {
    const iface = new Interface([
      'function setupRecovery(address wallet, address[] guardians, uint256 threshold, uint256 recoveryPeriod)',
    ]);
    const data = iface.encodeFunctionData('setupRecovery', [VAULT, [ALICE], 1, 86_400]);
    const r = decode({ to: mainnet.contracts.socialRecovery!, data });
    expect(r.kind).toBe('recovery_setup');
    expect(r.summary).toMatch(/1 guardians, 1 required/);
  });

  it('classifies a MultiSend batch and counts the sub-transactions', () => {
    const data = encodeMultiSend([
      { to: ALICE, value: 1n },
      { to: TOKEN, value: 0n, data: tokenCalls.erc20Transfer(ALICE, 5n) },
    ]);
    const r = decode({ to: mainnet.contracts.multiSendCallOnly!, data });
    expect(r.kind).toBe('batched_call');
    expect(r.summary).toContain('2 sub-transactions');
  });

  it('falls back to external_call for unknown calldata, naming the selector', () => {
    const r = decode({ to: ALICE, data: '0x12345678' });
    expect(r.kind).toBe('external_call');
    expect(r.summary).toContain('0x12345678');
    expect(r.decoded).toBeUndefined();
  });

  it('mentions the attached value on an unknown call', () => {
    const r = decode({ to: ALICE, data: '0x12345678', value: parseQuai('2') });
    expect(r.summary).toMatch(/2.*QUAI/);
  });

  it('does not classify module calls when no module address is configured', () => {
    const data = selfCall.addOwner(ALICE);
    const r = decodeCall({ vault: VAULT, to: ALICE, value: 0n, data });
    expect(r.kind).toBe('external_call');
  });
});
