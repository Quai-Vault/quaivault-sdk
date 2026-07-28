import { formatQuai, getAddress, getZoneForAddress, toShard } from 'quais';
import { assertQuaiAddress, assertQuaiAddresses } from './address.js';
import type { Connection } from './chain/connection.js';
import { VaultContract } from './chain/vault-contract.js';
import { RecoveryModule } from './recovery.js';
import { loadBalances, type BalanceOptions, type VaultBalances } from './balances.js';
import { watchVault, type Subscription, type WatchEvent, type WatchOptions } from './indexer/watch.js';
import { normalizeTxHash } from './chain/connection.js';
import type { IndexerClient } from './indexer/client.js';
import type { IndexerQueries } from './indexer/queries.js';
import type { TransactionRow } from './indexer/schemas.js';
import { toNumber } from './indexer/schemas.js';
import { decodeCall, type DecodedBatchCall } from './decode/index.js';
import { decodeRevert, decodeRevertFromError } from './errors/decode.js';
import {
  MAX_EXECUTION_DELAY,
  SENTINEL_MODULES,
  encodeMultiSend,
  minimumExpiration,
  selfCall,
  token as tokenEncode,
  recoveryCall,
  type BatchCall,
} from './encode/index.js';
import {
  AbortError,
  NoIndexerError,
  NotFoundError,
  PreconditionError,
  RevertError,
  StaleProposalError,
  ValidationError,
} from './errors/index.js';
import { DEFAULT_CONCURRENCY, mapPooled } from './pool.js';
import { computeAffordances } from './lifecycle/affordances.js';
import { classifyExecution, extractProposedTxHash, type ReceiptLike } from './lifecycle/outcome.js';
import { deriveStatus, executableAfterOf, nowSeconds } from './lifecycle/status.js';
import type {
  Address,
  Affordance,
  ApprovalRecord,
  Bytes32,
  ContractAddresses,
  Consistency,
  DryRunResult,
  ExecuteResult,
  Hex,
  Page,
  Pagination,
  ProposeOptions,
  ProposeResult,
  VaultInfo,
  VaultTransaction,
} from './types.js';

export interface VaultContext {
  connection: Connection;
  indexer: IndexerClient | null;
  queries: IndexerQueries | null;
  contracts: ContractAddresses;
  consistency: Consistency;
  maxIndexerLagBlocks: number;
  /** Set by {@link Vault.pinned}. Never consulted by a write precondition. */
  view?: VaultView;
}

/**
 * Owners and threshold, captured at one instant.
 *
 * The SDK deliberately holds no read cache: the owner set decides which approvals
 * count toward the threshold, and serving a stale one silently would reintroduce the
 * exact bug `buildTransaction` intersects confirmations to avoid. An implicit TTL
 * would make that failure invisible and intermittent.
 *
 * So the staleness window is the caller's to open, and to see. `capturedAt` is right
 * there in the object; a CLI rendering one screen can pin a view for that screen and
 * know precisely what it pinned.
 */
export interface VaultView {
  owners: Address[];
  threshold: number;
  /** Indexer head when this was taken; absent if the snapshot came from chain. */
  indexedAtBlock?: number;
  /** Unix seconds. How stale the snapshot is allowed to get is the caller's call. */
  capturedAt: number;
  source: 'indexer' | 'chain';
}

/** A handle to one deployed vault. Cheap to construct; performs no I/O until used. */
export class Vault {
  readonly address: Address;
  /** Guardian-based recovery for this vault. */
  readonly recovery: RecoveryModule;
  private readonly ctx: VaultContext;

  constructor(address: Address, ctx: VaultContext) {
    // A deployed vault is always a Quai-ledger contract in a real zone, so anything
    // else is a typo or a Qi address and would fail every call.
    this.address = assertQuaiAddress(address, 'vault address');
    this.ctx = ctx;
    this.recovery = new RecoveryModule({
      connection: ctx.connection,
      queries: ctx.queries,
      vaultAddress: this.address,
      moduleAddress: ctx.contracts.socialRecovery,
    });
  }

  // =========================================================================
  // Read resolution
  // =========================================================================

  /**
   * Whether an indexer read is acceptable right now.
   *
   * `auto` uses the indexer only while it is live and within the configured lag
   * budget, so a stalled indexer silently degrades to chain reads instead of
   * serving stale state.
   */
  private async useIndexer(): Promise<boolean> {
    if (this.ctx.consistency === 'chain') return false;
    if (!this.ctx.indexer || !this.ctx.queries) {
      if (this.ctx.consistency === 'indexed') throw new NoIndexerError('This read');
      return false;
    }
    if (this.ctx.consistency === 'indexed') return true;

    const health = await this.ctx.indexer.health();
    if (!health.available) return false;
    if (health.blocksBehind !== undefined && health.blocksBehind > this.ctx.maxIndexerLagBlocks) {
      return false;
    }
    return true;
  }

  private requireQueries(operation: string): IndexerQueries {
    if (!this.ctx.queries) throw new NoIndexerError(operation);
    return this.ctx.queries;
  }

  /**
   * The indexer's head, for stamping onto records read from it.
   *
   * Reads the cached health result rather than querying `indexer_state` directly.
   * `useIndexer()` has just called `health()` on this same code path and the result is
   * cached, so this is free — whereas a `state()` call is a second round trip per
   * hydration, paid on every indexed read purely to fill one advisory field.
   *
   * Undefined when the indexer is not answering: a head of 0 would read as "indexed at
   * genesis" rather than "unknown".
   */
  private async indexerHead(): Promise<number | undefined> {
    const health = await this.ctx.indexer?.health();
    return health?.available ? health.lastIndexedBlock : undefined;
  }

  private contract(write = false): VaultContract {
    return new VaultContract(this.ctx.connection.vault(this.address, write), this.ctx.connection.retry);
  }

  // =========================================================================
  // Vault state
  // =========================================================================

  /** Owners, threshold, timelock floor, nonce and balance. Always read from chain. */
  async info(): Promise<VaultInfo> {
    const vault = this.contract();
    const [owners, threshold, minExecutionDelay, nonce, moduleCount, balance] = await Promise.all([
      vault.getOwners(),
      vault.threshold(),
      vault.minExecutionDelay(),
      vault.nonce(),
      vault.moduleCount(),
      this.ctx.connection.provider.getBalance(this.address),
    ]);

    return {
      address: this.address,
      owners: Array.from(owners).map((o) => getAddress(String(o))),
      threshold: Number(threshold),
      minExecutionDelay: Number(minExecutionDelay),
      nonce: Number(nonce),
      moduleCount: Number(moduleCount),
      balance: BigInt(balance),
    };
  }

