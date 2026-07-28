/**
 * @quaivault/sdk — TypeScript SDK for QuaiVault multisig vaults on Quai Network.
 *
 * ```ts
 * import { connect } from '@quaivault/sdk';
 *
 * const qv = connect({ network: 'mainnet' });
 * const vault = qv.vault('0x00…');
 * console.log(await vault.info());
 * ```
 */

// --- client
export { QuaiVault, QuaiVaultClient, connect } from './client.js';
export { Vault, type VaultContext } from './vault.js';
export { Factory, type CreateProgress, type FactoryContext } from './factory.js';
export { RecoveryModule, type RecoveryModuleContext } from './recovery.js';
export {
  loadBalances,
  type BalanceOptions,
  type TokenBalance,
  type VaultBalances,
} from './balances.js';
export { Connection } from './chain/connection.js';
export { withRetry, isTransient, type RetryOptions } from './chain/retry.js';
export { VaultContract, FactoryContract, type RawTransactionStruct } from './chain/vault-contract.js';
export {
  RecoveryContract,
  type RawRecovery,
  type RawRecoveryConfig,
} from './chain/recovery-contract.js';

// --- configuration
export { networks, mainnet, testnet, isNetworkName, type NetworkName } from './config/networks.js';
export { resolveConfig, ENV_VARS, type ResolvedConfig } from './config/resolve.js';

// --- indexer
export { IndexerClient } from './indexer/client.js';
export { IndexerQueries } from './indexer/queries.js';
export {
  watchVault,
  type Subscription,
  type WatchEvent,
  type WatchOptions,
  type WatchTopic,
} from './indexer/watch.js';
export * as indexerSchemas from './indexer/schemas.js';

// --- encoding / decoding
export {
  selfCall,
  token as tokenCalls,
  recoveryCall,
  encodeMultiSend,
  encodeMultiSendPayload,
  minimumExpiration,
  interfaces,
  MAX_EXECUTION_DELAY,
  MAX_MODULES,
  MAX_OWNERS,
  SENTINEL_MODULES,
  type BatchCall,
} from './encode/index.js';
export {
  decodeCall,
  decodeMultiSendPayload,
  type DecodeContext,
  type DecodeResult,
  type DecodedBatchCall,
} from './decode/index.js';

// --- lifecycle
export {
  classifyExecution,
  extractProposedTxHash,
  type ReceiptLike,
} from './lifecycle/outcome.js';
export {
  deriveStatus,
  deriveRecoveryStatus,
  executableAfterOf,
  isTerminal,
  nowSeconds,
  type RawTransactionState,
  type RawRecoveryState,
} from './lifecycle/status.js';
export {
  computeAffordances,
  allowedActions,
  type AffordanceContext,
} from './lifecycle/affordances.js';

// --- CREATE2 / salt mining
export {
  mineSalt,
  defaultStrategy,
  syncStrategy,
  workerThreadsStrategy,
  type MineSaltOptions,
  type MiningStrategy,
} from './salt/mine.js';
export {
  predictVaultAddress,
  encodeInitData,
  computeBytecodeHash,
  computeFullSalt,
  shardPrefixOf,
} from './salt/predict.js';

// --- address validation
export {
  assertQuaiAddress,
  assertQuaiAddresses,
  inspectAddress,
  isUsableQuaiAddress,
  type AddressCheck,
  type AddressLedger,
} from './address.js';

// --- errors
export {
  QuaiVaultError,
  ConfigError,
  NoSignerError,
  NoIndexerError,
  IndexerQueryError,
  ValidationError,
  NotFoundError,
  PreconditionError,
  RevertError,
  SaltMiningError,
  StaleProposalError,
  type QuaiVaultErrorCode,
} from './errors/index.js';
export { decodeRevert, decodeRevertFromError, knownErrorSelectors, remediationFor } from './errors/decode.js';

// --- ABIs
export * from './abi/index.js';

// --- types
export * from './types.js';
