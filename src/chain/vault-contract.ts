import type { Contract } from 'quais';
import { withRetry, type RetryOptions } from './retry.js';
import type { Address, Bytes32, Hex } from '../types.js';

/**
 * Raw `Transaction` struct as returned by `QuaiVault.transactions(bytes32)`.
 * Field names match the Solidity struct.
 */
export interface RawTransactionStruct {
  to: string;
  timestamp: bigint;
  expiration: bigint;
  proposer: string;
  executed: boolean;
  cancelled: boolean;
  approvedAt: bigint;
  executionDelay: bigint;
  value: bigint;
  data: string;
}

/**
 * Typed facade over the generated `Contract`.
 *
 * `quais` types its dynamic method accessor as possibly-undefined and cannot
 * disambiguate overloads by arity, so every call here goes through `getFunction`
 * with an explicit signature. Keeping that in one place means callers get real
 * types and overload selection is stated once, next to the ABI it depends on.
 */
export class VaultContract {
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

  getOwners(): Promise<string[]> {
    return this.read<string[]>('getOwners()');
  }

  isOwner(address: Address): Promise<boolean> {
    return this.read<boolean>('isOwner(address)', address);
  }

  threshold(): Promise<bigint> {
    return this.read<bigint>('threshold()');
  }

  nonce(): Promise<bigint> {
    return this.read<bigint>('nonce()');
  }

  minExecutionDelay(): Promise<bigint> {
    return this.read<bigint>('minExecutionDelay()');
  }

  moduleCount(): Promise<bigint> {
    return this.read<bigint>('moduleCount()');
  }

  getModules(): Promise<string[]> {
    return this.read<string[]>('getModules()');
  }

  isModuleEnabled(module: Address): Promise<boolean> {
    return this.read<boolean>('isModuleEnabled(address)', module);
  }

  delegatecallAllowed(target: Address): Promise<boolean> {
    return this.read<boolean>('delegatecallAllowed(address)', target);
  }

  transactions(txHash: Bytes32): Promise<RawTransactionStruct> {
    return this.read<RawTransactionStruct>('transactions(bytes32)', txHash);
  }

  /**
   * Whether an owner's approval currently counts toward the threshold.
   * Accounts for approval-epoch invalidation from owner removal.
   */
  hasApproved(txHash: Bytes32, owner: Address): Promise<boolean> {
    return this.read<boolean>('hasApproved(bytes32,address)', txHash, owner);
  }

  /** True when the transaction was closed by `expireTransaction`, not cancelled. */
  expiredTxs(txHash: Bytes32): Promise<boolean> {
    return this.read<boolean>('expiredTxs(bytes32)', txHash);
  }

  getTransactionHash(to: Address, value: bigint, data: Hex, nonce: number | bigint): Promise<Bytes32> {
    return this.read<Bytes32>(
      'getTransactionHash(address,uint256,bytes,uint256)',
      to, value, data, nonce,
    );
  }

  isValidSignature(hash: Bytes32, signature: Hex): Promise<string> {
    return this.read<string>('isValidSignature(bytes32,bytes)', hash, signature);
  }

  // ---- writes --------------------------------------------------------------

  /**
   * Overload with expiration and delay. The 3-argument overload is used when
   * neither is supplied, so a caller that wants no expiry never has to pass 0.
   */
  proposeTransactionFull(
    to: Address,
    value: bigint,
    data: Hex,
    expiration: number,
    executionDelay: number,
  ): Promise<ContractTransactionResponse> {
    return this.fn('proposeTransaction(address,uint256,bytes,uint48,uint32)')(
      to,
      value,
      data,
      expiration,
      executionDelay,
    ) as Promise<ContractTransactionResponse>;
  }

  proposeTransactionSimple(
    to: Address,
    value: bigint,
    data: Hex,
  ): Promise<ContractTransactionResponse> {
    return this.fn('proposeTransaction(address,uint256,bytes)')(
      to,
      value,
      data,
    ) as Promise<ContractTransactionResponse>;
  }

  approveTransaction(txHash: Bytes32): Promise<ContractTransactionResponse> {
    return this.fn('approveTransaction(bytes32)')(txHash) as Promise<ContractTransactionResponse>;
  }

  approveAndExecute(txHash: Bytes32): Promise<ContractTransactionResponse> {
    return this.fn('approveAndExecute(bytes32)')(txHash) as Promise<ContractTransactionResponse>;
  }

  executeTransaction(txHash: Bytes32): Promise<ContractTransactionResponse> {
    return this.fn('executeTransaction(bytes32)')(txHash) as Promise<ContractTransactionResponse>;
  }

  revokeApproval(txHash: Bytes32): Promise<ContractTransactionResponse> {
    return this.fn('revokeApproval(bytes32)')(txHash) as Promise<ContractTransactionResponse>;
  }

  cancelTransaction(txHash: Bytes32): Promise<ContractTransactionResponse> {
    return this.fn('cancelTransaction(bytes32)')(txHash) as Promise<ContractTransactionResponse>;
  }

  expireTransaction(txHash: Bytes32): Promise<ContractTransactionResponse> {
    return this.fn('expireTransaction(bytes32)')(txHash) as Promise<ContractTransactionResponse>;
  }

  encode(signature: string, args: unknown[]): Hex {
    return this.contract.interface.encodeFunctionData(signature, args) as Hex;
  }
}

/** Minimal shape of a sent transaction — enough to await a receipt. */
export interface ContractTransactionResponse {
  hash: string;
  wait(confirmations?: number): Promise<unknown>;
}

/** Typed facade over `QuaiVaultFactory`. */
export class FactoryContract {
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

  implementation(): Promise<string> {
    return this.read<string>('implementation()');
  }

  isWallet(address: Address): Promise<boolean> {
    return this.read<boolean>('isWallet(address)', address);
  }

  getWalletCount(): Promise<bigint> {
    return this.read<bigint>('getWalletCount()');
  }

  deployedWallets(index: number | bigint): Promise<string> {
    return this.read<string>('deployedWallets(uint256)', index);
  }

  predictWalletAddress(
    deployer: Address,
    salt: Bytes32,
    owners: Address[],
    threshold: number,
    minExecutionDelay: number,
    initialModules: Address[],
    initialDelegatecallTargets: Address[],
  ): Promise<string> {
    return this.read<string>(
      'predictWalletAddress(address,bytes32,address[],uint256,uint32,address[],address[])',
      deployer,
      salt,
      owners,
      threshold,
      minExecutionDelay,
      initialModules,
      initialDelegatecallTargets,
    );
  }

  /** Full 6-argument overload. The SDK always uses it so mining stays consistent. */
  createWallet(
    owners: Address[],
    threshold: number,
    salt: Bytes32,
    minExecutionDelay: number,
    initialModules: Address[],
    initialDelegatecallTargets: Address[],
  ): Promise<ContractTransactionResponse> {
    return this.fn('createWallet(address[],uint256,bytes32,uint32,address[],address[])')(
      owners,
      threshold,
      salt,
      minExecutionDelay,
      initialModules,
      initialDelegatecallTargets,
    ) as Promise<ContractTransactionResponse>;
  }

  registerWallet(wallet: Address): Promise<ContractTransactionResponse> {
    return this.fn('registerWallet(address)')(wallet) as Promise<ContractTransactionResponse>;
  }
}
