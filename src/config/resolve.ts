import { isAddress } from 'quais';
import type {
  ClientOptions,
  Consistency,
  ContractAddresses,
  IndexerConfig,
  NetworkConfig,
} from '../types.js';
import { ConfigError } from '../errors/index.js';
import type { RetryOptions } from '../chain/retry.js';
import { isNetworkName, networks } from './networks.js';

/**
 * Environment variables read when `useEnv` is not disabled.
 *
 * Explicit `ClientOptions` always win over the environment; the environment always
 * wins over the network preset. Nothing here is read at module load — resolution
 * happens inside `connect()`, so importing the SDK never touches `process.env`.
 */
export const ENV_VARS = {
  network: 'QUAIVAULT_NETWORK',
  rpcUrl: 'QUAIVAULT_RPC_URL',
  privateKey: 'QUAIVAULT_PRIVATE_KEY',
  indexerUrl: 'QUAIVAULT_INDEXER_URL',
  indexerAnonKey: 'QUAIVAULT_INDEXER_ANON_KEY',
  indexerSchema: 'QUAIVAULT_INDEXER_SCHEMA',
  indexerHealthUrl: 'QUAIVAULT_INDEXER_HEALTH_URL',
  factory: 'QUAIVAULT_FACTORY',
  implementation: 'QUAIVAULT_IMPLEMENTATION',
  socialRecovery: 'QUAIVAULT_SOCIAL_RECOVERY_MODULE',
  multiSendCallOnly: 'QUAIVAULT_MULTISEND_CALL_ONLY',
  consistency: 'QUAIVAULT_CONSISTENCY',
  maxIndexerLagBlocks: 'QUAIVAULT_MAX_INDEXER_LAG_BLOCKS',
} as const;

export interface ResolvedConfig {
  network: NetworkConfig;
  contracts: ContractAddresses;
  indexer?: IndexerConfig;
  rpcUrl: string;
  /**
   * ⚠️ Secret. Consumed once to build a signer and never retained afterwards.
   *
   * Never log or serialise a `ResolvedConfig` that still carries this — use
   * {@link redactConfig}, which is what `QuaiVaultClient.config` exposes.
   */
  privateKey?: string;
  consistency: Consistency;
  maxIndexerLagBlocks: number;
  retry: RetryOptions;
}

/** A `ResolvedConfig` with the private key removed. Safe to log. */
export type PublicConfig = Omit<ResolvedConfig, 'privateKey'> & { privateKey?: never };

/**
 * Strip the private key so the config can be logged or serialised.
 *
 * Also masks the indexer key — it is public by design, but a full dump in logs
 * invites confusion about which credentials are sensitive.
 */
export function redactConfig(config: ResolvedConfig): PublicConfig {
  const { privateKey: _omitted, ...rest } = config;
  return {
    ...rest,
    ...(rest.indexer
      ? { indexer: { ...rest.indexer, anonKey: maskKey(rest.indexer.anonKey) } }
      : {}),
    // `network` carries its own copy of the indexer block; mask that one as well or
    // a config dump still prints the key in full.
    network: rest.network.indexer
      ? {
          ...rest.network,
          indexer: { ...rest.network.indexer, anonKey: maskKey(rest.network.indexer.anonKey) },
        }
      : rest.network,
  } as PublicConfig;
}

function maskKey(key: string): string {
  return key.length <= 12 ? '***' : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

type Env = Record<string, string | undefined>;

function readEnv(useEnv: boolean): Env {
  if (!useEnv) return {};
  // `process` is absent in browsers and some edge runtimes — degrade to no env
  // rather than throwing, so the SDK stays isomorphic.
  const proc = (globalThis as { process?: { env?: Env } }).process;
  return proc?.env ?? {};
}

function pick<T>(...values: Array<T | undefined | ''>): T | undefined {
  for (const v of values) {
    if (v !== undefined && v !== '') return v as T;
  }
  return undefined;
}

function requireAddress(value: string | undefined, label: string, envVar: string): string {
  if (!value) {
    throw new ConfigError(
      `Missing ${label}. Set ${envVar} or pass it via connect({ contracts: { … } }).`,
    );
  }
  if (!isAddress(value)) {
    throw new ConfigError(`Invalid ${label}: "${value}" is not a valid address.`);
  }
  return value;
}

function optionalAddress(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  if (!isAddress(value)) {
    throw new ConfigError(`Invalid ${label}: "${value}" is not a valid address.`);
  }
  return value;
}

function parseConsistency(value: string | undefined): Consistency | undefined {
  if (value === undefined) return undefined;
  if (value === 'auto' || value === 'indexed' || value === 'chain') return value;
  throw new ConfigError(
    `Invalid consistency "${value}". Expected one of: auto, indexed, chain.`,
  );
}

function parseLag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ConfigError(`Invalid ${ENV_VARS.maxIndexerLagBlocks}: "${value}". Expected a non-negative number.`);
  }
  return n;
}