  /**
   * Capture owners and threshold once, for reuse across a burst of reads.
   *
   * Pair with {@link pinned}:
   *
   * ```ts
   * const view = await vault.view();
   * const pinned = vault.pinned(view);
   * // every read below shares one owner/threshold read
   * const txs = await pinned.transactions(hashes);
   * ```
   */
  async view(): Promise<VaultView> {
    const fromIndexer = await this.useIndexer();
    const [owners, threshold, indexedAtBlock] = await Promise.all([
      this.owners(),
      this.threshold(),
      this.indexerHead(),
    ]);
    return {
      owners,
      threshold,
      ...(indexedAtBlock !== undefined ? { indexedAtBlock } : {}),
      capturedAt: nowSeconds(),
      source: fromIndexer ? 'indexer' : 'chain',
    };
  }

  /**
   * A handle that answers {@link owners} and {@link threshold} from `view` instead of
   * re-reading them.
   *
   * Reads only. Write preconditions go through `chainOwners` / `chainThreshold`, which
   * bypass the snapshot by construction — pinning a view can never cause this SDK to
   * sign against a stale owner set. Everything else about the handle, including the
   * connection and the recovery module, is shared with the original.
   */
  pinned(view: VaultView): Vault {
    return new Vault(this.address, { ...this.ctx, view });
  }

  /** Active owners. Prefers a pinned view, then the indexer, then chain. */
  async owners(): Promise<Address[]> {
    if (this.ctx.view) return this.ctx.view.owners;
    if (await this.useIndexer()) {
      try {
        const owners = await this.requireQueries('owners').owners(this.address);
        if (owners.length > 0) return owners.map((o) => getAddress(o));
      } catch {
        // fall through to chain
      }
    }
    return this.chainOwners();
  }

  /**
   * Owners straight from the chain, bypassing the indexer entirely.
   *
   * {@link owners} prefers the indexer, which is right for display and wrong for
   * anything that gates a write. A lagging indexer would let the SDK build a proposal
   * against an owner set that no longer exists — admitting a `removeOwner` that drops
   * the vault below its threshold, or rejecting one that is perfectly valid. Every
   * propose-time precondition reads through here instead.
   */
  private async chainOwners(): Promise<Address[]> {
    return (await this.contract().getOwners()).map((o) => getAddress(String(o)));
  }

  async isOwner(address: Address): Promise<boolean> {
    return this.contract().isOwner(getAddress(address));
  }

  /** Approvals required to execute. Prefers a pinned view, then the indexer, then chain. */
  async threshold(): Promise<number> {
    if (this.ctx.view) return this.ctx.view.threshold;
    if (await this.useIndexer()) {
      try {
        const wallet = await this.requireQueries('threshold').wallet(this.address);
        if (wallet) return wallet.threshold;
      } catch {
        // fall through to chain
      }
    }
    return this.chainThreshold();
  }

  /**
   * Threshold straight from the chain. The write-path counterpart to {@link threshold},
   * for the same reason {@link chainOwners} exists.
   */
  private async chainThreshold(): Promise<number> {
    return Number(await this.contract().threshold());
  }

  async balance(): Promise<bigint> {
    return BigInt(await this.ctx.connection.provider.getBalance(this.address));
  }

  /**
   * Enabled modules, in linked-list order.
   *
   * Order matters: `disableModule` needs each module's predecessor, so this always
   * reads the chain rather than the indexer (which stores an unordered set).
   */
  async modules(): Promise<Address[]> {
    return (await this.contract().getModules()).map((m) => getAddress(String(m)));
  }

  async isModuleEnabled(module: Address): Promise<boolean> {
    return this.contract().isModuleEnabled(getAddress(module));
  }

  /** Addresses permitted as DelegateCall targets. Empty means DelegateCall is disabled. */
  async delegatecallTargets(): Promise<Address[]> {
    // Indexer-only, with no fallback and no retry-on-failure: `delegatecallAllowed`
    // is a mapping, so the chain cannot enumerate it. A failure here is terminal, and
    // swallowing it only to reissue the identical query would double the load and
    // surface a more confusing second error. Use `isDelegatecallAllowed(target)` to
    // check a specific address against the chain.
    const targets = await this.requireQueries('Listing DelegateCall targets').delegatecallTargets(
      this.address,
    );
    return targets.map((t) => getAddress(t));
  }

  async isDelegatecallAllowed(target: Address): Promise<boolean> {
    return this.contract().delegatecallAllowed(getAddress(target));
  }

  /** Whether a hash has been pre-approved for EIP-1271 validation. */
  async isValidSignature(hash: Bytes32): Promise<boolean> {
    const magic = await this.contract().isValidSignature(normalizeTxHash(hash, 'hash'), '0x');
    return magic.toLowerCase() === '0x1626ba7e';
  }

  // =========================================================================
  // Transactions
  // =========================================================================

  /** The vault-transaction hash for a given call, at a given nonce. */
  async transactionHash(
    to: Address,
    value: bigint,
    data: Hex,
    nonce?: number,
  ): Promise<Bytes32> {
    const vault = this.contract();
    const n = nonce ?? Number(await vault.nonce());
    return vault.getTransactionHash(getAddress(to), value, data, n);
  }

  async transaction(txHash: Bytes32): Promise<VaultTransaction> {
    const hash = normalizeTxHash(txHash);

    if (await this.useIndexer()) {
      try {
        const tx = await this.fromIndexer(hash);
        if (tx) return tx;
      } catch {
        // fall through to chain
      }
    }
    return this.fromChain(hash);
  }

  /**
   * Several transactions at once, keyed by hash.
   *
   * The plural form exists because the singular one is expensive to loop: each
   * `transaction()` re-reads the owner set, the threshold and the indexer head, so
   * fetching fifty costs fifty times that. This resolves the whole set the way the
   * listing methods already do — one query for the rows, one owner/threshold read
   * shared across them, one batched confirmations query.
   *
   * Hashes the indexer does not have fall back to chain reads, bounded by a pool.
   * Hashes that exist nowhere are simply absent from the map rather than throwing:
   * one unknown hash should not lose the caller the other forty-nine.
   */
  async transactions(txHashes: Bytes32[]): Promise<Map<Bytes32, VaultTransaction>> {
    const hashes = [...new Set(txHashes.map((h) => normalizeTxHash(h)))];
    const found = new Map<Bytes32, VaultTransaction>();
    if (hashes.length === 0) return found;

    if (await this.useIndexer()) {
      try {
        const queries = this.requireQueries('Reading transactions');
        const [rows, owners, threshold] = await Promise.all([
          queries.transactionsByHash(this.address, hashes),
          this.owners(),
          this.threshold(),
        ]);
        for (const tx of await this.hydrateRows(rows, owners, threshold)) {
          found.set(tx.hash.toLowerCase(), tx);
        }
      } catch {
        // fall through — every hash is resolved from chain below
      }
    }

    const missing = hashes.filter((hash) => !found.has(hash));
    if (missing.length > 0) {
      const resolved = await mapPooled(missing, DEFAULT_CONCURRENCY, async (hash) => {
        try {
          return await this.fromChain(hash);
        } catch (err) {
          // A hash that exists on neither side is a miss, not a failure. Anything
          // else — an RPC outage, a malformed response — is the caller's to see.
          if (err instanceof NotFoundError) return null;
          throw err;
        }
      });
      for (const tx of resolved) {
        if (tx) found.set(tx.hash.toLowerCase(), tx);
      }
    }

    return found;
  }

