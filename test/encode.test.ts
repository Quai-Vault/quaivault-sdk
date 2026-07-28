import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, keccak256 } from 'quais';
import { QuaiVaultAbi } from '../src/abi/index.js';
import {
  encodeMultiSend,
  encodeMultiSendPayload,
  minimumExpiration,
  selfCall,
} from '../src/encode/index.js';
import { decodeMultiSendPayload } from '../src/decode/index.js';
import { ValidationError } from '../src/errors/index.js';

const iface = new Interface(QuaiVaultAbi);
const A = '0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH = '0x' + 'ab'.repeat(32);

describe('self-call encoders round-trip against the real ABI', () => {
  it('addOwner / removeOwner', () => {
    expect(iface.parseTransaction({ data: selfCall.addOwner(A) })?.name).toBe('addOwner');
    expect(iface.parseTransaction({ data: selfCall.removeOwner(A) })?.name).toBe('removeOwner');
  });

  it('changeThreshold carries the value', () => {
    const parsed = iface.parseTransaction({ data: selfCall.changeThreshold(3) });
    expect(parsed?.name).toBe('changeThreshold');
    expect(Number(parsed?.args[0])).toBe(3);
  });

  it('rejects a threshold below 1', () => {
    expect(() => selfCall.changeThreshold(0)).toThrow(ValidationError);
  });

  it('rejects an execution delay past the 30-day maximum', () => {
    expect(() => selfCall.setMinExecutionDelay(30 * 86400 + 1)).toThrow(ValidationError);
    expect(() => selfCall.setMinExecutionDelay(30 * 86400)).not.toThrow();
  });

  it('disableModule carries both the predecessor and the module', () => {
    const parsed = iface.parseTransaction({ data: selfCall.disableModule(A, B) });
    expect(parsed?.name).toBe('disableModule');
    expect(String(parsed?.args[0]).toLowerCase()).toBe(A);
    expect(String(parsed?.args[1]).toLowerCase()).toBe(B);
  });
});

describe('EIP-1271 hash approval', () => {
  // isValidSignature(h) checks signedMessages[getMessageHash(abi.encode(h))], while
  // signMessage(data) stores getMessageHash(data).
  it('encodes the hash as the signMessage payload', () => {
    const encoded = selfCall.approveHashForEip1271(HASH);
    const parsed = iface.parseTransaction({ data: encoded });
    expect(parsed?.name).toBe('signMessage');
    expect(parsed?.args[0]).toBe(AbiCoder.defaultAbiCoder().encode(['bytes32'], [HASH]));
  });

  it('is identical to signMessage(hash), because abi.encode of a bytes32 is the identity', () => {
    // Documents the equivalence deliberately: the helper exists for the length check
    // and the intent, not because the encoding differs.
    expect(AbiCoder.defaultAbiCoder().encode(['bytes32'], [HASH])).toBe(HASH);
    expect(selfCall.approveHashForEip1271(HASH)).toBe(selfCall.signMessage(HASH));
  });

  it('rejects an arbitrary-length message, which would not validate under EIP-1271', () => {
    // signMessage(M) makes getMessageHash(M) true, but isValidSignature(keccak256(M))
    // checks a different key — so approving a non-hash here is always a mistake.
    expect(() => selfCall.approveHashForEip1271('0xdeadbeef')).toThrow(ValidationError);
  });

  it('revokeHashForEip1271 mirrors it via unsignMessage', () => {
    const parsed = iface.parseTransaction({ data: selfCall.revokeHashForEip1271(HASH) });
    expect(parsed?.name).toBe('unsignMessage');
    expect(parsed?.args[0]).toBe(AbiCoder.defaultAbiCoder().encode(['bytes32'], [HASH]));
  });

  it('rejects anything that is not a 32-byte hash', () => {
    expect(() => selfCall.approveHashForEip1271('0x1234')).toThrow(ValidationError);
  });
});

describe('MultiSend packing', () => {
  it('round-trips through the decoder', () => {
    const calls = [
      { to: A, value: 1000n, data: '0x' },
      { to: B, value: 0n, data: '0xdeadbeef' },
    ];
    const decoded = decodeMultiSendPayload(encodeMultiSendPayload(calls));

    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.to.toLowerCase()).toBe(A);
    expect(decoded[0]!.value).toBe(1000n);
    expect(decoded[0]!.data).toBe('0x');
    expect(decoded[1]!.to.toLowerCase()).toBe(B);
    expect(decoded[1]!.data).toBe('0xdeadbeef');
  });

  it('always uses operation 0 — MultiSendCallOnly rejects nested DelegateCall', () => {
    const decoded = decodeMultiSendPayload(encodeMultiSendPayload([{ to: A, value: 0n }]));
    expect(decoded[0]!.operation).toBe(0);
  });

  it('wraps the payload in multiSend(bytes)', () => {
    const data = encodeMultiSend([{ to: A, value: 1n }]);
    expect(data.startsWith(keccak256(Buffer.from('multiSend(bytes)')).slice(0, 10))).toBe(true);
  });

  it('rejects an empty batch', () => {
    expect(() => encodeMultiSendPayload([])).toThrow(ValidationError);
  });
});

describe('minimumExpiration', () => {
  it('leaves room after the timelock elapses', () => {
    // The contract rejects expiration <= now + effectiveDelay with ExpirationTooSoon.
    expect(minimumExpiration(3600, 0, 1000)).toBe(4600);
    expect(minimumExpiration(3600, 300, 1000)).toBe(4900);
  });
});
