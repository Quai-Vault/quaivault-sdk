import type { IndexerClient } from './client.js';
import {
  ConfirmationSchema,
  DelegatecallTargetSchema,
  DepositSchema,
  RecoveryApprovalSchema,
  RecoveryConfigSchema,
  RecoveryGuardianSchema,
  RecoverySchema,
  SignedMessageSchema,
  TokenSchema,
  TokenTransferSchema,
  TransactionSchema,
  WalletModuleSchema,
  WalletOwnerSchema,
  WalletSchema,
  type ConfirmationRow,
  type DepositRow,
  type RecoveryApprovalRow,
  type RecoveryRow,
  type SignedMessageRow,
  type TokenRow,
  type TokenTransferRow,
  type TransactionRow,
  type WalletRow,
} from './schemas.js';
import { IndexerQueryError } from '../errors/index.js';
import type { Address, Page, Pagination } from '../types.js';

const DEFAULT_LIMIT = 50;
/**
 * Rows a single request may ask for.
 *
 * PostgREST is happy to return more, but a large page is also a large response to
 * hold and parse, and it makes a slow query slower rather than failing fast. Callers
 * that genuinely need more should page — see {@link IndexerQueries.tokenTransferScan}
 * for the pattern.
 */
export const MAX_LIMIT = 200;
/**
 * Transaction hashes per `in(...)` filter in {@link IndexerQueries.activeConfirmationsBatch}.
 *
 * 40 keeps the request line near 3 KB and the worst-case response at
 * `40 × MAX_OWNERS = 800` rows — both comfortably inside the defaults that would
 * otherwise truncate the result without saying so.
 */
const CONFIRMATION_CHUNK = 40;

function lower(address: Address): string {
  return address.toLowerCase();
}

function bounds(options: Pagination = {}) {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);
  return { limit, offset };
}

export class IndexerQueries {
  constructor(private readonly client: IndexerClient) {}

  // ---- wallets -------------------------------------------------------------

  async wallet(address: Address): Promise<WalletRow | null> {
    return this.client.selectOne('wallets', WalletSchema, (q) =>
      q.select('*').eq('address', lower(address)).single(),
    );
  }

  /** Active owner addresses, lowercased as stored. */
  async owners(address: Address): Promise<string[]> {
    const rows = await this.client.select('wallet_owners', WalletOwnerSchema, (q) =>
      q.select('*').eq('wallet_address', lower(address)).eq('is_active', true),
    );
    return rows.map((r) => r.owner_address);
  }

  async vaultsForOwner(owner: Address, options: Pagination = {}): Promise<WalletRow[]> {
    const { limit, offset } = bounds(options);
    const { data, error } = await this.client
      .from('wallet_owners')
      .select('wallet_address, wallets (*)')
      .eq('owner_address', lower(owner))
      .eq('is_active', true)
      .range(offset, offset + limit - 1);

    if (error) throw new IndexerQueryError(`Indexer query failed: ${error.message}`, error);
    return extractJoined(data, WalletSchema);
  }

  async vaultsForGuardian(guardian: Address, options: Pagination = {}): Promise<WalletRow[]> {
    const { limit, offset } = bounds(options);
    const { data, error } = await this.client
      .from('social_recovery_guardians')
      .select('wallet_address, wallets (*)')
      .eq('guardian_address', lower(guardian))
      .eq('is_active', true)
      .range(offset, offset + limit - 1);

    if (error) throw new IndexerQueryError(`Indexer query failed: ${error.message}`, error);
    return extractJoined(data, WalletSchema);
  }

  // ---- transactions --------------------------------------------------------

  async pendingTransactions(vault: Address, options: Pagination = {}): Promise<TransactionRow[]> {
    const { limit, offset } = bounds(options);
    return this.client.select('transactions', TransactionSchema, (q) =>
      q
        .select('*')
        .eq('wallet_address', lower(vault))
        .eq('status', 'pending')
        .order('submitted_at_block', { ascending: false })
        .range(offset, offset + limit - 1),
    );
  }

  async transaction(vault: Address, txHash: string): Promise<TransactionRow | null> {
    return this.client.selectOne('transactions', TransactionSchema, (q) =>
      q.select('*').eq('wallet_address', lower(vault)).eq('tx_hash', txHash.toLowerCase()).single(),
    );
  }

  /**
   * Several transactions by hash, chunked for the same reasons as
   * {@link activeConfirmationsBatch} — hashes are long, and they go in the query string.
   *
   * Rows come back in no particular order and hashes with no row are simply absent;
   * the caller matches them up.
   */
  async transactionsByHash(vault: Address, txHashes: string[]): Promise<TransactionRow[]> {
    if (txHashes.length === 0) return [];

    const hashes = txHashes.map((h) => h.toLowerCase());
    const chunks: string[][] = [];
    for (let i = 0; i < hashes.length; i += CONFIRMATION_CHUNK) {
      chunks.push(hashes.slice(i, i + CONFIRMATION_CHUNK));
    }

    const pages = await Promise.all(
      chunks.map((chunk) =>
        this.client.select('transactions', TransactionSchema, (q) =>
          q.select('*').eq('wallet_address', lower(vault)).in('tx_hash', chunk),
        ),
      ),
    );
    return pages.flat();
  }

