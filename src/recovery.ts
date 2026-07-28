import { getAddress } from 'quais';
import { assertQuaiAddress } from './address.js';
import type { Connection } from './chain/connection.js';
import { normalizeTxHash } from './chain/connection.js';
import { RecoveryContract, type RawRecovery } from './chain/recovery-contract.js';
import type { IndexerQueries } from './indexer/queries.js';
import { decodeRevertFromError } from './errors/decode.js';
import {
  NotFoundError,
  PreconditionError,
  RevertError,
  ValidationError,
} from './errors/index.js';
import { deriveRecoveryStatus, nowSeconds } from './lifecycle/status.js';
import type { ReceiptLike } from './lifecycle/outcome.js';
import type {
  Address,
  Bytes32,
  Hex,
  RecoveryAffordance,
  RecoveryConfig,
  RecoveryRequest,
} from './types.js';

/** Sentinel head of the module linked list — never valid as an owner. */
const SENTINEL = '0x0000000000000000000000000000000000000001';
const ZERO = '0x0000000000000000000000000000000000000000';

export interface RecoveryModuleContext {
  connection: Connection;
  queries: IndexerQueries | null;
  vaultAddress: Address;
  moduleAddress: Address | undefined;
}

/**
 * Guardian-based recovery for one vault.
 *
 * Recovery is an escape hatch that bypasses the owner multisig entirely: enough
 * guardians can replace the owner set after a delay. Every write here is therefore
 * gated on the module still being enabled on the vault, which is the vault owners'
 * only lever once guardians are configured.
 */
export class RecoveryModule {
  constructor(private readonly ctx: RecoveryModuleContext) {}

  /** The module address, or a typed error naming the variable to set. */
  get address(): Address {
    if (!this.ctx.moduleAddress) {
      throw new ValidationError(
        'No SocialRecoveryModule address is configured for this network.',
        'Set QUAIVAULT_SOCIAL_RECOVERY_MODULE or pass contracts.socialRecovery.',
      );
    }
    return this.ctx.moduleAddress;
  }

  private contract(write = false): RecoveryContract {
    return new RecoveryContract(this.ctx.connection.socialRecovery(this.address, write), this.ctx.connection.retry);
  }

  private get vault(): Address {
    return this.ctx.vaultAddress;
  }

  // =========================================================================
  // Reads
  // =========================================================================

  /** Whether the module is currently enabled on the vault. */
  async isEnabled(): Promise<boolean> {
    if (!this.ctx.moduleAddress) return false;
    const vault = this.ctx.connection.vault(this.vault);
    return vault.getFunction('isModuleEnabled(address)')(this.address) as Promise<boolean>;
  }

  async config(): Promise<RecoveryConfig> {
    const raw = await this.contract().getRecoveryConfig(this.vault);
    const guardians = Array.from(raw.guardians ?? []).map((g) => getAddress(String(g)));
    return {
      guardians,
      threshold: Number(raw.threshold ?? 0),
      recoveryPeriod: Number(raw.recoveryPeriod ?? 0),
      configured: guardians.length > 0,
    };
  }

  async isGuardian(address: Address): Promise<boolean> {
    return this.contract().isGuardian(this.vault, getAddress(address));
  }

  /** Hashes of recoveries the module still tracks as pending. */
  async pendingHashes(): Promise<Bytes32[]> {
    return (await this.contract().getPendingRecoveryHashes(this.vault)).map((h) => String(h));
  }

  async hasPending(): Promise<boolean> {
    return this.contract().hasPendingRecoveries(this.vault);
  }

  /**
   * One recovery request, read from chain.
   *
   * Throws `NotFoundError` for a hash that was never initiated *or* was cancelled —
   * `cancelRecovery` deletes the struct, so the two are indistinguishable on chain.
   * Use {@link history} for cancelled recoveries.
   */
  async get(recoveryHash: Bytes32): Promise<RecoveryRequest> {
    const hash = normalizeTxHash(recoveryHash, 'recovery hash');
    const raw = await this.contract().getRecovery(this.vault, hash);

    if (Number(raw.executionTime ?? 0) === 0) {
      throw new NotFoundError(
        `No active recovery ${hash} on vault ${this.vault}. It was never initiated, or it was ` +
          'cancelled (cancellation deletes the on-chain record).',
      );
    }
    return this.buildFromChain(hash, raw);
  }

