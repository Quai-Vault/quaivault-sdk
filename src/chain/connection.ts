import { Contract, JsonRpcProvider, Wallet, getZoneForAddress, isQuaiAddress } from 'quais';
import type { Provider, Signer } from 'quais';
import {
  Erc1155Abi,
  Erc20Abi,
  Erc721Abi,
  QuaiVaultAbi,
  QuaiVaultFactoryAbi,
  SocialRecoveryModuleAbi,
} from '../abi/index.js';
import type { Address } from '../types.js';
import { ConfigError, NoSignerError, ValidationError } from '../errors/index.js';
import type { ResolvedConfig } from '../config/resolve.js';
import type { RetryOptions } from './retry.js';

/**
 * Owns the provider/signer pair and hands out contract instances.
 *
 * Quai RPC endpoints are shard-pathed (`https://host/cyprus1`), which `quais`
 * handles via `usePathing: true` — the same setting the indexer uses.
 */
export class Connection {
  readonly provider: Provider;
  /** Retry policy for reads. Shared with every contract facade this hands out. */
  readonly retry: RetryOptions;
  private readonly _signer: Signer | null;

  constructor(config: ResolvedConfig, explicit: { provider?: Provider; signer?: Signer } = {}) {
    this.retry = config.retry ?? {};
    this.provider =
      explicit.provider ??
      (explicit.signer?.provider as Provider | undefined) ??
      new JsonRpcProvider(config.rpcUrl, undefined, { usePathing: true });

    if (explicit.signer) {
      this._signer = explicit.signer;
    } else if (config.privateKey) {
      this._signer = createPrivateKeySigner(config.privateKey, this.provider);
    } else {
      this._signer = null;
    }
  }

  get signer(): Signer | null {
    return this._signer;
  }

  hasSigner(): boolean {
    return this._signer !== null;
  }

  /** The signer, or a typed error naming the operation that needs one. */
  requireSigner(operation: string): Signer {
    if (!this._signer) throw new NoSignerError(operation);
    return this._signer;
  }

  async address(): Promise<Address> {
    return this.requireSigner('Reading the connected address').getAddress();
  }

  /** Connected address, or null when read-only. */
  async addressOrNull(): Promise<Address | null> {
    return this._signer ? this._signer.getAddress() : null;
  }

  vault(address: Address, write = false): Contract {
    return new Contract(
      address,
      QuaiVaultAbi,
      write ? this.requireSigner('This vault write') : this.provider,
    );
  }

  factory(address: Address, write = false): Contract {
    return new Contract(
      address,
      QuaiVaultFactoryAbi,
      write ? this.requireSigner('This factory write') : this.provider,
    );
  }

  socialRecovery(address: Address, write = false): Contract {
    return new Contract(
      address,
      SocialRecoveryModuleAbi,
      write ? this.requireSigner('This recovery write') : this.provider,
    );
  }

  /**
   * Read-only handle to a token contract.
   *
   * No write variant: the SDK never calls a token directly. Moving tokens goes
   * through the vault's proposal flow, which encodes the transfer as calldata.
   */
  token(address: Address, standard: 'ERC20' | 'ERC721' | 'ERC1155'): Contract {
    const abi =
      standard === 'ERC20' ? Erc20Abi : standard === 'ERC721' ? Erc721Abi : Erc1155Abi;
    return new Contract(address, abi as unknown as string[], this.provider);
  }
}

function createPrivateKeySigner(privateKey: string, provider: Provider): Signer {
  const normalized = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new ConfigError(
      'Invalid private key: expected 32 bytes of hex (64 characters, with or without a 0x prefix).',
      'Check QUAIVAULT_PRIVATE_KEY. Never commit a private key or pass one on the command line.',
    );
  }
  try {
    const wallet = new Wallet(normalized, provider);

    // A usable key must satisfy two independent constraints, and an arbitrary
    // secp256k1 key generally satisfies neither:
    //
    //   1. its address falls inside a real shard prefix (`getZoneForAddress`), and
    //   2. it is on the Quai ledger rather than Qi (`isQuaiAddress`).
    //
    // These are genuinely separate: 0x7E5F… passes `isQuaiAddress` but maps to no
    // zone. Checking only the ledger bit would let such a key through, and the
    // failure would surface much later as an opaque RPC error on the first
    // transaction. Quai HD derivation scans for keys meeting both.
    const zone = getZoneForAddress(wallet.address);
    if (!zone) {
      throw new ConfigError(
        `The supplied private key derives ${wallet.address}, which does not fall within any ` +
          'Quai shard prefix, so it cannot hold funds or transact.',
        'Use a key from a Quai wallet — quais HD derivation scans for shard-valid addresses. ' +
          'An arbitrary Ethereum key will not work.',
      );
    }
    if (!isQuaiAddress(wallet.address)) {
      throw new ConfigError(
        `The supplied private key derives ${wallet.address}, which is a Qi-ledger address. ` +
          'QuaiVault operates on the Quai ledger.',
        'Use a Quai-ledger key.',
      );
    }
    return wallet as unknown as Signer;
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(
      `Could not build a signer from the supplied private key: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

/** Assert a value is a 32-byte hex string, returning it lowercased. */
export function normalizeTxHash(value: unknown, label = 'transaction hash'): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new ValidationError(`Invalid ${label}: expected a 0x-prefixed 32-byte hex string.`);
  }
  return value.toLowerCase();
}