  async pendingTransactions(options: Pagination = {}): Promise<VaultTransaction[]> {
    const queries = this.requireQueries('Listing pending transactions');
    const [rows, owners, threshold] = await Promise.all([
      queries.pendingTransactions(this.address, options),
      this.owners(),
      this.threshold(),
    ]);
    return this.hydrateRows(rows, owners, threshold);
  }

  async transactionHistory(
    options: Pagination & { status?: string[] } = {},
  ): Promise<Page<VaultTransaction>> {
    const queries = this.requireQueries('Listing transaction history');
    const [page, owners, threshold] = await Promise.all([
      queries.transactionHistory(this.address, options),
      this.owners(),
      this.threshold(),
    ]);
    return {
      data: await this.hydrateRows(page.data, owners, threshold),
      total: page.total,
      hasMore: page.hasMore,
    };
  }

  // ---- hydration -----------------------------------------------------------

  private async hydrateRows(
    rows: TransactionRow[],
    owners: Address[],
    threshold: number,
  ): Promise<VaultTransaction[]> {
    if (rows.length === 0) return [];
    const queries = this.requireQueries('Loading confirmations');
    const confirmations = await queries.activeConfirmationsBatch(
      this.address,
      rows.map((r) => r.tx_hash),
    );
    const indexedAtBlock = await this.indexerHead();

    return rows.map((row) => {
      const confirmed = (confirmations.get(row.tx_hash.toLowerCase()) ?? []).map(
        (c) => c.owner_address,
      );
      return this.buildTransaction({
        row,
        confirmedBy: confirmed,
        owners,
        threshold,
        indexedAtBlock,
      });
    });
  }

  private async fromIndexer(hash: Bytes32): Promise<VaultTransaction | null> {
    const queries = this.requireQueries('Reading a transaction');
    const [row, owners, threshold] = await Promise.all([
      queries.transaction(this.address, hash),
      this.owners(),
      this.threshold(),
    ]);
    if (!row) return null;

    const confirmations = await queries.confirmations(this.address, hash);
    const indexedAtBlock = await this.indexerHead();

    return this.buildTransaction({
      row,
      confirmedBy: confirmations.filter((c) => c.is_active).map((c) => c.owner_address),
      owners,
      threshold,
      indexedAtBlock,
    });
  }

  /**
   * Build a `VaultTransaction` from an indexed row.
   *
   * Approval counting intersects the indexer's confirmations with the current owner
   * set. The indexer marks a confirmation inactive only on an explicit
   * `ApprovalRevoked`; it does not react to `OwnerRemoved`. On chain, removing an
   * owner bumps `ownerVersions` and invalidates every approval that address made, so
   * the stored `confirmation_count` over-reports after any removal. Intersecting here
   * reproduces the contract's `_countValidApprovals`.
   */
  private buildTransaction(input: {
    row: TransactionRow;
    confirmedBy: string[];
    owners: Address[];
    threshold: number;
    indexedAtBlock?: number;
  }): VaultTransaction {
    const { row, owners, threshold, indexedAtBlock } = input;
    const ownerSet = new Set(owners.map((o) => o.toLowerCase()));
    const confirmedSet = new Set(input.confirmedBy.map((c) => c.toLowerCase()));

    const approvals: ApprovalRecord[] = owners
      .filter((o) => confirmedSet.has(o.toLowerCase()))
      .map((o) => ({ owner: o, active: true }));

    // Confirmations from addresses that are no longer owners: surfaced but not counted.
    for (const confirmed of confirmedSet) {
      if (!ownerSet.has(confirmed)) {
        approvals.push({ owner: getAddress(confirmed), active: false });
      }
    }

    const approvalCount = approvals.filter((a) => a.active).length;
    const value = BigInt(row.value);
    const data = (row.data ?? '0x') as Hex;
    const to = getAddress(row.to_address);

    const decodeResult = decodeCall({
      vault: this.address,
      to,
      value,
      data,
      socialRecovery: this.ctx.contracts.socialRecovery,
      multiSendCallOnly: this.ctx.contracts.multiSendCallOnly,
    });

    const expiration = toNumber(row.expiration);
    const executionDelay = toNumber(row.execution_delay);
    const approvedAt = toNumber(row.approved_at);

    const status = deriveStatus({
      executed: row.status === 'executed' || row.status === 'failed',
      cancelled: row.status === 'cancelled' || row.status === 'expired',
      isExpired: row.is_expired ?? row.status === 'expired',
      expiration,
      executionDelay,
      approvedAt,
      approvalCount,
      threshold,
      failed: row.status === 'failed',
    });

    const failedReturnData = row.failed_return_data ?? undefined;

    return {
      hash: row.tx_hash,
      vault: this.address,
      to,
      value,
      data,
      proposer: getAddress(row.submitted_by),
      // The indexer records the block, not the chain timestamp — they are not
      // interchangeable, and reporting a block number as `proposedAt` renders as 1970.
      proposedAt: 0,
      proposedAtBlock: toNumber(row.submitted_at_block),
      kind: decodeResult.kind,
      decoded: decodeResult.decoded,
      summary: decodeResult.summary,
      status,
      approvals,
      approvalCount,
      threshold,
      expiration,
      executionDelay,
      approvedAt,
      executableAfter: executableAfterOf(approvedAt, executionDelay),
      failedReturnData: failedReturnData as Hex | undefined,
      decodedRevert: failedReturnData ? decodeRevert(failedReturnData) : undefined,
      source: 'indexer',
      indexedAtBlock,
    };
  }