  /** Every recovery the module still tracks as pending, hydrated. */
  async pending(): Promise<RecoveryRequest[]> {
    const hashes = await this.pendingHashes();
    const contract = this.contract();
    const results = await Promise.all(
      hashes.map(async (hash) => {
        const raw = await contract.getRecovery(this.vault, hash);
        if (Number(raw.executionTime ?? 0) === 0) return null;
        return this.buildFromChain(hash, raw);
      }),
    );
    return results.filter((r): r is RecoveryRequest => r !== null);
  }

  /**
   * Full recovery history including executed, cancelled and expired requests.
   * Indexer-only — the chain retains no record of cancelled recoveries.
   */
  async history(options: { limit?: number; offset?: number } = {}): Promise<RecoveryRequest[]> {
    const queries = this.ctx.queries;
    if (!queries) return [];

    const rows = await queries.recoveryHistory(this.vault, options);
    return rows.map((row) => ({
      hash: row.recovery_hash,
      vault: this.vault,
      newOwners: row.new_owners.map((o) => getAddress(o)),
      newThreshold: row.new_threshold,
      approvalCount: row.approval_count ?? 0,
      requiredThreshold: row.required_threshold,
      executionTime: Number(row.execution_time),
      expiration: Number(row.expiration ?? 0),
      // Trust the indexer only for states it alone can observe (cancelled /
      // invalidated); derive everything else, since an un-cleaned recovery stays
      // 'pending' in the database long after its deadline.
      status:
        row.status === 'cancelled' || row.status === 'invalidated'
          ? 'cancelled'
          : deriveRecoveryStatus({
              executed: row.status === 'executed',
              approvalCount: row.approval_count ?? 0,
              requiredThreshold: row.required_threshold,
              executionTime: Number(row.execution_time),
              expiration: Number(row.expiration ?? 0),
            }),
      executed: row.status === 'executed',
      initiator: getAddress(row.initiator_address),
      source: 'indexer' as const,
    }));
  }

  /** Guardians who have an active approval on a recovery. */
  async approvals(recoveryHash: Bytes32): Promise<Address[]> {
    const hash = normalizeTxHash(recoveryHash, 'recovery hash');

    // The chain has no enumeration, so probe each configured guardian.
    const { guardians } = await this.config();
    const contract = this.contract();
    const flags = await Promise.all(
      guardians.map((g) => contract.recoveryApprovals(this.vault, hash, g)),
    );
    return guardians.filter((_, i) => flags[i] === true);
  }

  /** Hash the next `initiate` with these parameters would produce. */
  async predictHash(newOwners: Address[], newThreshold: number): Promise<Bytes32> {
    return this.contract().predictNextRecoveryHash(
      this.vault,
      newOwners.map((o) => getAddress(o)),
      newThreshold,
    );
  }

  // =========================================================================
  // Writes
  // =========================================================================

  /**
   * Initiate a recovery. Guardians only.
   *
   * Returns the recovery hash, read from the `RecoveryInitiated` event — the function's
   * return value is not recoverable from a receipt.
   */
  async initiate(params: {
    newOwners: Address[];
    newThreshold: number;
  }): Promise<{ recoveryHash: Bytes32; chainTxHash: Hex }> {
    // A Qi or zone-less owner could never sign, so a recovery installing one would
    // hand the vault to a set that cannot act.
    const newOwners = params.newOwners.map((o, i) => assertQuaiAddress(o, `newOwners[${i}]`));
    this.validateNewOwners(newOwners, params.newThreshold);

    const caller = await this.ctx.connection.address();
    await this.assertEnabled('Initiating a recovery');

    const config = await this.config();
    if (!config.configured) {
      throw new PreconditionError('This vault has no social recovery configuration.', {
        remediation:
          'Owners must first propose and execute setupRecovery via vault.propose.setupRecovery().',
      });
    }
    if (!(await this.isGuardian(caller))) {
      throw new PreconditionError(`${caller} is not a guardian of this vault.`);
    }

    const contract = this.contract(true);
    try {
      const sent = await contract.initiateRecovery(this.vault, newOwners, params.newThreshold);
      const receipt = (await sent.wait()) as ReceiptLike;
      if (!receipt || receipt.status === 0) {
        throw new RevertError('The recovery initiation reverted.');
      }
      const recoveryHash = this.extractRecoveryHash(receipt);
      if (!recoveryHash) {
        throw new RevertError(
          'The recovery was initiated but no RecoveryInitiated event was found.',
        );
      }
      return { recoveryHash, chainTxHash: (receipt.hash ?? receipt.transactionHash ?? '') as Hex };
    } catch (err) {
      throw this.toRevert(err, 'Initiating the recovery failed');
    }
  }

