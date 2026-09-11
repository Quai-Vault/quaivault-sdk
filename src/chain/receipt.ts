import { BroadcastError, RevertError } from '../errors/index.js';
import type { ReceiptLike } from '../lifecycle/outcome.js';
import type { ContractTransactionResponse } from './vault-contract.js';

/** Once submitted, a failed receipt lookup must never imply no state change. */
export async function waitForReceipt(sent: ContractTransactionResponse): Promise<ReceiptLike> {
  let receipt: ReceiptLike | null;
  try {
    receipt = await sent.wait() as ReceiptLike | null;
  } catch (cause) {
    throw new BroadcastError(sent.hash, { cause });
  }
  if (!receipt) throw new BroadcastError(sent.hash);
  if (receipt.status === 0) throw new RevertError(`Chain transaction ${sent.hash} reverted.`);
  if (receipt.status !== 1) throw new BroadcastError(sent.hash);
  return {
    hash: receipt.hash ?? receipt.transactionHash ?? sent.hash,
    status: receipt.status,
    logs: receipt.logs,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
  };
}