  /** Authoritative read: the struct plus a `hasApproved` probe per current owner. */
  private async fromChain(hash: Bytes32): Promise<VaultTransaction> {
    const vault = this.contract();
    const [raw, owners, threshold, isExpired] = await Promise.all([
      vault.transactions(hash),
      vault.getOwners(),
      vault.threshold(),
      vault.expiredTxs(hash),
    ]);

    const to = String(raw.to);
    if (!to || to === '0x0000000000000000000000000000000000000000') {
      throw new NotFoundError(`No transaction ${hash} on vault ${this.address}.`);
    }

    const ownerList = owners.map((o) => getAddress(String(o)));
    const approvalFlags = await Promise.all(
      ownerList.map((owner) => vault.hasApproved(hash, owner)),
    );
    const approvals: ApprovalRecord[] = ownerList
      .map((owner, i) => ({ owner, active: approvalFlags[i] === true }))
      .filter((a) => a.active);

    const value = BigInt(raw.value ?? 0);
    const data = String(raw.data ?? '0x') as Hex;
    const expiration = Number(raw.expiration ?? 0);
    const executionDelay = Number(raw.executionDelay ?? 0);
    const approvedAt = Number(raw.approvedAt ?? 0);
    const executed = Boolean(raw.executed);
    const cancelled = Boolean(raw.cancelled);

    const decodeResult = decodeCall({
      vault: this.address,
      to: getAddress(to),
      value,
      data,
      socialRecovery: this.ctx.contracts.socialRecovery,
      multiSendCallOnly: this.ctx.contracts.multiSendCallOnly,
    });

    return {
      hash,
      vault: this.address,
      to: getAddress(to),
      value,
      data,
      proposer: getAddress(String(raw.proposer)),
      proposedAt: Number(raw.timestamp ?? 0),
      kind: decodeResult.kind,
      decoded: decodeResult.decoded,
      summary: decodeResult.summary,
      status: deriveStatus({
        executed,
        cancelled,
        isExpired,
        expiration,
        executionDelay,
        approvedAt,
        approvalCount: approvals.length,
        threshold: Number(threshold),
      }),
      approvals,
      approvalCount: approvals.length,
      threshold: Number(threshold),
      expiration,
      executionDelay,
      approvedAt,
      executableAfter: executableAfterOf(approvedAt, executionDelay),
      source: 'chain',
    };
  }

  // =========================================================================
  // Affordances
  // =========================================================================

  /**
   * What `caller` may legally do to `txHash` right now, and when blocked actions
   * become available. Defaults to the connected signer's address.
   */
  async affordances(txHash: Bytes32, caller?: Address): Promise<Affordance[]> {
    const hash = normalizeTxHash(txHash);
    return this.resolveAffordances(hash, this.transaction(hash), caller);
  }

  /**
   * Shared body of {@link affordances}, taking the transaction either as a value or as
   * an in-flight promise.
   *
   * The promise form is the point: a caller that already holds the record (like
   * {@link describe}) passes it and skips a redundant fetch, while `affordances()`
   * passes the unawaited promise so the transaction read still overlaps the two
   * ownership probes rather than serialising behind them.
   */
  private async resolveAffordances(
    hash: Bytes32,
    transaction: VaultTransaction | Promise<VaultTransaction>,
    caller?: Address,
  ): Promise<Affordance[]> {
    const who = caller ?? (await this.ctx.connection.addressOrNull());
    if (!who) {
      throw new ValidationError(
        'affordances() needs a caller address when the client has no signer.',
      );
    }

    const vault = this.contract();
    const [tx, isOwner, hasApproved] = await Promise.all([
      transaction,
      vault.isOwner(getAddress(who)),
      vault.hasApproved(hash, getAddress(who)),
    ]);

    return computeAffordances({ tx, caller: getAddress(who), isOwner, hasApproved });
  }

  // =========================================================================
  // Proposals
  // =========================================================================