  async transactionHistory(
    vault: Address,
    options: Pagination & { status?: string[] } = {},
  ): Promise<Page<TransactionRow>> {
    const { limit, offset } = bounds(options);
    const statuses = options.status ?? ['executed', 'cancelled', 'expired', 'failed'];

    return this.client.selectPage('transactions', TransactionSchema, limit, (q) =>
      q
        .select('*', { count: 'estimated' })
        .eq('wallet_address', lower(vault))
        .in('status', statuses)
        .order('submitted_at_block', { ascending: false })
        // One past the page, so `hasMore` is exact. See `selectPage`.
        .range(offset, offset + limit),
    );
  }

  /** All confirmations for one transaction, including revoked ones. */
  async confirmations(vault: Address, txHash: string): Promise<ConfirmationRow[]> {
    return this.client.select('confirmations', ConfirmationSchema, (q) =>
      q
        .select('*')
        .eq('wallet_address', lower(vault))
        .eq('tx_hash', txHash.toLowerCase())
        .order('confirmed_at_block', { ascending: true }),
    );
  }

  /**
   * Active confirmations for many transactions, in as few round trips as is safe.
   *
   * "Active" here means not revoked. It does NOT mean the confirming address is
   * still an owner — the indexer does not deactivate confirmations when an owner is
   * removed, while the contract invalidates them via approval epochs. Callers must
   * intersect with the active owner set; `Vault` does this for you.
   *
   * Chunked rather than issued as one `in(...)`, because a single filter fails two
   * ways at scale. PostgREST reads filters from the query string, and each 32-byte
   * hash costs ~70 characters there — a full {@link MAX_LIMIT} page of hashes builds a
   * ~14 KB request line, past the 8 KB cap most reverse proxies apply by default. The
   * response is bounded too: {@link CONFIRMATION_CHUNK} transactions can carry at most
   * `chunk × MAX_OWNERS` rows, and the chunk is sized to keep that under the
   * `max-rows` ceiling PostgREST deployments commonly set, so a busy vault cannot be
   * silently short-served.
   */
  async activeConfirmationsBatch(
    vault: Address,
    txHashes: string[],
  ): Promise<Map<string, ConfirmationRow[]>> {
    const result = new Map<string, ConfirmationRow[]>();
    for (const hash of txHashes) result.set(hash.toLowerCase(), []);
    if (txHashes.length === 0) return result;

    const hashes = txHashes.map((h) => h.toLowerCase());
    const chunks: string[][] = [];
    for (let i = 0; i < hashes.length; i += CONFIRMATION_CHUNK) {
      chunks.push(hashes.slice(i, i + CONFIRMATION_CHUNK));
    }

    const pages = await Promise.all(
      chunks.map((chunk) =>
        this.client.select('confirmations', ConfirmationSchema, (q) =>
          q
            .select('*')
            .eq('wallet_address', lower(vault))
            .in('tx_hash', chunk)
            .eq('is_active', true),
        ),
      ),
    );

    for (const row of pages.flat()) {
      const key = row.tx_hash.toLowerCase();
      const list = result.get(key);
      if (list) list.push(row);
      else result.set(key, [row]);
    }
    return result;
  }

  // ---- modules and delegatecall --------------------------------------------

  async modules(vault: Address): Promise<string[]> {
    const rows = await this.client.select('wallet_modules', WalletModuleSchema, (q) =>
      q.select('*').eq('wallet_address', lower(vault)).eq('is_active', true),
    );
    return rows.map((r) => r.module_address);
  }

  async delegatecallTargets(vault: Address): Promise<string[]> {
    const rows = await this.client.select(
      'wallet_delegatecall_targets',
      DelegatecallTargetSchema,
      (q) => q.select('*').eq('wallet_address', lower(vault)).eq('is_active', true),
    );
    return rows.map((r) => r.target_address);
  }

  // ---- value movement ------------------------------------------------------

  async deposits(vault: Address, options: Pagination = {}): Promise<Page<DepositRow>> {
    const { limit, offset } = bounds(options);
    return this.client.selectPage('deposits', DepositSchema, limit, (q) =>
      q
        .select('*', { count: 'estimated' })
        .eq('wallet_address', lower(vault))
        .order('deposited_at_block', { ascending: false })
        .range(offset, offset + limit),
    );
  }

