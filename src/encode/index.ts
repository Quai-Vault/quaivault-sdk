import { AbiCoder, Interface, concat, getBytes, solidityPacked } from 'quais';
import {
  Erc1155Abi,
  Erc20Abi,
  Erc721Abi,
  MultiSendCallOnlyAbi,
  QuaiVaultAbi,
  SocialRecoveryModuleAbi,
} from '../abi/index.js';
import type { Address, Hex } from '../types.js';
import { Operation } from '../types.js';
import { ValidationError } from '../errors/index.js';

const vault = new Interface(QuaiVaultAbi);
const recovery = new Interface(SocialRecoveryModuleAbi);
const multiSend = new Interface(MultiSendCallOnlyAbi);
const erc20 = new Interface(Erc20Abi as unknown as string[]);
const erc721 = new Interface(Erc721Abi as unknown as string[]);
const erc1155 = new Interface(Erc1155Abi as unknown as string[]);

export const interfaces = { vault, recovery, multiSend, erc20, erc721, erc1155 };

/** Max value the contracts accept for `minExecutionDelay` / `requestedDelay` (30 days). */
export const MAX_EXECUTION_DELAY = 30 * 24 * 60 * 60;
export const MAX_OWNERS = 20;
export const MAX_MODULES = 50;
/** Head of the Zodiac module linked list. Never valid as an owner, module or guardian. */
export const SENTINEL_MODULES = '0x0000000000000000000000000000000000000001';
/** Rejected everywhere an address is committed to a role. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------
// Vault self-calls
//
// Every one of these must be delivered as a proposed transaction whose `to` is the
// vault itself. The vault's `_executeSelfCall` dispatcher rejects any selector it
// does not recognise, so encoding must come from this ABI.
// ---------------------------------------------------------------------------

export const selfCall = {
  addOwner: (owner: Address): Hex => vault.encodeFunctionData('addOwner', [owner]),

  removeOwner: (owner: Address): Hex => vault.encodeFunctionData('removeOwner', [owner]),

  changeThreshold: (threshold: number): Hex => {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new ValidationError(`Invalid threshold ${threshold}: must be an integer >= 1.`);
    }
    return vault.encodeFunctionData('changeThreshold', [threshold]);
  },

  enableModule: (module: Address): Hex => vault.encodeFunctionData('enableModule', [module]),

  /**
   * Disable a module.
   *
   * `prevModule` is the predecessor in the Zodiac linked list and must be resolved
   * against the live list — a proposal built against a stale list can never execute.
   * Prefer `Vault.propose.disableModule`, which resolves it for you.
   */
  disableModule: (prevModule: Address, module: Address): Hex =>
    vault.encodeFunctionData('disableModule', [prevModule, module]),

  setMinExecutionDelay: (seconds: number): Hex => {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_EXECUTION_DELAY) {
      throw new ValidationError(
        `Invalid execution delay ${seconds}: must be an integer between 0 and ${MAX_EXECUTION_DELAY} (30 days).`,
      );
    }
    return vault.encodeFunctionData('setMinExecutionDelay', [seconds]);
  },

  addDelegatecallTarget: (target: Address): Hex =>
    vault.encodeFunctionData('addDelegatecallTarget', [target]),

  removeDelegatecallTarget: (target: Address): Hex =>
    vault.encodeFunctionData('removeDelegatecallTarget', [target]),

  cancelByConsensus: (txHash: Hex): Hex => vault.encodeFunctionData('cancelByConsensus', [txHash]),

  /** Sign arbitrary bytes. For EIP-1271 hash pre-approval use {@link approveHashForEip1271}. */
  signMessage: (data: Hex): Hex => vault.encodeFunctionData('signMessage', [data]),

  unsignMessage: (data: Hex): Hex => vault.encodeFunctionData('unsignMessage', [data]),

  /**
   * Pre-approve a hash so `isValidSignature(hash, …)` returns the EIP-1271 magic value.
   *
   * `isValidSignature(h)` checks `signedMessages[getMessageHash(abi.encode(h))]`, while
   * `signMessage(data)` stores `getMessageHash(data)`. Because `abi.encode` of a static
   * `bytes32` is the identity on its 32 bytes, this produces calldata identical to
   * `signMessage(hash)` — the encoding step is a no-op for a well-formed hash.
   *
   * It is a separate helper because the *length* is what matters: signing an
   * arbitrary-length message `M` does NOT make `isValidSignature(keccak256(M))`
   * validate, since EIP-1271 hashes the 32-byte dataHash, not `M`. This entry point
   * enforces the 32-byte precondition and states the intent, so that mistake is
   * caught here rather than discovered when a counterparty's check silently fails.
   */
  approveHashForEip1271: (hash: Hex): Hex => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new ValidationError('approveHashForEip1271 expects a 32-byte hash.');
    }
    const encoded = AbiCoder.defaultAbiCoder().encode(['bytes32'], [hash]);
    return vault.encodeFunctionData('signMessage', [encoded]);
  },

  /** Revoke a hash previously approved via {@link approveHashForEip1271}. */
  revokeHashForEip1271: (hash: Hex): Hex => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new ValidationError('revokeHashForEip1271 expects a 32-byte hash.');
    }
    const encoded = AbiCoder.defaultAbiCoder().encode(['bytes32'], [hash]);
    return vault.encodeFunctionData('unsignMessage', [encoded]);
  },
};