  /**
   * Proposal builders.
   *
   * Every method here is async, including the ones whose work is purely local. Mixing
   * synchronous throws with rejected promises is a footgun: `propose.addOwner(bad)`
   * would throw before `.catch()` could attach. Validation failures are always
   * rejections.
   */
  readonly propose = {
    /** Propose an arbitrary call. Every other `propose.*` helper routes through this. */
    call: async (
      params: { to: Address; value?: bigint; data?: Hex } & ProposeOptions,
    ): Promise<ProposeResult | DryRunResult> =>
      this.proposeCall({
        to: assertQuaiAddress(params.to, 'target'),
        value: params.value,
        data: params.data,
        ...proposeOptionsOf(params),
      }),

    /** Send native QUAI. */
    transfer: async (
      params: { to: Address; amount: bigint } & ProposeOptions,
    ): Promise<ProposeResult | DryRunResult> =>
      this.proposeCall({
        // Native value sent to a Qi address leaves the Quai ledger and is unrecoverable.
        to: assertQuaiAddress(params.to, 'recipient'),
        value: params.amount,
        data: '0x',
        ...proposeOptionsOf(params),
      }),

    erc20Transfer: async (
      params: { token: Address; to: Address; amount: bigint } & ProposeOptions,
    ): Promise<ProposeResult | DryRunResult> =>
      this.proposeCall({
        to: assertQuaiAddress(params.token, 'token'),
        value: 0n,
        data: tokenEncode.erc20Transfer(assertQuaiAddress(params.to, 'recipient'), params.amount),
        ...proposeOptionsOf(params),
      }),

    erc721Transfer: async (
      params: { token: Address; to: Address; tokenId: bigint } & ProposeOptions,
    ): Promise<ProposeResult | DryRunResult> =>
      this.proposeCall({
        to: assertQuaiAddress(params.token, 'token'),
        value: 0n,
        data: tokenEncode.erc721Transfer(
          this.address,
          assertQuaiAddress(params.to, 'recipient'),
          params.tokenId,
        ),
        ...proposeOptionsOf(params),
      }),

    erc1155Transfer: async (
      params: {
        token: Address;
        to: Address;
        id: bigint;
        amount: bigint;
        data?: Hex;
      } & ProposeOptions,
    ): Promise<ProposeResult | DryRunResult> =>
      this.proposeCall({
        to: assertQuaiAddress(params.token, 'token'),
        value: 0n,
        data: tokenEncode.erc1155Transfer(
          this.address,
          assertQuaiAddress(params.to, 'recipient'),
          params.id,
          params.amount,
          params.data ?? '0x',
        ),
        ...proposeOptionsOf(params),
      }),

    /**
     * Batch several calls through MultiSendCallOnly.
     *
     * Requires MultiSendCallOnly to be on this vault's DelegateCall whitelist, which
     * is empty by default. The precondition is checked before signing so the failure
     * names the missing `addDelegatecallTarget` proposal instead of reverting.
     */
    batch: async (
      calls: BatchCall[],
      options: ProposeOptions = {},
    ): Promise<ProposeResult | DryRunResult> => {
      const multiSend = this.ctx.contracts.multiSendCallOnly;
      if (!multiSend) {
        throw new ValidationError(
          'No MultiSendCallOnly address is configured for this network.',
          'Set QUAIVAULT_MULTISEND_CALL_ONLY or pass contracts.multiSendCallOnly.',
        );
      }
      if (!(await this.isDelegatecallAllowed(multiSend))) {
        throw new PreconditionError(
          `MultiSendCallOnly (${multiSend}) is not on this vault's DelegateCall whitelist, so a ` +
            'batched call cannot execute.',
          {
            remediation:
              `Propose and execute addDelegatecallTarget(${multiSend}) first — it requires full ` +
              'owner consensus, by design.',
          },
        );
      }
      calls.forEach((call, i) => assertQuaiAddress(call.to, `calls[${i}].to`));
      return this.proposeCall({
        to: multiSend,
        value: 0n,
        data: encodeMultiSend(calls),
        ...proposeOptionsOf(options),
      });
    },

    // --- self-calls -------------------------------------------------------

    addOwner: async (owner: Address, options: ProposeOptions = {}) =>
      this.proposeSelfCall(selfCall.addOwner(assertQuaiAddress(owner, 'owner')), options),

    removeOwner: async (owner: Address, options: ProposeOptions = {}) => {
      // Chain reads, not `owners()`: this gates a signature. See `chainOwners`.
      const [owners, threshold] = await Promise.all([this.chainOwners(), this.chainThreshold()]);
      if (!owners.some((o) => o.toLowerCase() === owner.toLowerCase())) {
        throw new PreconditionError(`${owner} is not an owner of this vault.`);
      }
      if (owners.length - 1 < threshold) {
        throw new PreconditionError(
          `Removing an owner would leave ${owners.length - 1} owners, below the threshold of ${threshold}.`,
          { remediation: 'Lower the threshold first, in a separate proposal.' },
        );
      }
      return this.proposeSelfCall(selfCall.removeOwner(getAddress(owner)), options);
    },

    changeThreshold: async (threshold: number, options: ProposeOptions = {}) => {
      // Chain read, not `owners()`: this gates a signature. See `chainOwners`.
      const owners = await this.chainOwners();
      if (threshold < 1 || threshold > owners.length) {
        throw new ValidationError(
          `Invalid threshold ${threshold}: this vault has ${owners.length} owners.`,
        );
      }
      return this.proposeSelfCall(selfCall.changeThreshold(threshold), options);
    },

    setMinExecutionDelay: async (seconds: number, options: ProposeOptions = {}) =>
      this.proposeSelfCall(selfCall.setMinExecutionDelay(seconds), options),

    enableModule: async (module: Address, options: ProposeOptions = {}) =>
      this.proposeSelfCall(selfCall.enableModule(assertQuaiAddress(module, 'module')), options),

    /**
     * Disable a module, resolving its predecessor in the Zodiac linked list.
     *
     * The predecessor is baked into the proposal, so any module added or removed
     * before this executes invalidates it. `execute` re-checks and raises
     * `StaleProposalError` rather than letting it revert on chain.
     */
    disableModule: async (module: Address, options: ProposeOptions = {}) => {
      const prev = await this.previousModule(getAddress(module));
      return this.proposeSelfCall(selfCall.disableModule(prev, getAddress(module)), options);
    },

    addDelegatecallTarget: async (target: Address, options: ProposeOptions = {}) =>
      this.proposeSelfCall(
        selfCall.addDelegatecallTarget(assertQuaiAddress(target, 'delegatecall target')),
        options,
      ),

    removeDelegatecallTarget: async (target: Address, options: ProposeOptions = {}) =>
      this.proposeSelfCall(selfCall.removeDelegatecallTarget(getAddress(target)), options),

    /** Cancel a transaction that has already reached quorum. Needs full consensus. */
    cancelByConsensus: async (txHash: Bytes32, options: ProposeOptions = {}) =>
      this.proposeSelfCall(selfCall.cancelByConsensus(normalizeTxHash(txHash)), options),

    /** Sign arbitrary bytes. For EIP-1271 hash approval use `approveHashForEip1271`. */
    signMessage: async (message: Hex, options: ProposeOptions = {}) =>
      this.proposeSelfCall(selfCall.signMessage(message), options),

    unsignMessage: async (message: Hex, options: ProposeOptions = {}) =>
      this.proposeSelfCall(selfCall.unsignMessage(message), options),

    /**
     * Make `isValidSignature(hash, …)` return the EIP-1271 magic value.
     *
     * Enforces the 32-byte precondition: signing an arbitrary-length message `M`
     * does not make `isValidSignature(keccak256(M))` validate, because EIP-1271
     * hashes the dataHash itself, not `M`.
     */
    approveHashForEip1271: async (hash: Bytes32, options: ProposeOptions = {}) =>
      this.proposeSelfCall(selfCall.approveHashForEip1271(normalizeTxHash(hash, 'hash')), options),

    revokeHashForEip1271: async (hash: Bytes32, options: ProposeOptions = {}) =>
      this.proposeSelfCall(selfCall.revokeHashForEip1271(normalizeTxHash(hash, 'hash')), options),

    /** Configure social recovery. A call to the module, not a self-call. */
    setupRecovery: async (
      params: { guardians: Address[]; threshold: number; recoveryPeriodSeconds: number } & ProposeOptions,
    ) => {
      const module = this.ctx.contracts.socialRecovery;
      if (!module) {
        throw new ValidationError(
          'No SocialRecoveryModule address is configured for this network.',
          'Set QUAIVAULT_SOCIAL_RECOVERY_MODULE or pass contracts.socialRecovery.',
        );
      }
      return this.proposeCall({
        to: module,
        value: 0n,
        data: recoveryCall.setupRecovery(
          this.address,
          // A Qi guardian could never approve a recovery.
          assertQuaiAddresses(params.guardians, 'guardians'),
          params.threshold,
          params.recoveryPeriodSeconds,
        ),
        ...proposeOptionsOf(params),
      });
    },
  };

  /** Predecessor of `module` in the Zodiac linked list, for `disableModule`. */
  async previousModule(module: Address): Promise<Address> {
    const modules = await this.modules();
    const index = modules.findIndex((m) => m.toLowerCase() === module.toLowerCase());
    if (index === -1) {
      throw new PreconditionError(`Module ${module} is not enabled on this vault.`);
    }
    // Safe: `index === -1` already threw, and the ternary excludes 0, so index >= 1.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return index === 0 ? SENTINEL_MODULES : modules[index - 1]!;
  }

  private proposeSelfCall(data: Hex, options: ProposeOptions) {
    // Self-calls always execute immediately: the contract forces executionDelay to 0
    // and rejects any value. Passing a delay would be silently ignored, so reject it.
    if (options.executionDelay) {
      throw new ValidationError(
        'Self-calls always execute immediately — the vault forces executionDelay to 0 for them.',
      );
    }
    return this.proposeCall({
      to: this.address,
      value: 0n,
      data,
      ...proposeOptionsOf(options),
    });
  }

