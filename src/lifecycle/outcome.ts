import { Interface } from 'quais';
import { QuaiVaultAbi } from '../abi/index.js';
import { decodeRevert } from '../errors/decode.js';
import type { Bytes32, ExecuteResult, Hex } from '../types.js';

const vaultInterface = new Interface(QuaiVaultAbi);

export interface ReceiptLike {
  hash?: string;
  transactionHash?: string;
  blockNumber?: number | bigint | null;
  gasUsed?: bigint | number | null;
  status?: number | null;
  logs: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string; address?: string }>;
}

interface ParsedEvent {
  name: string;
  args: Record<string, unknown>;
}

/** Parse only the logs emitted by the vault itself; ignore everything else. */
function parseVaultEvents(receipt: ReceiptLike, vault: string): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  const target = vault.toLowerCase();

  for (const log of receipt.logs ?? []) {
    if (log.address && log.address.toLowerCase() !== target) continue;
    try {
      const parsed = vaultInterface.parseLog({
        topics: Array.from(log.topics),
        data: log.data,
      });
      if (!parsed) continue;
      const args: Record<string, unknown> = {};
      parsed.fragment.inputs.forEach((input, i) => {
        if (input.name) args[input.name] = parsed.args[i];
      });
      out.push({ name: parsed.name, args });
    } catch {
      // Not a vault event (token transfers from the executed call, etc.)
    }
  }
  return out;
}

function eventFor(events: ParsedEvent[], name: string, txHash: Bytes32): ParsedEvent | undefined {
  const wanted = txHash.toLowerCase();
  return events.find(
    (e) => e.name === name && String(e.args.txHash ?? '').toLowerCase() === wanted,
  );
}

function toNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return Number(value ?? 0);
}

/**
 * Classify what actually happened to a vault transaction, from the receipt of the
 * Quai transaction that carried `execute` / `approveAndExecute`.
 *
 * This exists because `receipt.status === 1` does NOT mean the vault transaction ran.
 * Three cases produce a successful receipt with no execution:
 *
 * 1. **Lazy timelock clock** — `executeTransaction` on a timelocked transaction whose
 *    `approvedAt` was never set (e.g. the threshold was lowered after owners approved)
 *    sets `approvedAt`, emits `ThresholdReached`, and returns without executing. It
 *    deliberately does not revert, because a revert would roll back the clock start.
 * 2. **`approveAndExecute` returned false** — the threshold is unmet, or the timelock
 *    has not elapsed. A boolean return value is invisible in a receipt.
 * 3. **External call failure (Option B)** — the vault marks the transaction `executed`
 *    permanently and emits `TransactionFailed` instead of reverting. The vault
 *    transaction is dead; the receipt says success.
 */
export function classifyExecution(
  receipt: ReceiptLike,
  vault: string,
  txHash: Bytes32,
): ExecuteResult {
  const chainTxHash = (receipt.hash ?? receipt.transactionHash ?? '') as Hex;
  const base = {
    txHash,
    chainTxHash,
    blockNumber: toNumber(receipt.blockNumber),
    gasUsed: BigInt(receipt.gasUsed ?? 0),
  };

  const events = parseVaultEvents(receipt, vault);

  const executed = eventFor(events, 'TransactionExecuted', txHash);
  if (executed) {
    return {
      ...base,
      outcome: 'executed',
      message: 'Transaction executed successfully.',
    };
  }

  const failed = eventFor(events, 'TransactionFailed', txHash);
  if (failed) {
    const returnData = String(failed.args.returnData ?? '0x') as Hex;
    const decodedRevert = decodeRevert(returnData);
    return {
      ...base,
      outcome: 'failed',
      returnData,
      decodedRevert,
      message:
        `The vault executed the transaction but the target call reverted` +
        (decodedRevert ? `: ${decodedRevert.message}` : '.') +
        ' This state is terminal — the transaction is permanently marked executed and cannot be retried.' +
        ' Propose a new transaction to try again.',
    };
  }

  // Threshold was reached during this call but nothing executed → the lazy clock
  // started. The caller must come back after the delay.
  const thresholdReached = eventFor(events, 'ThresholdReached', txHash);
  if (thresholdReached) {
    const approvedAt = toNumber(thresholdReached.args.approvedAt);
    const executableAfter = toNumber(thresholdReached.args.executableAfter);
    // Both fields come from the same event, computed under one `block.timestamp`, so
    // `executableAfter > approvedAt` is exactly "a non-zero delay was applied" — the
    // question this branch is actually asking.
    //
    // This used to compare `executableAfter` against the local clock, which is a proxy
    // that holds only while local skew stays smaller than the delay: a vault with a
    // 60-second timelock misclassified under two minutes of drift, while one with a
    // 24-hour timelock never did. Same code, silently different reliability, and the
    // wrong answer here tells the user the opposite of what happened to their funds.
    if (executableAfter > approvedAt) {
      return {
        ...base,
        outcome: 'timelock_started',
        executableAfter,
        message:
          `Quorum was reached and the execution delay started. Nothing has executed yet. ` +
          `Call execute again after ${new Date(executableAfter * 1000).toISOString()}.`,
      };
    }
    return {
      ...base,
      outcome: 'approved_only',
      executableAfter,
      message:
        'Quorum was reached but the transaction did not execute in this call. Call execute again.',
    };
  }

  const approved = eventFor(events, 'TransactionApproved', txHash);
  return {
    ...base,
    outcome: 'approved_only',
    message: approved
      ? 'Your approval was recorded, but the transaction did not execute — the threshold is not yet met.'
      : 'The transaction did not execute. It may be timelocked, or already approved by this owner ' +
        'without the threshold being met.',
  };
}

/**
 * Pull the vault-transaction hash out of a `proposeTransaction` receipt.
 * The `TransactionProposed` event is the only reliable source — `proposeTransaction`
 * returns the hash, but return values are not available from a receipt.
 */
export function extractProposedTxHash(receipt: ReceiptLike, vault: string): Bytes32 | null {
  const events = parseVaultEvents(receipt, vault);
  const proposed = events.find((e) => e.name === 'TransactionProposed');
  const hash = proposed?.args.txHash;
  return typeof hash === 'string' ? hash : null;
}
