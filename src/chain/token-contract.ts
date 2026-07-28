import type { Contract } from 'quais';
import { withRetry, type RetryOptions } from './retry.js';
import type { Address } from '../types.js';

/**
 * Retry policy for token reads, deliberately tighter than the client's default.
 *
 * These are the highest-volume reads the SDK issues — a `balances()` call fans out
 * over every token a vault has ever touched — so they are the most likely to trip a
 * shared endpoint's rate limit, which is exactly what a retry should absorb.
 *
 * But they are also the reads most likely to fail *permanently* and unremarkably. A
 * self-destructed or non-standard token answers `balanceOf` with `0x`, which `quais`
 * reports as `BAD_DATA` — a code the shared policy classes as transient. Under the
 * default three attempts with backoff, one junk token in a vault's history would cost
 * seconds before the caller falls back to the replayed figure it was always going to
 * use. Two attempts absorbs a genuine blip without paying for that twice over.
 */
const TOKEN_RETRY: RetryOptions = { maxAttempts: 2, baseDelayMs: 150 };

/**
 * Typed, retrying facade over an ERC20/721/1155 contract.
 *
 * Tokens are only ever read, never written to — the vault's own proposal flow is what
 * moves them — so there is no write half here and no signer involved.
 */
export class TokenContract {
  private readonly retry: RetryOptions;

  constructor(
    readonly contract: Contract,
    retry: RetryOptions = {},
  ) {
    // Defaults, not overrides: a caller who explicitly configured a retry policy
    // meant it, and still gets their `onRetry` hook either way.
    this.retry = { ...TOKEN_RETRY, ...retry };
  }

  private read<T>(signature: string, ...args: unknown[]): Promise<T> {
    return withRetry(() => this.contract.getFunction(signature)(...args) as Promise<T>, this.retry);
  }

  /** ERC20 units held, or — for ERC721 — the number of tokens held. */
  balanceOf(owner: Address): Promise<bigint> {
    return this.read<bigint>('balanceOf(address)', owner);
  }

  /** ERC721 only. Reverts for a burned or never-minted id. */
  ownerOf(tokenId: string | bigint): Promise<string> {
    return this.read<string>('ownerOf(uint256)', tokenId);
  }

  /** ERC1155 only. One call for many ids, so it stays a single round trip. */
  balanceOfBatch(owners: Address[], ids: Array<string | bigint>): Promise<bigint[]> {
    return this.read<bigint[]>('balanceOfBatch(address[],uint256[])', owners, ids);
  }
}
