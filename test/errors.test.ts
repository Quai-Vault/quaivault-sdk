import { describe, expect, it } from 'vitest';
import { Interface, AbiCoder } from 'quais';
import { QuaiVaultAbi } from '../src/abi/index.js';
import {
  decodeRevert,
  decodeRevertFromError,
  knownErrorSelectors,
  remediationFor,
} from '../src/errors/decode.js';

const iface = new Interface(QuaiVaultAbi);

describe('decodeRevert', () => {
  it('decodes a parameterless custom error and attaches remediation', () => {
    const decoded = decodeRevert(iface.encodeErrorResult('NotAnOwner', []));
    expect(decoded?.name).toBe('NotAnOwner');
    expect(decoded?.message).toContain('not an owner');
  });

  it('decodes a custom error with arguments', () => {
    const at = 1_800_000_000;
    const decoded = decodeRevert(iface.encodeErrorResult('TimelockNotElapsed', [at]));
    expect(decoded?.name).toBe('TimelockNotElapsed');
    expect(decoded?.args[0]).toBe(BigInt(at));
    expect(decoded?.message).toContain(String(at));
  });

  it('decodes an address-carrying custom error', () => {
    const target = '0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const decoded = decodeRevert(iface.encodeErrorResult('DelegateCallNotAllowed', [target]));
    expect(decoded?.name).toBe('DelegateCallNotAllowed');
    expect(decoded?.message).toMatch(/whitelisted/);
  });

  it('decodes the Solidity Error(string) builtin', () => {
    const data =
      '0x08c379a0' +
      AbiCoder.defaultAbiCoder().encode(['string'], ['boom']).slice(2);
    const decoded = decodeRevert(data);
    expect(decoded?.name).toBe('Error');
    expect(decoded?.message).toBe('boom');
  });

  it('decodes the Panic(uint256) builtin', () => {
    const data =
      '0x4e487b71' + AbiCoder.defaultAbiCoder().encode(['uint256'], [0x11]).slice(2);
    const decoded = decodeRevert(data);
    expect(decoded?.name).toBe('Panic');
    expect(decoded?.message).toContain('0x11');
  });

  it('returns undefined for empty or unrecognised data', () => {
    expect(decodeRevert('0x')).toBeUndefined();
    expect(decodeRevert(undefined)).toBeUndefined();
    expect(decodeRevert('0xdeadbeef')).toBeUndefined();
  });
});

describe('decodeRevertFromError', () => {
  it('finds revert data on the error itself', () => {
    const err = { data: iface.encodeErrorResult('AlreadyApproved', []) };
    expect(decodeRevertFromError(err)?.name).toBe('AlreadyApproved');
  });

  it('finds revert data nested inside provider error wrappers', () => {
    const err = {
      code: 'CALL_EXCEPTION',
      info: { error: { data: iface.encodeErrorResult('NotEnoughApprovals', []) } },
    };
    expect(decodeRevertFromError(err)?.name).toBe('NotEnoughApprovals');
  });

  it('survives a circular error object', () => {
    const err: Record<string, unknown> = { message: 'x' };
    err.cause = err;
    expect(decodeRevertFromError(err)).toBeUndefined();
  });

  it('returns undefined when there is nothing to decode', () => {
    expect(decodeRevertFromError(new Error('network unreachable'))).toBeUndefined();
  });
});

describe('error registry', () => {
  it('covers every custom error across the QuaiVault ABIs', () => {
    const selectors = knownErrorSelectors();
    // QuaiVault alone declares 42; the registry also spans factory, module and proxy.
    expect(selectors.length).toBeGreaterThanOrEqual(42);
    expect(new Set(selectors.map((s) => s.selector)).size).toBe(selectors.length);
  });

  it('has remediation text for the errors callers hit most', () => {
    for (const name of [
      'NotAnOwner',
      'NotEnoughApprovals',
      'TimelockNotElapsed',
      'CannotCancelApprovedTransaction',
      'DelegateCallNotAllowed',
      'TransactionIsExpired',
    ]) {
      expect(remediationFor(name), `missing remediation for ${name}`).toBeTruthy();
    }
  });
});
