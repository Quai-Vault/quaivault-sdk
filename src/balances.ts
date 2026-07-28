import { getAddress } from 'quais';
import type { Connection } from './chain/connection.js';
import { TokenContract } from './chain/token-contract.js';
import { DEFAULT_CONCURRENCY, mapPooled } from './pool.js';
import type { IndexerQueries } from './indexer/queries.js';
import type { TokenRow, TokenTransferRow } from './indexer/schemas.js';
import { sanitizeText } from './text.js';
import type { Address } from './types.js';

export interface TokenBalance {
  token: Address;
  standard: 'ERC20' | 'ERC721' | 'ERC1155';
  /**
   * Ticker as the token reports it — deployer-controlled, so passed through
   * {@link sanitizeText} and capped. Falls back to `???` when the token has none or
   * supplied nothing printable.
   */
  symbol: string;
  /** Display name. Same provenance and treatment as {@link symbol}. */
  name: string;
  decimals: number;
  /** ERC20: raw units. ERC721: number held. ERC1155: total across ids. */
  balance: bigint;
  /** ERC721 / ERC1155 only. */
  tokenIds?: string[];
  /** True when the balance came from an on-chain read rather than transfer replay. */
  verified: boolean;
  /**
   * Set when more candidate ids existed than `maxTokenIdChecks` allowed, so
   * `tokenIds` is a subset. The `balance` is still the authoritative on-chain count.
   */
  tokenIdsTruncated?: boolean;
}

export interface VaultBalances {
  native: bigint;
  tokens: TokenBalance[];
  /**
   * Set when a scan limit was hit, so the result may be incomplete. Silent
   * truncation would read as "these are all the holdings" when they are not.
   */
  truncated?: {
    /** More transfer history existed than `transferScanLimit` scanned. */
    transfers?: boolean;
    /** More distinct tokens were discovered than `maxTokens` allowed. */
    tokens?: boolean;
  };
}

export interface BalanceOptions {
  /**
   * Confirm each candidate balance with an on-chain read. Slower, but authoritative —
   * a token that moved through a path the indexer does not observe still reports
   * correctly. Default true.
   */
  verify?: boolean;
  /** Cap on tokens considered, newest activity first. Default 50. */
  maxTokens?: number;
  /**
   * How many recent transfer rows to scan when discovering tokens. Default 500.
   *
   * Scanned across as many indexer requests as it takes, so this is a real budget
   * rather than a single page size. A vault with more transfers than this may not
   * surface its oldest holdings, so raise it for long-lived vaults. Reported back in
   * {@link VaultBalances.truncated}.
   */
  transferScanLimit?: number;
  /** Cap on ERC721 ids ownership-checked per token. Default 100. */
  maxTokenIdChecks?: number;
  /**
   * Ceiling on in-flight RPC reads. Default 8.
   *
   * Applied at both fan-out levels independently, so the true ceiling is the square
   * of this. Raise it against a private node; lower it if a shared endpoint is
   * rate-limiting you.
   */
  concurrency?: number;
}

/**
 * Aggregate a vault's holdings.
 *
 * Discovery is indexer-driven: `token_transfers` tells us which contracts a vault has
 * ever touched, which the chain cannot answer without scanning every log. Amounts are
 * then read on chain by default, because replaying transfers misses anything the
 * indexer did not observe (a token discovered after the transfer, a rebasing balance,
 * a direct mint). Set `verify: false` to skip the reads and accept replayed totals.
 */
export async function loadBalances(
  connection: Connection,
  queries: IndexerQueries | null,
  vault: Address,
  options: BalanceOptions = {},
): Promise<VaultBalances> {
  const verify = options.verify !== false;
  const maxTokens = options.maxTokens ?? 50;
  const transferScanLimit = options.transferScanLimit ?? 500;
  const maxTokenIdChecks = options.maxTokenIdChecks ?? 100;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const address = getAddress(vault);

  const native = BigInt(await connection.provider.getBalance(address));
  if (!queries) return { native, tokens: [] };

  // Discover candidates from transfer history, most recent first. Scanned as a budget
  // across however many requests it takes, so `hasMore` below means "older transfers
  // exist beyond the budget", not "the page was clamped".
  const transfers = await queries.tokenTransferScan(address, transferScanLimit);
  const seen = new Map<string, TokenTransferRow[]>();
  for (const row of transfers.data) {
    const key = row.token_address.toLowerCase();
    const list = seen.get(key);
    if (list) list.push(row);
    else seen.set(key, [row]);
  }

  const allCandidates = Array.from(seen.keys());
  const candidates = allCandidates.slice(0, maxTokens);
  const truncated = {
    ...(transfers.hasMore ? { transfers: true } : {}),
    ...(allCandidates.length > maxTokens ? { tokens: true } : {}),
  };

  if (candidates.length === 0) {
    return { native, tokens: [], ...(Object.keys(truncated).length ? { truncated } : {}) };
  }

  const metadata = await queries.tokens(candidates);
  const byAddress = new Map(metadata.map((t) => [t.address.toLowerCase(), t]));

  const balances = await mapPooled(candidates, concurrency, (token) =>
    buildBalance(
      connection,
      address,
      token,
      byAddress.get(token),
      seen.get(token) ?? [],
      verify,
      maxTokenIdChecks,
      concurrency,
    ),
  );

  return {
    native,
    // Drop dust and fully-exited positions so callers get a holdings view, not a history.
    tokens: balances.filter((b): b is TokenBalance => b !== null && b.balance > 0n),
    ...(Object.keys(truncated).length ? { truncated } : {}),
  };
}