  private async proposeCall(params: {
    to: Address;
    value?: bigint;
    data?: Hex;
    expiration?: number;
    executionDelay?: number;
    dryRun?: boolean;
  }): Promise<ProposeResult | DryRunResult> {
    const to = getAddress(params.to);
    const value = params.value ?? 0n;
    const data = params.data ?? '0x';

    if (data !== '0x' && !/^0x([0-9a-fA-F]{2})*$/.test(data)) {
      throw new ValidationError('Transaction data must be 0x-prefixed hex with an even length.');
    }

    const isSelfCall = to.toLowerCase() === this.address.toLowerCase();
    if (isSelfCall && value > 0n) {
      throw new ValidationError(
        'Self-calls cannot carry value — the vault rejects them at proposal time.',
      );
    }

    const expiration = params.expiration ?? 0;
    const executionDelay = params.executionDelay ?? 0;

    if (executionDelay > MAX_EXECUTION_DELAY) {
      throw new ValidationError(
        `executionDelay ${executionDelay}s exceeds the 30-day maximum (${MAX_EXECUTION_DELAY}s).`,
      );
    }

    // Reproduce the contract's ExpirationTooSoon check before signing.
    if (expiration > 0) {
      const floor = isSelfCall ? 0 : Math.max(executionDelay, await this.minExecutionDelay());
      const earliest = minimumExpiration(floor, 0);
      if (expiration <= earliest) {
        throw new ValidationError(
          `expiration ${expiration} is too soon: with an effective delay of ${floor}s the vault ` +
            `requires an expiration after ${earliest}.`,
          `Use at least ${minimumExpiration(floor)} to leave a margin for block time.`,
        );
      }
    }

    // Explicit overload signatures — quais cannot disambiguate the three
    // proposeTransaction overloads from argument counts alone.
    const useFullOverload = params.expiration != null || params.executionDelay != null;

    if (params.dryRun) {
      const readVault = this.contract();
      const encoded = useFullOverload
        ? readVault.encode('proposeTransaction(address,uint256,bytes,uint48,uint32)', [
            to,
            value,
            data,
            expiration,
            executionDelay,
          ])
        : readVault.encode('proposeTransaction(address,uint256,bytes)', [to, value, data]);

      let gasEstimate: bigint | null = null;
      let wouldRevert;
      const from = await this.ctx.connection.addressOrNull();
      // Quai requires `from` on a transaction request (it selects the shard), and it
      // matters semantically too: the vault's onlyOwner check makes estimation revert
      // for a non-owner, which is exactly the signal a dry run should surface. Without
      // a signer there is nothing to estimate against, so the estimate stays null.
      if (from) {
        try {
          gasEstimate = BigInt(
            await this.ctx.connection.provider.estimateGas({
              to: this.address,
              data: encoded,
              from,
            }),
          );
        } catch (err) {
          wouldRevert = decodeRevertFromError(err);
        }
      }
      const decoded = decodeCall({
        vault: this.address,
        to,
        value,
        data,
        socialRecovery: this.ctx.contracts.socialRecovery,
        multiSendCallOnly: this.ctx.contracts.multiSendCallOnly,
      });
      return {
        dryRun: true,
        to: this.address,
        data: encoded,
        value: 0n,
        gasEstimate,
        wouldRevert,
        description: `Propose: ${decoded.summary}`,
      };
    }

    await this.assertCallerIsOwner('Proposing a transaction');

    const writeVault = this.contract(true);
    let receipt: ReceiptLike;
    try {
      const sent = useFullOverload
        ? await writeVault.proposeTransactionFull(to, value, data, expiration, executionDelay)
        : await writeVault.proposeTransactionSimple(to, value, data);
      receipt = (await sent.wait()) as ReceiptLike;
    } catch (err) {
      throw toRevertError(err, 'Transaction proposal failed');
    }

    assertReceipt(receipt, 'Proposal', 'The proposal transaction reverted.');

    const txHash = extractProposedTxHash(receipt, this.address);
    if (!txHash) {
      throw new RevertError(
        'The proposal was mined but no TransactionProposed event was found. ' +
          'Check that the vault address is correct.',
      );
    }

    return {
      txHash,
      chainTxHash: (receipt.hash ?? receipt.transactionHash ?? '') as Hex,
      to,
      value,
      data,
    };
  }

  private async minExecutionDelay(): Promise<number> {
    return Number(await this.contract().minExecutionDelay());
  }

  // =========================================================================
  // Lifecycle writes
  // =========================================================================

  async approve(txHash: Bytes32): Promise<{ chainTxHash: Hex }> {
    const hash = normalizeTxHash(txHash);
    const caller = await this.assertCallerIsOwner('Approving a transaction');

    const vault = this.contract(true);
    if (await vault.hasApproved(hash, caller)) {
      throw new PreconditionError('You have already approved this transaction.');
    }

    try {
      const sent = await vault.approveTransaction(hash);
      const receipt = (await sent.wait()) as ReceiptLike;
      assertReceipt(receipt, 'Approval', 'The approval transaction reverted.');
      return { chainTxHash: (receipt.hash ?? receipt.transactionHash ?? '') as Hex };
    } catch (err) {
      throw toRevertError(err, 'Approval failed');
    }
  }

  async revokeApproval(txHash: Bytes32): Promise<{ chainTxHash: Hex }> {
    const hash = normalizeTxHash(txHash);
    const caller = await this.assertCallerIsOwner('Revoking an approval');

    const vault = this.contract(true);
    if (!(await vault.hasApproved(hash, caller))) {
      throw new PreconditionError('You have no active approval on this transaction to revoke.');
    }

    try {
      const sent = await vault.revokeApproval(hash);
      const receipt = (await sent.wait()) as ReceiptLike;
      assertReceipt(receipt, 'Revocation', 'The revocation transaction reverted.');
      return { chainTxHash: (receipt.hash ?? receipt.transactionHash ?? '') as Hex };
    } catch (err) {
      throw toRevertError(err, 'Revoking the approval failed');
    }
  }

  /**
   * Execute a transaction that has reached quorum.
   *
   * The returned {@link ExecuteResult} says what actually happened. A successful
   * receipt does not imply execution — see {@link classifyExecution}.
   */
  async execute(txHash: Bytes32): Promise<ExecuteResult> {
    const hash = normalizeTxHash(txHash);
    await this.assertCallerIsOwner('Executing a transaction');
    await this.assertExecutable(hash);

    const vault = this.contract(true);
    try {
      const sent = await vault.executeTransaction(hash);
      const receipt = (await sent.wait()) as ReceiptLike;
      assertReceipt(receipt, 'Execution', 'The execution transaction reverted.');
      return classifyExecution(receipt, this.address, hash);
    } catch (err) {
      throw toRevertError(err, 'Execution failed');
    }
  }

  /** Approve and, if that meets quorum and the timelock allows, execute in one call. */
  async approveAndExecute(txHash: Bytes32): Promise<ExecuteResult> {
    const hash = normalizeTxHash(txHash);
    const caller = await this.assertCallerIsOwner('Approving and executing');

    const vault = this.contract(true);
    if (await vault.hasApproved(hash, caller)) {
      throw new PreconditionError('You have already approved this transaction.', {
        remediation: 'Use execute() instead.',
      });
    }

    try {
      const sent = await vault.approveAndExecute(hash);
      const receipt = (await sent.wait()) as ReceiptLike;
      assertReceipt(receipt, 'Approve-and-execute', 'The transaction reverted.');
      return classifyExecution(receipt, this.address, hash);
    } catch (err) {
      throw toRevertError(err, 'Approve-and-execute failed');
    }
  }

