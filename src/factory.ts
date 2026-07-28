import { Interface, getAddress } from 'quais';
import { assertQuaiAddress, assertQuaiAddresses } from './address.js';
import { QuaiVaultFactoryAbi } from './abi/index.js';
import type { Connection } from './chain/connection.js';
import { FactoryContract } from './chain/vault-contract.js';
import { PreconditionError, RevertError, ValidationError } from './errors/index.js';
import { decodeRevertFromError } from './errors/decode.js';
import { MAX_EXECUTION_DELAY, MAX_OWNERS } from './encode/index.js';
import type { ReceiptLike } from './lifecycle/outcome.js';
import { mineSalt, type MineSaltOptions, type MiningStrategy } from './salt/mine.js';
import { predictVaultAddress } from './salt/predict.js';
import type {
  Address,
  Bytes32,
  ContractAddresses,
  CreateVaultParams,
  CreateVaultResult,
  Hex,
  MinedSalt,
} from './types.js';

const factoryInterface = new Interface(QuaiVaultFactoryAbi);

export interface CreateProgress {
  step: 'validating' | 'mining' | 'deploying' | 'confirming' | 'done';
  message: string;
  attempts?: number;
  predictedAddress?: Address;
  chainTxHash?: Hex;
}

export interface FactoryContext {
  connection: Connection;
  contracts: ContractAddresses;
}

/** Deploy and look up vaults through `QuaiVaultFactory`. */
export class Factory {
  constructor(private readonly ctx: FactoryContext) {}

  get address(): Address {
    return this.ctx.contracts.factory;
  }

  private contract(write = false): FactoryContract {
    return new FactoryContract(this.ctx.connection.factory(this.address, write), this.ctx.connection.retry);
  }

  /** The implementation every proxy from this factory delegates to. */
  async implementation(): Promise<Address> {
    return getAddress(await this.contract().implementation());
  }

  /** Whether the factory has this vault in its registry. */
  async isRegistered(vault: Address): Promise<boolean> {
    return this.contract().isWallet(getAddress(vault));
  }

  async vaultCount(): Promise<number> {
    return Number(await this.contract().getWalletCount());
  }

  async vaultAt(index: number): Promise<Address> {
    return getAddress(await this.contract().deployedWallets(index));
  }