/**
 * Merge, in order of decreasing precedence: explicit options → environment →
 * network preset defaults.
 */
export function resolveConfig(options: ClientOptions = {}): ResolvedConfig {
  const env = readEnv(options.useEnv !== false);

  // --- network preset
  const networkInput = options.network ?? env[ENV_VARS.network] ?? 'mainnet';
  let base: NetworkConfig;
  if (typeof networkInput === 'string') {
    if (!isNetworkName(networkInput)) {
      throw new ConfigError(
        `Unknown network "${networkInput}". Built-in networks: ${Object.keys(networks).join(', ')}. ` +
          `Pass a full NetworkConfig object for a custom deployment.`,
      );
    }
    base = networks[networkInput];
  } else {
    base = networkInput;
  }

  // --- rpc
  const rpcUrl = pick(options.rpcUrl, env[ENV_VARS.rpcUrl], base.rpcUrl);
  if (!rpcUrl) {
    throw new ConfigError(`Missing RPC URL. Set ${ENV_VARS.rpcUrl} or pass connect({ rpcUrl }).`);
  }

  // --- contracts
  const contracts: ContractAddresses = {
    factory: requireAddress(
      pick(options.contracts?.factory, env[ENV_VARS.factory], base.contracts.factory),
      'factory address',
      ENV_VARS.factory,
    ),
    implementation: requireAddress(
      pick(
        options.contracts?.implementation,
        env[ENV_VARS.implementation],
        base.contracts.implementation,
      ),
      'implementation address',
      ENV_VARS.implementation,
    ),
    socialRecovery: optionalAddress(
      pick(options.contracts?.socialRecovery, env[ENV_VARS.socialRecovery], base.contracts.socialRecovery),
      'social recovery module address',
    ),
    multiSendCallOnly: optionalAddress(
      pick(
        options.contracts?.multiSendCallOnly,
        env[ENV_VARS.multiSendCallOnly],
        base.contracts.multiSendCallOnly,
      ),
      'MultiSendCallOnly address',
    ),
  };

  // --- indexer (optional: the SDK is fully usable chain-only)
  const indexerUrl = pick(options.indexer?.url, env[ENV_VARS.indexerUrl], base.indexer?.url);
  const anonKey = pick(options.indexer?.anonKey, env[ENV_VARS.indexerAnonKey], base.indexer?.anonKey);
  const schema = pick(options.indexer?.schema, env[ENV_VARS.indexerSchema], base.indexer?.schema);

  let indexer: IndexerConfig | undefined;
  if (indexerUrl && anonKey && schema) {
    indexer = {
      url: indexerUrl,
      anonKey,
      schema,
      healthUrl: pick(
        options.indexer?.healthUrl,
        env[ENV_VARS.indexerHealthUrl],
        base.indexer?.healthUrl,
      ),
    };
  }

  const consistency =
    options.consistency ?? parseConsistency(env[ENV_VARS.consistency]) ?? 'auto';

  // Without an indexer, 'auto' degrades to chain-only reads; 'indexed' is a
  // configuration error the caller should hear about now rather than at first query.
  if (!indexer && consistency === 'indexed') {
    throw new ConfigError(
      `consistency: 'indexed' requires indexer configuration. ` +
        `Set ${ENV_VARS.indexerUrl}, ${ENV_VARS.indexerAnonKey} and ${ENV_VARS.indexerSchema}.`,
    );
  }

  return {
    network: { ...base, rpcUrl, contracts, ...(indexer ? { indexer } : {}) },
    contracts,
    indexer,
    rpcUrl,
    privateKey: pick(options.privateKey, env[ENV_VARS.privateKey]),
    consistency,
    maxIndexerLagBlocks:
      options.maxIndexerLagBlocks ?? parseLag(env[ENV_VARS.maxIndexerLagBlocks]) ?? 50,
    retry: {
      ...(options.retry?.maxAttempts != null ? { maxAttempts: options.retry.maxAttempts } : {}),
      ...(options.retry?.baseDelayMs != null ? { baseDelayMs: options.retry.baseDelayMs } : {}),
      ...(options.retry?.maxDelayMs != null ? { maxDelayMs: options.retry.maxDelayMs } : {}),
      ...(options.retry?.onRetry ? { onRetry: options.retry.onRetry } : {}),
    },
  };
}
