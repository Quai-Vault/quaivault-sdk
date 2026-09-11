import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Contract, Provider, Signer } from 'quais';
import { Connection } from '../src/chain/connection.js';
import { VaultContract, FactoryContract } from '../src/chain/vault-contract.js';
import { RecoveryContract } from '../src/chain/recovery-contract.js';
import { resolveConfig } from '../src/config/resolve.js';
import { waitForReceipt } from '../src/chain/receipt.js';
import { withRetry, isTransient } from '../src/chain/retry.js';
import { wait } from '../src/chain/wait.js';
import { IndexerClient } from '../src/indexer/client.js';
import { Factory } from '../src/factory.js';
import { connect } from '../src/client.js';

const ADDRESS = '0x0011111111111111111111111111111111111111';
const HASH = '0x' + 'ab'.repeat(32);
const provider = (chainId: bigint) => ({ getNetwork: vi.fn().mockResolvedValue({ chainId }) }) as unknown as Provider;
const signer = (p: Provider | null, address = ADDRESS) => ({ provider: p, getAddress: async () => address }) as unknown as Signer;

afterEach(() => vi.useRealTimers());

describe('write network authority', () => {
  it('rejects a read RPC on another network', async () => {
    const p = provider(15000n);
    const c = new Connection(resolveConfig({ useEnv: false }), { provider: p, signer: signer(p) });
    await expect(c.assertWriteNetwork()).rejects.toMatchObject({ code: 'CONFIG' });
  });
  it('also checks a distinct signing RPC', async () => {
    const c = new Connection(resolveConfig({ useEnv: false }), { provider: provider(9n), signer: signer(provider(15000n)) });
    await expect(c.assertWriteNetwork()).rejects.toMatchObject({ code: 'CONFIG' });
  });
  it('rechecks when the network changes between writes', async () => {
    const p = provider(9n);
    const c = new Connection(resolveConfig({ useEnv: false }), { provider: p, signer: signer(p) });
    await c.assertWriteNetwork();
    vi.mocked(p.getNetwork).mockResolvedValue({ chainId: 15000n } as never);
    await expect(c.assertWriteNetwork()).rejects.toMatchObject({ code: 'CONFIG' });
  });
  it('rejects an external Qi signer before RPC or broadcast', async () => {
    const p = provider(9n);
    const c = new Connection(resolveConfig({ useEnv: false }), { provider: p, signer: signer(p, '0x0081111111111111111111111111111111111111') });
    await expect(c.assertWriteNetwork()).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(p.getNetwork).not.toHaveBeenCalled();
  });
  it('guards vault, factory and recovery broadcasts without retrying the send', async () => {
    const send = vi.fn().mockRejectedValue({ code: 'TIMEOUT' });
    const raw = { getFunction: () => send } as unknown as Contract;
    const guard = vi.fn().mockRejectedValue(new Error('wrong network'));
    const contracts = [new VaultContract(raw, {}, guard), new FactoryContract(raw, {}, guard), new RecoveryContract(raw, {}, guard)];
    for (const call of [() => (contracts[0] as VaultContract).approveTransaction(HASH), () => (contracts[1] as FactoryContract).registerWallet(ADDRESS), () => (contracts[2] as RecoveryContract).expireRecovery(ADDRESS, HASH)]) {
      await expect(call()).rejects.toThrow('wrong network');
    }
    expect(send).not.toHaveBeenCalled();
    guard.mockResolvedValue(undefined);
    await expect((contracts[0] as VaultContract).approveTransaction(HASH)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('submitted transactions retain reconciliation information', () => {
  it.each([null, { status: undefined, logs: [] }])('rejects an unverifiable receipt as unknown', async (receipt) => {
    await expect(waitForReceipt({ hash: HASH, wait: async () => receipt })).rejects.toMatchObject({ code: 'BROADCAST_UNKNOWN', chainTxHash: HASH });
  });
  it('retains a hash after a receipt timeout and never serializes the cause', async () => {
    const sent = { hash: HASH, wait: vi.fn().mockRejectedValue(new Error('secret payload')) };
    const error = await waitForReceipt(sent).catch((e) => e);
    expect(error.toJSON()).toMatchObject({ changed: 'unknown', chainTxHash: HASH });
    expect(JSON.stringify(error.toJSON())).not.toContain('secret payload');
    expect(sent.wait).toHaveBeenCalledTimes(1);
  });
  it('uses the submitted hash when the successful receipt omits it', async () => {
    expect(await waitForReceipt({ hash: HASH, wait: async () => ({ status: 1, logs: [] }) })).toMatchObject({ hash: HASH });
  });
  it('keeps a confirmed revert distinct from an unknown outcome', async () => {
    await expect(waitForReceipt({ hash: HASH, wait: async () => ({ status: 0, logs: [] }) })).rejects.toMatchObject({ code: 'REVERT' });
  });
});

describe('bounded waits and retries', () => {
  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid retry attempts %s before calling', async (maxAttempts) => {
    const call = vi.fn();
    await expect(withRetry(call, { maxAttempts })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(call).not.toHaveBeenCalled();
  });
  it('does not recurse indefinitely through cyclic error causes', () => {
    const a = new Error('a'); const b = new Error('b', { cause: a }); a.cause = b;
    expect(isTransient(a)).toBe(false);
  });
  it('aborts a long polling delay immediately and clears the timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = wait(60_000, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects infinite polling without querying', async () => {
    const client = new IndexerClient({ url: 'https://example.invalid', anonKey: 'unused', schema: 'testnet' });
    const state = vi.spyOn(client, 'state');
    await expect(client.waitForBlock(1, { timeoutMs: NaN })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(state).not.toHaveBeenCalled();
  });
});

it('refuses a supplied salt yielding an unusable vault before deployment', async () => {
  const config = resolveConfig({ useEnv: false });
  const send = vi.fn();
  const connection = {
    address: async () => ADDRESS,
    provider: { getCode: async () => '0x1234' },
    factory: () => ({ getFunction: (signature: string) => signature === 'implementation()' ? async () => config.contracts.implementation : send }),
    assertWriteNetwork: async () => undefined,
  } as unknown as Connection;
  const factory = new Factory({ connection, contracts: config.contracts });
  await expect(factory.create({ owners: [ADDRESS], threshold: 1, salt: HASH })).rejects.toMatchObject({ code: 'VALIDATION' });
  expect(send).not.toHaveBeenCalled();
});

it('does not echo an invalid private scalar in configuration errors', () => {
  const key = '0x' + 'ff'.repeat(32);
  try { connect({ privateKey: key, useEnv: false }); throw new Error('expected failure'); }
  catch (error) { expect(String(error)).not.toContain(key.slice(2)); }
});
