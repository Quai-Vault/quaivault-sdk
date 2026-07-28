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
const MAX_LIMIT = 200;

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

  async transactionHistory(
    vault: Address,
    options: Pagination & { status?: string[] } = {},
  ): Promise<Page<TransactionRow>> {
    const { limit, offset } = bounds(options);
    const statuses = options.status ?? ['executed', 'cancelled', 'expired', 'failed'];

    const { data, error, count } = await this.client
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('wallet_address', lower(vault))
      .in('status', statuses)
      .order('submitted_at_block', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new IndexerQueryError(`Indexer query failed: ${error.message}`, error);

    const rows = (data ?? []).map((r) => TransactionSchema.parse(r));
    const total = count ?? rows.length;
    return { data: rows, total, hasMore: offset + rows.length < total };
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
   * Active confirmations for many transactions in one round trip.
   *
   * "Active" here means not revoked. It does NOT mean the confirming address is
   * still an owner — the indexer does not deactivate confirmations when an owner is
   * removed, while the contract invalidates them via approval epochs. Callers must
   * intersect with the active owner set; `Vault` does this for you.
   */
  async activeConfirmationsBatch(
    vault: Address,
    txHashes: string[],
  ): Promise<Map<string, ConfirmationRow[]>> {
    const result = new Map<string, ConfirmationRow[]>();
    for (const hash of txHashes) result.set(hash.toLowerCase(), []);
    if (txHashes.length === 0) return result;

    const rows = await this.client.select('confirmations', ConfirmationSchema, (q) =>
      q
        .select('*')
        .eq('wallet_address', lower(vault))
        .in(
          'tx_hash',
          txHashes.map((h) => h.toLowerCase()),
        )
        .eq('is_active', true),
    );

    for (const row of rows) {
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
    const { data, error, count } = await this.client
      .from('deposits')
      .select('*', { count: 'exact' })
      .eq('wallet_address', lower(vault))
      .order('deposited_at_block', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new IndexerQueryError(`Indexer query failed: ${error.message}`, error);
    const rows = (data ?? []).map((r) => DepositSchema.parse(r));
    const total = count ?? rows.length;
    return { data: rows, total, hasMore: offset + rows.length < total };
  }

  async tokenTransfers(vault: Address, options: Pagination = {}): Promise<Page<TokenTransferRow>> {
    const { limit, offset } = bounds(options);
    const { data, error, count } = await this.client
      .from('token_transfers')
      .select('*', { count: 'exact' })
      .eq('wallet_address', lower(vault))
      .order('block_number', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new IndexerQueryError(`Indexer query failed: ${error.message}`, error);
    const rows = (data ?? []).map((r) => TokenTransferSchema.parse(r));
    const total = count ?? rows.length;
    return { data: rows, total, hasMore: offset + rows.length < total };
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
