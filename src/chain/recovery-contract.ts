import type { Contract } from 'quais';
import { withRetry, type RetryOptions } from './retry.js';
import type { Address, Bytes32 } from '../types.js';
import type { ContractTransactionResponse } from './vault-contract.js';

/** Raw `RecoveryConfig` struct from `getRecoveryConfig(address)`. */
export interface RawRecoveryConfig {
  guardians: string[];
  threshold: bigint;
  recoveryPeriod: bigint;
}

/** Raw `Recovery` struct from `getRecovery(address,bytes32)`. */
export interface RawRecovery {
  newOwners: string[];
  newThreshold: bigint;
  approvalCount: bigint;
  executionTime: bigint;
  expiration: bigint;
  requiredThreshold: bigint;
  executed: boolean;
}

/**
 * Typed facade over `SocialRecoveryModule`.
 *
 * Every function is wallet-scoped: one module deployment serves every vault, so the
 * vault address is always the first argument.
 */
export class RecoveryContract {
  constructor(
    readonly contract: Contract,
    private readonly retry: RetryOptions = {},
  ) {}

  private fn(signature: string) {
    return this.contract.getFunction(signature);
  }

  /**
   * Reads retry transient RPC failures (see {@link withRetry}); writes never do,
   * because a resubmit that looks like a timeout may already be in the mempool.
   */
  private read<T>(signature: string, ...args: unknown[]): Promise<T> {
    return withRetry(() => this.fn(signature)(...args) as Promise<T>, this.retry);
  }

  get interface() {
    return this.contract.interface;
  }

  // ---- reads ---------------------------------------------------------------

  getRecoveryConfig(vault: Address): Promise<RawRecoveryConfig> {
    return this.read<RawRecoveryConfig>('getRecoveryConfig(address)', vault);
  }

  getRecovery(vault: Address, recoveryHash: Bytes32): Promise<RawRecovery> {
    return this.read<RawRecovery>('getRecovery(address,bytes32)', vault, recoveryHash);
  }

  isGuardian(vault: Address, guardian: Address): Promise<boolean> {
    return this.read<boolean>('isGuardian(address,address)', vault, guardian);
  }

  getPendingRecoveryHashes(vault: Address): Promise<string[]> {
    return this.read<string[]>('getPendingRecoveryHashes(address)', vault);
  }

  hasPendingRecoveries(vault: Address): Promise<boolean> {
    return this.read<boolean>('hasPendingRecoveries(address)', vault);
  }

  recoveryApprovals(vault: Address, recoveryHash: Bytes32, guardian: Address): Promise<boolean> {
    return this.read<boolean>(
      'recoveryApprovals(address,bytes32,address)',
      vault, recoveryHash, guardian,
    );
  }

  recoveryNonces(vault: Address): Promise<bigint> {
    return this.read<bigint>('recoveryNonces(address)', vault);
  }

  maxGuardians(): Promise<bigint> {
    return this.read<bigint>('MAX_GUARDIANS()');
  }

  /** Hash for an explicit nonce. Use {@link predictNextRecoveryHash} for the next one. */
  getRecoveryHash(
    vault: Address,
    newOwners: Address[],
    newThreshold: number,
    nonce: bigint | number,
  ): Promise<Bytes32> {
    return this.read<Bytes32>(
      'getRecoveryHash(address,address[],uint256,uint256)',
      vault, newOwners, newThreshold, nonce,
    );
  }

  /** Hash the next `initiateRecovery` would produce, at the current nonce. */
  predictNextRecoveryHash(
    vault: Address,
    newOwners: Address[],
    newThreshold: number,
  ): Promise<Bytes32> {
    return this.read<Bytes32>(
      'predictNextRecoveryHash(address,address[],uint256)',
      vault, newOwners, newThreshold,
    );
  }

  // ---- writes --------------------------------------------------------------

  initiateRecovery(
    vault: Address,
    newOwners: Address[],
    newThreshold: number,
  ): Promise<ContractTransactionResponse> {
    return this.fn('initiateRecovery(address,address[],uint256)')(
      vault,
      newOwners,
      newThreshold,
    ) as Promise<ContractTransactionResponse>;
  }

  approveRecovery(vault: Address, recoveryHash: Bytes32): Promise<ContractTransactionResponse> {
    return this.fn('approveRecovery(address,bytes32)')(
      vault,
      recoveryHash,
    ) as Promise<ContractTransactionResponse>;
  }

  revokeRecoveryApproval(
    vault: Address,
    recoveryHash: Bytes32,
  ): Promise<ContractTransactionResponse> {
    return this.fn('revokeRecoveryApproval(address,bytes32)')(
      vault,
      recoveryHash,
    ) as Promise<ContractTransactionResponse>;
  }

  executeRecovery(vault: Address, recoveryHash: Bytes32): Promise<ContractTransactionResponse> {
    return this.fn('executeRecovery(address,bytes32)')(
      vault,
      recoveryHash,
    ) as Promise<ContractTransactionResponse>;
  }

  cancelRecovery(vault: Address, recoveryHash: Bytes32): Promise<ContractTransactionResponse> {
    return this.fn('cancelRecovery(address,bytes32)')(
      vault,
      recoveryHash,
    ) as Promise<ContractTransactionResponse>;
  }

  expireRecovery(vault: Address, recoveryHash: Bytes32): Promise<ContractTransactionResponse> {
    return this.fn('expireRecovery(address,bytes32)')(
      vault,
      recoveryHash,
    ) as Promise<ContractTransactionResponse>;
  }
}