// ---------------------------------------------------------------------------
// Token calls
// ---------------------------------------------------------------------------

export const token = {
  erc20Transfer: (to: Address, amount: bigint): Hex =>
    erc20.encodeFunctionData('transfer', [to, amount]),
  erc20Approve: (spender: Address, amount: bigint): Hex =>
    erc20.encodeFunctionData('approve', [spender, amount]),
  erc721Transfer: (from: Address, to: Address, tokenId: bigint): Hex =>
    erc721.encodeFunctionData('safeTransferFrom(address,address,uint256)', [from, to, tokenId]),
  erc1155Transfer: (from: Address, to: Address, id: bigint, amount: bigint, data: Hex = '0x'): Hex =>
    erc1155.encodeFunctionData('safeTransferFrom', [from, to, id, amount, data]),
  erc1155BatchTransfer: (
    from: Address,
    to: Address,
    ids: bigint[],
    amounts: bigint[],
    data: Hex = '0x',
  ): Hex => {
    if (ids.length !== amounts.length) {
      throw new ValidationError('erc1155BatchTransfer: ids and amounts must be the same length.');
    }
    return erc1155.encodeFunctionData('safeBatchTransferFrom', [from, to, ids, amounts, data]);
  },
};

// ---------------------------------------------------------------------------
// Social recovery
// ---------------------------------------------------------------------------

export const recoveryCall = {
  /** Encoded for a vault-proposed call to the module (not a self-call). */
  setupRecovery: (
    vaultAddress: Address,
    guardians: Address[],
    threshold: number,
    recoveryPeriodSeconds: number,
  ): Hex => {
    if (guardians.length === 0) throw new ValidationError('At least one guardian is required.');
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > guardians.length) {
      throw new ValidationError(
        `Invalid guardian threshold ${threshold}: must be between 1 and ${guardians.length}.`,
      );
    }
    return recovery.encodeFunctionData('setupRecovery', [
      vaultAddress,
      guardians,
      threshold,
      recoveryPeriodSeconds,
    ]);
  },
};

// ---------------------------------------------------------------------------
// MultiSend batching
// ---------------------------------------------------------------------------

export interface BatchCall {
  to: Address;
  value?: bigint;
  data?: Hex;
}

/**
 * Pack calls into MultiSendCallOnly's transaction blob:
 * `operation(1) ‖ to(20) ‖ value(32) ‖ dataLength(32) ‖ data`, concatenated.
 *
 * `MultiSendCallOnly` rejects nested DelegateCall, so operation is always 0.
 */
export function encodeMultiSendPayload(calls: BatchCall[]): Hex {
  if (calls.length === 0) throw new ValidationError('encodeMultiSendPayload: no calls supplied.');

  const parts = calls.map((call) => {
    const data = call.data ?? '0x';
    const bytes = getBytes(data);
    return solidityPacked(
      ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
      [Operation.Call, call.to, call.value ?? 0n, bytes.length, bytes],
    );
  });

  return concat(parts);
}

/** Full `multiSend(bytes)` calldata for a batch of calls. */
export function encodeMultiSend(calls: BatchCall[]): Hex {
  return multiSend.encodeFunctionData('multiSend', [encodeMultiSendPayload(calls)]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Smallest expiration the contract will accept for a given delay.
 *
 * `_proposeTransaction` rejects `expiration <= block.timestamp + effectiveDelay` with
 * `ExpirationTooSoon`, so a proposal must leave at least one execution opportunity
 * after the timelock elapses. The margin absorbs the gap between building the
 * proposal and it being mined.
 */
export function minimumExpiration(
  effectiveDelaySeconds: number,
  marginSeconds = 300,
  at: number = Math.floor(Date.now() / 1000),
): number {
  return at + effectiveDelaySeconds + marginSeconds;
}