  async tokenTransfers(vault: Address, options: Pagination = {}): Promise<Page<TokenTransferRow>> {
    const { limit, offset } = bounds(options);
    return this.client.selectPage('token_transfers', TokenTransferSchema, limit, (q) =>
      q
        .select('*', { count: 'estimated' })
        .eq('wallet_address', lower(vault))
        .order('block_number', { ascending: false })
        .range(offset, offset + limit),
    );
  }

  /**
   * Scan up to `budget` of the most recent transfer rows, paging past {@link MAX_LIMIT}.
   *
   * `tokenTransfers` clamps a single request, so a caller asking for more than the cap
   * silently received a short page — and then computed "did I see everything?" from
   * that short page's `hasMore`, which reported truncation the caller had not actually
   * hit. Paging here keeps the caller's budget meaningful and makes the returned
   * `hasMore` mean what it says: rows exist beyond the budget that was scanned.
   *
   * Pages by offset over a descending order, so a transfer landing mid-scan can shift
   * rows by one. That is acceptable for token *discovery* — a duplicate collapses into
   * the same map key and a missed row costs at most one candidate that the next call
   * picks up. Do not reuse this for anything that must see each row exactly once.
   */
  async tokenTransferScan(vault: Address, budget: number): Promise<Page<TokenTransferRow>> {
    const target = Math.max(1, Math.floor(budget));
    const data: TokenTransferRow[] = [];
    let total = 0;
    let hasMore = false;

    while (data.length < target) {
      const page = await this.tokenTransfers(vault, {
        limit: Math.min(MAX_LIMIT, target - data.length),
        offset: data.length,
      });
      data.push(...page.data);
      total = page.total;
      hasMore = page.hasMore;
      // A short page means the table is exhausted, whatever `total` claims.
      if (page.data.length === 0 || !page.hasMore) break;
    }

    return { data, total, hasMore };
  }

  async tokens(addresses: string[]): Promise<TokenRow[]> {
    if (addresses.length === 0) return [];
    return this.client.select('tokens', TokenSchema, (q) =>
      q.select('*').in('address', addresses.map(lower)),
    );
  }

  async signedMessages(vault: Address): Promise<SignedMessageRow[]> {
    return this.client.select('signed_messages', SignedMessageSchema, (q) =>
      q.select('*').eq('wallet_address', lower(vault)).eq('is_active', true),
    );
  }

  // ---- social recovery -----------------------------------------------------

  async recoveryConfig(
    vault: Address,
  ): Promise<{ threshold: number; recoveryPeriod: number; guardians: string[] } | null> {
    const config = await this.client.selectOne('social_recovery_configs', RecoveryConfigSchema, (q) =>
      q.select('*').eq('wallet_address', lower(vault)).eq('is_active', true).single(),
    );
    if (!config) return null;

    const guardians = await this.client.select(
      'social_recovery_guardians',
      RecoveryGuardianSchema,
      (q) => q.select('*').eq('wallet_address', lower(vault)).eq('is_active', true),
    );

    return {
      threshold: config.threshold,
      recoveryPeriod: Number(config.recovery_period),
      guardians: guardians.map((g) => g.guardian_address),
    };
  }

  async pendingRecoveries(vault: Address): Promise<RecoveryRow[]> {
    return this.client.select('social_recoveries', RecoverySchema, (q) =>
      q.select('*').eq('wallet_address', lower(vault)).eq('status', 'pending'),
    );
  }

  async recoveryHistory(vault: Address, options: Pagination = {}): Promise<RecoveryRow[]> {
    const { limit, offset } = bounds(options);
    return this.client.select('social_recoveries', RecoverySchema, (q) =>
      q
        .select('*')
        .eq('wallet_address', lower(vault))
        .order('initiated_at_block', { ascending: false })
        .range(offset, offset + limit - 1),
    );
  }

  async recoveryApprovals(vault: Address, recoveryHash: string): Promise<RecoveryApprovalRow[]> {
    return this.client.select('social_recovery_approvals', RecoveryApprovalSchema, (q) =>
      q
        .select('*')
        .eq('wallet_address', lower(vault))
        .eq('recovery_hash', recoveryHash.toLowerCase())
        .eq('is_active', true),
    );
  }
}

/**
 * Pull the embedded rows out of a PostgREST join, dropping any that fail validation
 * rather than failing the whole query over one malformed row.
 */
function extractJoined<T>(
  data: unknown[] | null,
  schema: { parse: (value: unknown) => T },
): T[] {
  const out: T[] = [];
  for (const row of data ?? []) {
    const embedded = (row as { wallets?: unknown }).wallets;
    if (!embedded) continue;
    // PostgREST returns an object for a to-one join, an array for to-many.
    const candidates = Array.isArray(embedded) ? embedded : [embedded];
    for (const candidate of candidates) {
      try {
        out.push(schema.parse(candidate));
      } catch {
        continue;
      }
    }
  }
  return out;
}