  /** Approve a recovery. Guardians only. */
  async approve(recoveryHash: Bytes32): Promise<{ chainTxHash: Hex }> {
    const hash = normalizeTxHash(recoveryHash, 'recovery hash');
    const caller = await this.ctx.connection.address();
    await this.assertEnabled('Approving a recovery');

    if (!(await this.isGuardian(caller))) {
      throw new PreconditionError(`${caller} is not a guardian of this vault.`);
    }
    const request = await this.get(hash);
    this.assertLive(request);
    if (await this.contract().recoveryApprovals(this.vault, hash, caller)) {
      throw new PreconditionError('You have already approved this recovery.');
    }

    return this.send((c) => c.approveRecovery(this.vault, hash), 'Approving the recovery failed');
  }

  /** Withdraw a guardian approval before the recovery executes. */
  async revokeApproval(recoveryHash: Bytes32): Promise<{ chainTxHash: Hex }> {
    const hash = normalizeTxHash(recoveryHash, 'recovery hash');
    const caller = await this.ctx.connection.address();

    if (!(await this.isGuardian(caller))) {
      throw new PreconditionError(`${caller} is not a guardian of this vault.`);
    }
    if (!(await this.contract().recoveryApprovals(this.vault, hash, caller))) {
      throw new PreconditionError('You have no active approval on this recovery to revoke.');
    }

    return this.send(
      (c) => c.revokeRecoveryApproval(this.vault, hash),
      'Revoking the recovery approval failed',
    );
  }

  /**
   * Execute a recovery, replacing the vault's owner set. Permissionless once the
   * guardian threshold is met and the recovery period has elapsed.
   */
  async execute(recoveryHash: Bytes32): Promise<{ chainTxHash: Hex }> {
    const hash = normalizeTxHash(recoveryHash, 'recovery hash');
    await this.assertEnabled('Executing a recovery');

    const request = await this.get(hash);
    this.assertLive(request);

    if (request.approvalCount < request.requiredThreshold) {
      throw new PreconditionError(
        `Not enough guardian approvals: ${request.approvalCount} of ${request.requiredThreshold}.`,
      );
    }
    const now = nowSeconds();
    if (now < request.executionTime) {
      throw new PreconditionError(
        `The recovery period has not elapsed. Executable after ` +
          `${new Date(request.executionTime * 1000).toISOString()}.`,
        { retryableAt: request.executionTime },
      );
    }

    // S-1: new owners are added before old ones are removed, so a fully disjoint
    // replacement can transiently exceed MAX_OWNERS and revert.
    const vault = this.ctx.connection.vault(this.vault);
    const currentOwners = (await vault.getFunction('getOwners()')()) as string[];
    const current = new Set(Array.from(currentOwners).map((o) => String(o).toLowerCase()));
    const overlap = request.newOwners.filter((o) => current.has(o.toLowerCase())).length;
    const peak = current.size + request.newOwners.length - overlap;
    if (peak > 20) {
      throw new PreconditionError(
        `Executing this recovery would transiently hold ${peak} owners, above the 20-owner maximum ` +
          '— new owners are added before old ones are removed.',
        {
          remediation:
            'Run a recovery that retains at least one existing owner, then a second recovery to ' +
            'replace it.',
        },
      );
    }

    return this.send((c) => c.executeRecovery(this.vault, hash), 'Executing the recovery failed');
  }

  /**
   * Cancel a recovery. Callable by any current vault owner — this is the owners'
   * defence against a hostile or mistaken guardian action.
   */
  async cancel(recoveryHash: Bytes32): Promise<{ chainTxHash: Hex }> {
    const hash = normalizeTxHash(recoveryHash, 'recovery hash');
    const caller = await this.ctx.connection.address();

    const vault = this.ctx.connection.vault(this.vault);
    const isOwner = (await vault.getFunction('isOwner(address)')(caller)) as boolean;
    if (!isOwner) {
      throw new PreconditionError(
        `Only a current owner of the vault can cancel a recovery. ${caller} is not one.`,
      );
    }

    return this.send((c) => c.cancelRecovery(this.vault, hash), 'Cancelling the recovery failed');
  }

  /** Clean up a recovery past its deadline. Permissionless. */
  async expire(recoveryHash: Bytes32): Promise<{ chainTxHash: Hex }> {
    const hash = normalizeTxHash(recoveryHash, 'recovery hash');
    return this.send((c) => c.expireRecovery(this.vault, hash), 'Expiring the recovery failed');
  }

  // =========================================================================
  // Affordances
  // =========================================================================