async function buildBalance(
  connection: Connection,
  vault: Address,
  token: string,
  meta: TokenRow | undefined,
  transfers: TokenTransferRow[],
  verify: boolean,
  maxTokenIdChecks: number,
  concurrency: number,
): Promise<TokenBalance | null> {
  const standard = meta?.standard ?? inferStandard(transfers);
  const replayed = replayBalance(transfers, standard);

  const base: TokenBalance = {
    token: getAddress(token),
    standard,
    // Deployer-controlled strings headed for someone's terminal. See `src/text.ts`.
    symbol: sanitizeText(meta?.symbol, 32) || '???',
    name: sanitizeText(meta?.name, 64) || 'Unknown token',
    decimals: meta?.decimals ?? (standard === 'ERC20' ? 18 : 0),
    balance: replayed.balance,
    ...(replayed.tokenIds.length > 0 ? { tokenIds: replayed.tokenIds } : {}),
    verified: false,
  };

  if (!verify) return base;

  // Through the facade, not a bare `new Contract`: these are the highest-volume reads
  // the SDK issues and so the likeliest to meet a rate limit. See `TokenContract`.
  const contract = new TokenContract(connection.token(token, standard), connection.retry);

  try {
    if (standard === 'ERC20') {
      return { ...base, balance: BigInt(await contract.balanceOf(vault)), verified: true };
    }

    if (standard === 'ERC721') {
      const count = await contract.balanceOf(vault);
      // ERC721 has no enumeration without the optional extension; keep the replayed
      // id list but trust the on-chain count.
      const owned = await filterOwned(
        contract,
        vault,
        replayed.tokenIds,
        maxTokenIdChecks,
        concurrency,
      );
      return {
        ...base,
        balance: BigInt(count),
        ...(owned.length > 0 ? { tokenIds: owned } : {}),
        ...(replayed.tokenIds.length > maxTokenIdChecks ? { tokenIdsTruncated: true } : {}),
        verified: true,
      };
    }

    // ERC1155: balances are per-id, so read the ids the vault has touched.
    const ids = replayed.tokenIds;
    if (ids.length === 0) return { ...base, verified: true };

    const amounts = await contract.balanceOfBatch(
      ids.map(() => vault),
      ids,
    );

    const held: string[] = [];
    let total = 0n;
    ids.forEach((id, i) => {
      const amount = BigInt(amounts[i] ?? 0);
      if (amount > 0n) {
        held.push(id);
        total += amount;
      }
    });
    return { ...base, balance: total, ...(held.length > 0 ? { tokenIds: held } : {}), verified: true };
  } catch {
    // Unreadable contract (self-destructed, non-standard, wrong shard): fall back to
    // the replayed figure rather than dropping the position silently.
    return base;
  }
}

/** Net inflows minus outflows, and the set of ids currently believed held. */
function replayBalance(
  transfers: TokenTransferRow[],
  standard: 'ERC20' | 'ERC721' | 'ERC1155',
): { balance: bigint; tokenIds: string[] } {
  if (standard === 'ERC20') {
    let balance = 0n;
    for (const t of transfers) {
      const value = safeBigInt(t.value);
      balance += t.direction === 'inflow' ? value : -value;
    }
    return { balance: balance > 0n ? balance : 0n, tokenIds: [] };
  }

  // NFTs: track per-id net position, oldest first so later transfers win.
  const perId = new Map<string, bigint>();
  const ordered = [...transfers].sort((a, b) => Number(a.block_number) - Number(b.block_number));
  for (const t of ordered) {
    const id = t.token_id ?? '0';
    const amount = standard === 'ERC721' ? 1n : safeBigInt(t.value);
    const current = perId.get(id) ?? 0n;
    perId.set(id, current + (t.direction === 'inflow' ? amount : -amount));
  }

  const tokenIds: string[] = [];
  let balance = 0n;
  for (const [id, amount] of perId) {
    if (amount > 0n) {
      tokenIds.push(id);
      balance += amount;
    }
  }
  return { balance, tokenIds };
}

/** Confirm current ownership of candidate ERC721 ids. */
async function filterOwned(
  contract: TokenContract,
  vault: Address,
  ids: string[],
  limit: number,
  concurrency: number,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const results = await mapPooled(ids.slice(0, limit), concurrency, async (id) => {
    try {
      const owner = await contract.ownerOf(id);
      return owner.toLowerCase() === vault.toLowerCase() ? id : null;
    } catch {
      return null; // burned or non-existent
    }
  });
  return results.filter((id): id is string => id !== null);
}

function inferStandard(transfers: TokenTransferRow[]): 'ERC20' | 'ERC721' | 'ERC1155' {
  const withId = transfers.find((t) => t.token_id != null);
  if (!withId) return 'ERC20';
  // ERC1155 fans batches out with a batch_index; ERC721 never does.
  return transfers.some((t) => (t.batch_index ?? 0) > 0) ? 'ERC1155' : 'ERC721';
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}