  /**
   * Verify the configured implementation address matches what the factory reports.
   *
   * A mismatch means salt mining will predict addresses the factory will not deploy
   * to, so it is worth catching before a deployment rather than after.
   */
  async verify(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    try {
      const onChain = await this.implementation();
      if (onChain.toLowerCase() !== this.ctx.contracts.implementation.toLowerCase()) {
        errors.push(
          `Configured implementation ${this.ctx.contracts.implementation} does not match the ` +
            `factory's ${onChain}. Address prediction and salt mining will be wrong.`,
        );
      }
      const code = await this.ctx.connection.provider.getCode(onChain);
      if (code === '0x') errors.push(`No contract code at implementation ${onChain}.`);
    } catch (err) {
      errors.push(
        `Could not reach the factory at ${this.address}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    return { valid: errors.length === 0, errors };
  }

  /** Off-chain CREATE2 prediction. Identical to `factory.predictWalletAddress`. */
  predictAddress(deployer: Address, salt: Bytes32, params: CreateVaultParams): Address {
    validateCreateParams(params);
    return predictVaultAddress({
      factory: this.address,
      implementation: this.ctx.contracts.implementation,
      deployer: getAddress(deployer),
      salt,
      params,
    });
  }

  /**
   * Mine a CREATE2 salt placing the vault on the deployer's shard.
   *
   * Quai addresses are shard-scoped, so an arbitrary salt usually produces a vault
   * the deployer cannot reach. The mined salt is only valid for these exact create
   * params — changing owners, threshold, delay, modules or delegatecall targets
   * changes the predicted address.
   */
  async mineSalt(
    params: CreateVaultParams,
    options: Partial<Omit<MineSaltOptions, 'factory' | 'implementation' | 'params'>> = {},
    strategy?: MiningStrategy,
  ): Promise<MinedSalt> {
    validateCreateParams(params);
    const deployer = options.deployer ?? (await this.ctx.connection.address());
    return mineSalt(
      {
        factory: this.address,
        implementation: this.ctx.contracts.implementation,
        deployer: getAddress(deployer),
        params,
        ...options,
      },
      strategy,
    );
  }

  /**
   * Deploy a vault, mining a salt first when one is not supplied.
   *
   * Always uses the 6-argument `createWallet` overload so the deployed bytecode
   * matches what mining predicted, whatever combination of modules and delegatecall
   * targets is requested.
   */
  async create(
    params: CreateVaultParams,
    options: {
      onProgress?: (progress: CreateProgress) => void;
      miningStrategy?: MiningStrategy;
      maxAttempts?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<CreateVaultResult> {
    const { onProgress } = options;
    validateCreateParams(params);

    onProgress?.({ step: 'validating', message: 'Checking factory configuration…' });
    const verification = await this.verify();
    if (!verification.valid) {
      throw new PreconditionError(verification.errors.join(' '), {
        remediation: 'Check the configured factory and implementation addresses for this network.',
      });
    }

    const deployer = getAddress(await this.ctx.connection.address());

    let salt = params.salt;
    let predictedAddress: Address | undefined;

    if (salt) {
      predictedAddress = this.predictAddress(deployer, salt, params);
    } else {
      onProgress?.({ step: 'mining', message: 'Mining a salt for your shard…' });
      const mined = await this.mineSalt(
        params,
        {
          deployer,
          ...(options.maxAttempts != null ? { maxAttempts: options.maxAttempts } : {}),
          ...(options.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
          onProgress: (attempts) =>
            onProgress?.({ step: 'mining', message: `Mining… ${attempts} attempts`, attempts }),
        },
        options.miningStrategy,
      );
      salt = mined.salt;
      predictedAddress = mined.predictedAddress;
      onProgress?.({
        step: 'mining',
        message: `Found ${mined.predictedAddress} after ${mined.attempts} attempts`,
        attempts: mined.attempts,
        predictedAddress: mined.predictedAddress,
      });
    }

    onProgress?.({ step: 'deploying', message: 'Submitting the deployment…', predictedAddress });

    const factory = this.contract(true);
    let receipt: ReceiptLike;
    let chainTxHash: Hex;
    try {
      const sent = await factory.createWallet(
        params.owners.map((o) => getAddress(o)),
        params.threshold,
        salt,
        params.minExecutionDelay ?? 0,
        (params.initialModules ?? []).map((m) => getAddress(m)),
        (params.initialDelegatecallTargets ?? []).map((t) => getAddress(t)),
      );
      chainTxHash = sent.hash as Hex;
      onProgress?.({ step: 'confirming', message: 'Waiting for confirmation…', chainTxHash });
      receipt = (await sent.wait()) as ReceiptLike;
    } catch (err) {
      const decoded = decodeRevertFromError(err);
      throw new RevertError(
        `Vault creation failed${decoded ? `: ${decoded.message}` : ''}`,
        decoded,
        { cause: err },
      );
    }

    if (!receipt || receipt.status === 0) {
      throw new RevertError('The deployment transaction reverted.');
    }

    const address = extractCreatedVault(receipt, this.address);
    if (!address) {
      throw new RevertError(
        'The deployment was mined but no WalletCreated event was found.',
      );
    }

    onProgress?.({ step: 'done', message: `Vault deployed at ${address}`, chainTxHash });

    return {
      address,
      chainTxHash,
      salt,
      predictionMatched:
        predictedAddress !== undefined &&
        predictedAddress.toLowerCase() === address.toLowerCase(),
    };
  }

  /** Register an externally deployed proxy. Callable only by one of its owners. */
  async register(vault: Address): Promise<{ chainTxHash: Hex }> {
    const factory = this.contract(true);
    try {
      const sent = await factory.registerWallet(getAddress(vault));
      const receipt = (await sent.wait()) as ReceiptLike;
      if (!receipt || receipt.status === 0) {
        throw new RevertError('Registration reverted.');
      }
      return { chainTxHash: (receipt.hash ?? receipt.transactionHash ?? '') as Hex };
    } catch (err) {
      if (err instanceof RevertError) throw err;
      const decoded = decodeRevertFromError(err);
      throw new RevertError(
        `Registering the vault failed${decoded ? `: ${decoded.message}` : ''}`,
        decoded,
        { cause: err },
      );
    }
  }
}

function validateCreateParams(params: CreateVaultParams): void {
  const { owners, threshold } = params;

  if (!Array.isArray(owners) || owners.length === 0) {
    throw new ValidationError('At least one owner is required.');
  }
  if (owners.length > MAX_OWNERS) {
    throw new ValidationError(`A vault may have at most ${MAX_OWNERS} owners (got ${owners.length}).`);
  }
  const seen = new Set<string>();
  owners.forEach((owner, i) => {
    // Rejects Qi-ledger and zone-less addresses: an owner that cannot sign is dead
    // weight against the threshold, and enough of them brick the vault. The contract
    // only guards the zero address, the vault itself and the module sentinel.
    assertQuaiAddress(owner, `owner[${i}]`);
    const key = owner.toLowerCase();
    if (key === '0x0000000000000000000000000000000000000000' ||
        key === '0x0000000000000000000000000000000000000001') {
      throw new ValidationError(
        `Owner ${owner} is reserved — the zero address and the module sentinel 0x…01 are rejected.`,
      );
    }
    if (seen.has(key)) throw new ValidationError(`Duplicate owner: ${owner}.`);
    seen.add(key);
  });

  if (params.initialModules?.length) {
    assertQuaiAddresses(params.initialModules, 'initialModules');
  }
  if (params.initialDelegatecallTargets?.length) {
    assertQuaiAddresses(params.initialDelegatecallTargets, 'initialDelegatecallTargets');
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) {
    throw new ValidationError(
      `Invalid threshold ${threshold}: must be an integer between 1 and ${owners.length}.`,
    );
  }
  const delay = params.minExecutionDelay ?? 0;
  if (!Number.isInteger(delay) || delay < 0 || delay > MAX_EXECUTION_DELAY) {
    throw new ValidationError(
      `Invalid minExecutionDelay ${delay}: must be between 0 and ${MAX_EXECUTION_DELAY} seconds (30 days).`,
    );
  }
}

/** Pull the vault address out of the factory's `WalletCreated` event. */
function extractCreatedVault(receipt: ReceiptLike, factoryAddress: string): Address | null {
  const target = factoryAddress.toLowerCase();
  for (const log of receipt.logs ?? []) {
    if (log.address && log.address.toLowerCase() !== target) continue;
    try {
      const parsed = factoryInterface.parseLog({
        topics: Array.from(log.topics),
        data: log.data,
      });
      if (parsed?.name === 'WalletCreated') {
        return getAddress(String(parsed.args[0]));
      }
    } catch {
      continue;
    }
  }
  return null;
}