  /** What `caller` may do to a recovery right now, and when blocked actions unlock. */
  async affordances(recoveryHash: Bytes32, caller?: Address): Promise<RecoveryAffordance[]> {
    const hash = normalizeTxHash(recoveryHash, 'recovery hash');
    const who = caller ?? (await this.ctx.connection.addressOrNull());
    if (!who) {
      throw new ValidationError(
        'affordances() needs a caller address when the client has no signer.',
      );
    }
    const address = getAddress(who);

    const [request, isGuardian, hasApproved, enabled, isOwner] = await Promise.all([
      this.get(hash),
      this.isGuardian(address),
      this.contract().recoveryApprovals(this.vault, hash, address),
      this.isEnabled(),
      this.ctx.connection.vault(this.vault).getFunction('isOwner(address)')(address) as Promise<boolean>,
    ]);

    const now = nowSeconds();
    const terminal = request.status === 'executed' || request.status === 'cancelled';
    const expired = now > request.expiration && request.expiration > 0;
    const quorum = request.approvalCount >= request.requiredThreshold;
    const out: RecoveryAffordance[] = [];

    const blocked = (
      action: RecoveryAffordance['action'],
      reason: string,
      blockedBy: RecoveryAffordance['blockedBy'],
      availableAt?: number,
    ): RecoveryAffordance => ({
      action,
      allowed: false,
      reason,
      blockedBy,
      ...(availableAt !== undefined ? { availableAt } : {}),
    });

    // --- approve
    if (terminal) out.push(blocked('approve', terminalReason(request), 'terminal_state'));
    else if (expired) out.push(blocked('approve', 'The recovery has expired.', 'expired'));
    else if (!enabled) {
      out.push(blocked('approve', 'The recovery module is not enabled on this vault.', 'module_disabled'));
    } else if (!isGuardian) {
      out.push(blocked('approve', 'Only guardians can approve a recovery.', 'not_guardian'));
    } else if (hasApproved) {
      out.push(blocked('approve', 'You have already approved this recovery.', 'already_approved'));
    } else {
      out.push({ action: 'approve', allowed: true, reason: 'You can approve this recovery.' });
    }

    // --- revokeApproval (no module-enabled gate on chain)
    if (terminal) out.push(blocked('revokeApproval', terminalReason(request), 'terminal_state'));
    else if (!isGuardian) {
      out.push(blocked('revokeApproval', 'Only guardians can revoke a recovery approval.', 'not_guardian'));
    } else if (!hasApproved) {
      out.push(blocked('revokeApproval', 'You have no active approval to revoke.', 'not_approved'));
    } else {
      out.push({ action: 'revokeApproval', allowed: true, reason: 'You can revoke your approval.' });
    }

    // --- execute (permissionless once the gates clear)
    if (terminal) out.push(blocked('execute', terminalReason(request), 'terminal_state'));
    else if (expired) out.push(blocked('execute', 'The recovery has expired.', 'expired'));
    else if (!enabled) {
      out.push(blocked('execute', 'The recovery module is not enabled on this vault.', 'module_disabled'));
    } else if (!quorum) {
      out.push(
        blocked(
          'execute',
          `Needs ${request.requiredThreshold} guardian approvals, has ${request.approvalCount}.`,
          'threshold',
        ),
      );
    } else if (now < request.executionTime) {
      out.push(
        blocked(
          'execute',
          `Recovery period ends ${new Date(request.executionTime * 1000).toISOString()}.`,
          'timelock',
          request.executionTime,
        ),
      );
    } else {
      out.push({
        action: 'execute',
        allowed: true,
        reason: 'This recovery is ready to execute and will replace the vault owner set.',
      });
    }

    // --- cancel (any current owner)
    if (terminal) out.push(blocked('cancel', terminalReason(request), 'terminal_state'));
    else if (!isOwner) {
      out.push(blocked('cancel', 'Only a current vault owner can cancel a recovery.', 'not_owner'));
    } else {
      out.push({
        action: 'cancel',
        allowed: true,
        reason: 'As a vault owner you can cancel this recovery.',
      });
    }

    // --- expire (permissionless, past the deadline)
    if (terminal) out.push(blocked('expire', terminalReason(request), 'terminal_state'));
    else if (!expired) {
      out.push(
        blocked(
          'expire',
          `Not expired yet. Expires ${new Date(request.expiration * 1000).toISOString()}.`,
          'not_expired',
          request.expiration + 1,
        ),
      );
    } else {
      out.push({
        action: 'expire',
        allowed: true,
        reason: 'Past its deadline — anyone can clean it up, which also unblocks setupRecovery.',
      });
    }

    return out;
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private buildFromChain(hash: Bytes32, raw: RawRecovery): RecoveryRequest {
    const executionTime = Number(raw.executionTime ?? 0);
    const expiration = Number(raw.expiration ?? 0);
    const approvalCount = Number(raw.approvalCount ?? 0);
    const requiredThreshold = Number(raw.requiredThreshold ?? 0);
    const executed = Boolean(raw.executed);

    const status = deriveRecoveryStatus({
      executed,
      approvalCount,
      requiredThreshold,
      executionTime,
      expiration,
    });

    return {
      hash,
      vault: this.vault,
      newOwners: Array.from(raw.newOwners ?? []).map((o) => getAddress(String(o))),
      newThreshold: Number(raw.newThreshold ?? 0),
      approvalCount,
      requiredThreshold,
      executionTime,
      expiration,
      status,
      executed,
      source: 'chain',
    };
  }

  private validateNewOwners(newOwners: Address[], newThreshold: number): void {
    if (newOwners.length === 0) throw new ValidationError('At least one new owner is required.');

    const seen = new Set<string>();
    for (const owner of newOwners) {
      const key = owner.toLowerCase();
      if (key === ZERO || key === SENTINEL) {
        throw new ValidationError(
          `New owner ${owner} is reserved — the zero address and the module sentinel 0x…01 are rejected.`,
        );
      }
      if (key === this.vault.toLowerCase()) {
        throw new ValidationError('The vault cannot be an owner of itself.');
      }
      if (seen.has(key)) throw new ValidationError(`Duplicate new owner: ${owner}.`);
      seen.add(key);
    }
    if (!Number.isInteger(newThreshold) || newThreshold < 1 || newThreshold > newOwners.length) {
      throw new ValidationError(
        `Invalid new threshold ${newThreshold}: must be between 1 and ${newOwners.length}.`,
      );
    }
  }

  private assertLive(request: RecoveryRequest): void {
    if (request.executed) {
      throw new PreconditionError('This recovery has already been executed.');
    }
    if (request.expiration > 0 && nowSeconds() > request.expiration) {
      throw new PreconditionError('This recovery has expired.', {
        remediation: 'Call expire() to clean it up, then initiate a new recovery.',
      });
    }
  }

  private async assertEnabled(operation: string): Promise<void> {
    if (!(await this.isEnabled())) {
      throw new PreconditionError(
        `${operation} requires the SocialRecoveryModule to be enabled on this vault.`,
        {
          remediation:
            'Owners must propose and execute enableModule for the recovery module first.',
        },
      );
    }
  }

  private async send(
    call: (contract: RecoveryContract) => Promise<{ hash: string; wait(): Promise<unknown> }>,
    context: string,
  ): Promise<{ chainTxHash: Hex }> {
    try {
      const sent = await call(this.contract(true));
      const receipt = (await sent.wait()) as ReceiptLike;
      if (!receipt || receipt.status === 0) throw new RevertError(`${context}: reverted.`);
      return { chainTxHash: (receipt.hash ?? receipt.transactionHash ?? '') as Hex };
    } catch (err) {
      throw this.toRevert(err, context);
    }
  }

  private extractRecoveryHash(receipt: ReceiptLike): Bytes32 | null {
    const iface = this.contract().interface;
    const target = this.address.toLowerCase();
    for (const log of receipt.logs ?? []) {
      if (log.address && log.address.toLowerCase() !== target) continue;
      try {
        const parsed = iface.parseLog({ topics: Array.from(log.topics), data: log.data });
        if (parsed?.name === 'RecoveryInitiated') {
          const index = parsed.fragment.inputs.findIndex((i) => i.name === 'recoveryHash');
          const value = index >= 0 ? parsed.args[index] : undefined;
          if (typeof value === 'string') return value;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private toRevert(err: unknown, context: string): Error {
    if (err instanceof RevertError || err instanceof PreconditionError) return err;
    const decoded = decodeRevertFromError(err);
    const base = err instanceof Error ? err.message : String(err);
    return new RevertError(`${context}${decoded ? `: ${decoded.message}` : `: ${base}`}`, decoded, {
      cause: err,
    });
  }
}

function terminalReason(request: RecoveryRequest): string {
  if (request.executed) return 'This recovery has already been executed.';
  if (request.status === 'cancelled') return 'This recovery was cancelled.';
  return 'This recovery is in a terminal state.';
}
