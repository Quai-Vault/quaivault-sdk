import { getAddress } from 'quais';
import type { Provider, Signer } from 'quais';
import { Connection } from './chain/connection.js';
import { redactConfig, resolveConfig, type PublicConfig, type ResolvedConfig } from './config/resolve.js';
import { Factory } from './factory.js';
import { IndexerClient } from './indexer/client.js';
import { IndexerQueries } from './indexer/queries.js';
import { NoIndexerError } from './errors/index.js';
import { Vault, type VaultContext } from './vault.js';
import type {
  Address,
  ClientOptions,
  IndexerHealth,
  NetworkConfig,
  Pagination,
} from './types.js';

/**
 * Entry point to the SDK.
 *
 * Construct with {@link connect}. Nothing here performs I/O until a method is
 * called, so building a client is cheap and safe at module scope.
 */
export class QuaiVaultClient {
  /**
   * Resolved configuration, with the private key stripped and the indexer key
   * masked — safe to log. The key itself is consumed once when building the signer.
   */
  readonly config: PublicConfig;
  readonly connection: Connection;
  readonly factory: Factory;
  readonly indexer: IndexerClient | null;
  readonly queries: IndexerQueries | null;

  constructor(options: ClientOptions = {}) {
    // `resolved` holds the secret and is never stored on the instance.
    const resolved: ResolvedConfig = resolveConfig(options);
    this.config = redactConfig(resolved);
    this.connection = new Connection(resolved, {
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.signer ? { signer: options.signer } : {}),
    });

    // Built from `resolved`, not `this.config` — the latter's indexer key is masked.
    this.indexer = resolved.indexer ? new IndexerClient(resolved.indexer) : null;
    this.queries = this.indexer ? new IndexerQueries(this.indexer) : null;

    this.factory = new Factory({
      connection: this.connection,
      contracts: this.config.contracts,
    });
  }

  get network(): NetworkConfig {
    return this.config.network;
  }

  get provider(): Provider {
    return this.connection.provider;
  }

  get signer(): Signer | null {
    return this.connection.signer;
  }

  /** The connected address, or null when read-only. */
  async address(): Promise<Address | null> {
    return this.connection.addressOrNull();
  }

  /** A handle to one vault. No I/O. */
  vault(address: Address): Vault {
    return new Vault(address, this.vaultContext());
  }

  private vaultContext(): VaultContext {
    return {
      connection: this.connection,
      indexer: this.indexer,
      queries: this.queries,
      contracts: this.config.contracts,
      consistency: this.config.consistency,
      maxIndexerLagBlocks: this.config.maxIndexerLagBlocks,
    };
  }

  /** Vault discovery. Requires the indexer — there is no on-chain reverse index. */
  readonly vaults = {
    /**
     * Vaults where `owner` is an active owner.
     *
     * Indexer-only: `factory.getWalletsByCreator` was removed from the contracts for
     * gas reasons, and the factory registry is not indexed by owner.
     */
    forOwner: async (owner: Address, options: Pagination = {}): Promise<Address[]> => {
      const queries = this.requireQueries('Looking up vaults by owner');
      const rows = await queries.vaultsForOwner(getAddress(owner), options);
      return rows.map((r) => getAddress(r.address));
    },

    /** Vaults where `guardian` is an active social-recovery guardian. */
    forGuardian: async (guardian: Address, options: Pagination = {}): Promise<Address[]> => {
      const queries = this.requireQueries('Looking up vaults by guardian');
      const rows = await queries.vaultsForGuardian(getAddress(guardian), options);
      return rows.map((r) => getAddress(r.address));
    },

    /** Whether an address is a vault this factory deployed or registered. */
    exists: async (address: Address): Promise<boolean> => {
      return this.factory.isRegistered(getAddress(address));
    },

    get: (address: Address): Vault => this.vault(address),
  };

  private requireQueries(operation: string): IndexerQueries {
    if (!this.queries) throw new NoIndexerError(operation);
    return this.queries;
  }

  /** Indexer liveness and lag. Reports unavailable when no indexer is configured. */
  async indexerHealth(): Promise<IndexerHealth> {
    if (!this.indexer) {
      return {
        available: false,
        lastIndexedBlock: 0,
        isSyncing: false,
        error: 'no indexer configured',
      };
    }
    return this.indexer.health();
  }
}

/**
 * Create a client.
 *
 * Configuration resolves in order of decreasing precedence: explicit options,
 * environment variables, then the network preset. With nothing supplied it targets
 * mainnet over the public RPC in read-only mode.
 *
 * ```ts
 * // read-only, from env (QUAIVAULT_NETWORK, QUAIVAULT_INDEXER_ANON_KEY, …)
 * const qv = connect();
 *
 * // read-write against testnet
 * const qv = connect({ network: 'testnet', privateKey: process.env.KEY });
 * ```
 */
export function connect(options: ClientOptions = {}): QuaiVaultClient {
  return new QuaiVaultClient(options);
}

/** Namespace form, for callers who prefer `QuaiVault.connect(…)`. */
export const QuaiVault = { connect };