  /** Cancel a transaction you proposed, before it ever reaches quorum. */
  async cancel(txHash: Bytes32): Promise<{ chainTxHash: Hex }> {
    const hash = normalizeTxHash(txHash);
    const caller = await this.assertCallerIsOwner('Cancelling a transaction');
    const tx = await this.fromChain(hash);

    if (tx.proposer.toLowerCase() !== caller.toLowerCase()) {
      throw new PreconditionError('Only the proposer can cancel a transaction directly.', {
        remediation: 'Propose a cancelByConsensus self-call instead.',
      });
    }
    if (tx.approvedAt !== 0) {
      throw new PreconditionError(
        'This transaction reached quorum, which permanently blocks proposer-cancel.',
        { remediation: 'Use propose.cancelByConsensus() instead.' },
      );
    }

    try {
      const sent = await this.contract(true).cancelTransaction(hash);
      const receipt = (await sent.wait()) as ReceiptLike;
      assertReceipt(receipt, 'Cancellation', 'The cancellation reverted.');
      return { chainTxHash: (receipt.hash ?? receipt.transactionHash ?? '') as Hex };
    } catch (err) {
      throw toRevertError(err, 'Cancellation failed');
    }
  }

  /** Close out an expired transaction. Permissionless — no ownership required. */
  async expire(txHash: Bytes32): Promise<{ chainTxHash: Hex }> {
    const hash = normalizeTxHash(txHash);
    try {
      const sent = await this.contract(true).expireTransaction(hash);
      const receipt = (await sent.wait()) as ReceiptLike;
      assertReceipt(receipt, 'Expiry', 'The expiry transaction reverted.');
      return { chainTxHash: (receipt.hash ?? receipt.transactionHash ?? '') as Hex };
    } catch (err) {
      throw toRevertError(err, 'Expiring the transaction failed');
    }
  }

  // =========================================================================
  // Preconditions
  // =========================================================================

  private async assertCallerIsOwner(operation: string): Promise<Address> {
    const caller = await this.ctx.connection.address();
    const isOwner = await this.contract().isOwner(caller);
    if (!isOwner) {
      throw new PreconditionError(`${operation} requires an owner. ${caller} is not one.`);
    }
    return getAddress(caller);
  }

  /**
   * Re-validate on chain immediately before signing an execute.
   *
   * Reads always go through the chain here, never the indexer: indexed approval
   * counts can over-report after an owner removal, and a stale count must never gate
   * a signature.
   */
  private async assertExecutable(hash: Bytes32): Promise<void> {
    const tx = await this.fromChain(hash);

    if (tx.status === 'executed' || tx.status === 'failed') {
      throw new PreconditionError('This transaction has already been executed.');
    }
    if (tx.status === 'cancelled') {
      throw new PreconditionError('This transaction has been cancelled.');
    }
    if (tx.status === 'expired') {
      throw new PreconditionError('This transaction has expired and can no longer execute.', {
        remediation: 'Call expire() to close it out, then propose a replacement.',
      });
    }
    if (tx.approvalCount < tx.threshold) {
      throw new PreconditionError(
        `Not enough approvals: ${tx.approvalCount} of ${tx.threshold}.`,
      );
    }

    // A stale prevModule can never execute — surface it now rather than on chain.
    if (tx.decoded?.name === 'disableModule' && tx.decoded.target === 'vault') {
      const module = String(tx.decoded.args.module ?? '');
      const bakedPrev = String(tx.decoded.args.prevModule ?? '');
      const modules = await this.modules();
      const index = modules.findIndex((m) => m.toLowerCase() === module.toLowerCase());
      if (index === -1) {
        throw new StaleProposalError(
          `This proposal disables module ${module}, which is no longer enabled.`,
        );
      }
      // Safe: `index === -1` already threw, and the ternary excludes 0, so index >= 1.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const expectedPrev = index === 0 ? SENTINEL_MODULES : modules[index - 1]!;
      if (expectedPrev.toLowerCase() !== bakedPrev.toLowerCase()) {
        throw new StaleProposalError(
          `The module list changed since this proposal was created: it names ${bakedPrev} as the ` +
            `predecessor of ${module}, but the current predecessor is ${expectedPrev}.`,
        );
      }
    }
  }

  // =========================================================================
  // Holdings and activity
  // =========================================================================

  /**
   * Native and token holdings.
   *
   * Token discovery needs the indexer — the chain cannot answer "which contracts has
   * this address touched" without scanning every log. Amounts are verified on chain
   * by default; pass `{ verify: false }` to accept replayed transfer totals instead.
   */
  async balances(options: BalanceOptions = {}): Promise<VaultBalances> {
    return loadBalances(this.ctx.connection, this.ctx.queries, this.address, options);
  }

  /** Native QUAI received by the vault. Indexer-only. */
  async deposits(options: Pagination = {}) {
    return this.requireQueries('Listing deposits').deposits(this.address, options);
  }

  /** ERC20/721/1155 transfers involving this vault. Indexer-only. */
  async tokenTransfers(options: Pagination = {}) {
    return this.requireQueries('Listing token transfers').tokenTransfers(this.address, options);
  }

  /** Message hashes currently signed by the vault for EIP-1271. Indexer-only. */
  async signedMessages() {
    return this.requireQueries('Listing signed messages').signedMessages(this.address);
  }

  /**
   * Follow indexer changes for this vault over Supabase Realtime.
   *
   * Events fire after the indexer processes a block, so treat them as a signal to
   * re-read rather than as state themselves — re-read through this handle so approval
   * counts stay intersected with the current owner set.
   *
   * ```ts
   * const sub = vault.watch((e) => console.log(e.topic, e.type));
   * // …later
   * await sub.unsubscribe();
   * ```
   */
  watch(handler: (event: WatchEvent) => void, options: WatchOptions = {}): Subscription {
    if (!this.ctx.indexer) throw new NoIndexerError('Watching a vault');
    return watchVault(this.ctx.indexer, this.address, handler, options);
  }

  // =========================================================================
  // Waiting
  // =========================================================================

  /**
   * Block until the indexer has caught up to `blockNumber` (or to the chain head
   * when omitted), so a subsequent indexed read reflects a write you just made.
   *
   * Returns `reached: false` on timeout rather than throwing — a lagging indexer is
   * an expected operating condition, and the caller may reasonably fall back to a
   * chain read. Requires an indexer; without one there is nothing to wait for.
   */
  async waitForIndexer(
    blockNumber?: number,
    options: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ reached: boolean; lastIndexedBlock: number }> {
    if (!this.ctx.indexer) throw new NoIndexerError('Waiting for the indexer');

    let target = blockNumber;
    if (target === undefined) {
      // Quai is sharded, so there is no single chain head — the head that matters is
      // the one for this vault's own zone, derived from its address prefix.
      const zone = getZoneForAddress(this.address);
      if (!zone) {
        throw new ValidationError(
          `Cannot determine the Quai zone for vault ${this.address}; pass an explicit block number.`,
        );
      }
      // Zone and Shard share their wire values but are nominally distinct types.
      target = Number(await this.ctx.connection.provider.getBlockNumber(toShard(zone)));
    }
    return this.ctx.indexer.waitForBlock(target, options);
  }

  /**
   * Poll until a transaction is executable, then resolve with its current state.
   *
   * Lets a caller express "run this when it can run" instead of reimplementing the
   * timelock arithmetic. Resolves as soon as the status reaches `ready`; rejects if
   * the transaction reaches a terminal state first, or if the deadline passes.
   *
   * Reads go through the chain so the answer is authoritative — a `ready` verdict
   * here is immediately actionable.
   */
  async waitForExecutable(
    txHash: Bytes32,
    options: {
      /** Give up after this long. Default 1 hour. */
      timeoutMs?: number;
      /** Poll interval. Default 15s, roughly three Quai blocks. */
      pollIntervalMs?: number;
      signal?: AbortSignal;
      onPoll?: (tx: VaultTransaction) => void;
    } = {},
  ): Promise<VaultTransaction> {
    const hash = normalizeTxHash(txHash);
    const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;
    const pollIntervalMs = options.pollIntervalMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (options.signal?.aborted) throw new AbortError('Waiting for the transaction');

      const tx = await this.fromChain(hash);
      options.onPoll?.(tx);

      if (tx.status === 'ready') return tx;

      if (tx.status === 'executed' || tx.status === 'failed') {
        throw new PreconditionError(`Transaction ${hash} has already been executed.`);
      }
      if (tx.status === 'cancelled' || tx.status === 'expired') {
        throw new PreconditionError(`Transaction ${hash} is ${tx.status} and can never execute.`);
      }

      // Below quorum there is no deadline to wait for — only more approvals help.
      if (tx.approvalCount < tx.threshold) {
        throw new PreconditionError(
          `Transaction ${hash} needs ${tx.threshold} approvals and has ${tx.approvalCount}. ` +
            'Waiting cannot resolve this.',
          { remediation: 'Collect the remaining approvals, then wait for the timelock.' },
        );
      }

      // Timelocked with quorum: sleep until the clock lifts, or the next poll tick.
      const untilExecutable =
        tx.executableAfter > 0 ? tx.executableAfter * 1000 - Date.now() : pollIntervalMs;
      const wait = Math.max(1_000, Math.min(untilExecutable, pollIntervalMs));

      if (Date.now() + wait > deadline) {
        throw new PreconditionError(
          `Timed out after ${timeoutMs}ms waiting for ${hash} to become executable.`,
          {
            ...(tx.executableAfter > 0 ? { retryableAt: tx.executableAfter } : {}),
            remediation:
              tx.executableAfter > 0
                ? `Executable after ${new Date(tx.executableAfter * 1000).toISOString()}.`
                : 'The timelock clock has not started yet.',
          },
        );
      }

      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  // =========================================================================
  // Presentation
  // =========================================================================

  /** Compact human-readable summary of a transaction's state. */
  async describe(txHash: Bytes32, caller?: Address): Promise<string> {
    const tx = await this.transaction(txHash);
    const lines = [
      `Transaction ${tx.hash}`,
      `  ${tx.summary}`,
      `  status: ${tx.status} (${tx.approvalCount}/${tx.threshold} approvals)`,
    ];
    if (tx.value > 0n) lines.push(`  value: ${formatQuai(tx.value)} QUAI`);
    if (tx.approvedAt > 0) {
      lines.push(`  quorum reached: ${new Date(tx.approvedAt * 1000).toISOString()}`);
    }
    if (tx.executableAfter > 0) {
      const remaining = tx.executableAfter - nowSeconds();
      lines.push(
        `  executable after: ${new Date(tx.executableAfter * 1000).toISOString()}` +
          (remaining > 0 ? ` (in ${remaining}s)` : ' (now)'),
      );
    }
    if (tx.expiration > 0) {
      lines.push(`  expires: ${new Date(tx.expiration * 1000).toISOString()}`);
    }
    if (tx.decodedRevert) lines.push(`  revert: ${tx.decodedRevert.message}`);
    lines.push(`  source: ${tx.source}`);

    if (caller || this.ctx.connection.hasSigner()) {
      // Reuse the record already fetched above rather than reading it a second time.
      const affordances = await this.resolveAffordances(tx.hash, tx, caller);
      const allowed = affordances.filter((a) => a.allowed).map((a) => a.action);
      lines.push(`  you can: ${allowed.length > 0 ? allowed.join(', ') : 'nothing right now'}`);
    }
    return lines.join('\n');
  }
}

/**
 * Assert a receipt exists and did not revert.
 *
 * `wait()` resolves to null when the transaction was replaced or dropped rather than
 * mined. Without this guard the caller would get a `TypeError` from dereferencing
 * `receipt.hash` instead of an explanation of what happened.
 */
function assertReceipt(
  receipt: ReceiptLike | null | undefined,
  operation: string,
  revertMessage: string,
): asserts receipt is ReceiptLike {
  if (!receipt) {
    throw new RevertError(
      `${operation} produced no receipt — the transaction was replaced or dropped before it was mined.`,
      undefined,
      { remediation: 'Check the mempool for a replacement, then retry if it never landed.' },
    );
  }
  if (receipt.status === 0) throw new RevertError(revertMessage);
}

/**
 * Extract only the proposal options from a params bag.
 *
 * Spreading the whole bag would let a caller-facing field named `to` (the token
 * recipient) overwrite the encoded call target (the token contract) — silently
 * sending a proposal to the wrong address.
 */
function proposeOptionsOf(options: ProposeOptions): ProposeOptions {
  return {
    ...(options.expiration != null ? { expiration: options.expiration } : {}),
    ...(options.executionDelay != null ? { executionDelay: options.executionDelay } : {}),
    ...(options.dryRun != null ? { dryRun: options.dryRun } : {}),
  };
}

/** Wrap a provider/contract error with decoded revert data when available. */
function toRevertError(err: unknown, context: string): Error {
  if (err instanceof RevertError || err instanceof PreconditionError) return err;
  const decoded = decodeRevertFromError(err);
  const detail = decoded ? `: ${decoded.message}` : '';
  const base = err instanceof Error ? err.message : String(err);
  return new RevertError(`${context}${detail || `: ${base}`}`, decoded, { cause: err });
}

export type { DecodedBatchCall };
