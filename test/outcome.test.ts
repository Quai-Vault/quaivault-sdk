import { describe, expect, it } from 'vitest';
import { Interface } from 'quais';
import { QuaiVaultAbi } from '../src/abi/index.js';
import { classifyExecution, extractProposedTxHash } from '../src/lifecycle/outcome.js';
import type { ReceiptLike } from '../src/lifecycle/outcome.js';

const iface = new Interface(QuaiVaultAbi);
const VAULT = '0x00112233445566778899aabbccddeeff00112233';
const TX = '0x' + 'ab'.repeat(32);
const EXECUTOR = '0x0099887766554433221100ffeeddccbbaa998877';

function log(event: string, args: unknown[], address = VAULT) {
  const fragment = iface.getEvent(event);
  if (!fragment) throw new Error(`no event ${event}`);
  const encoded = iface.encodeEventLog(fragment, args);
  return { topics: encoded.topics, data: encoded.data, address };
}

function receipt(logs: ReturnType<typeof log>[]): ReceiptLike {
  return {
    hash: '0x' + '11'.repeat(32),
    blockNumber: 1234,
    gasUsed: 100_000n,
    status: 1,
    logs,
  };
}

describe('classifyExecution', () => {
  it('reports "executed" when TransactionExecuted is emitted', () => {
    const result = classifyExecution(
      receipt([log('TransactionExecuted', [TX, EXECUTOR])]),
      VAULT,
      TX,
    );
    expect(result.outcome).toBe('executed');
    expect(result.blockNumber).toBe(1234);
    expect(result.gasUsed).toBe(100_000n);
  });

  it('reports "failed" with decoded revert data when the target call reverts', () => {
    // The vault marks the transaction executed and emits TransactionFailed rather
    // than reverting, so the receipt still reports success.
    const revertData = iface.encodeErrorResult('NotAnOwner', []);
    const result = classifyExecution(
      receipt([log('TransactionFailed', [TX, EXECUTOR, revertData])]),
      VAULT,
      TX,
    );
    expect(result.outcome).toBe('failed');
    expect(result.decodedRevert?.name).toBe('NotAnOwner');
    expect(result.message).toMatch(/terminal/i);
  });

  it('reports "timelock_started" for the lazy-clock path', () => {
    // executeTransaction on a timelocked tx whose approvedAt was never set records
    // the clock and returns without executing — a successful receipt, no execution.
    const approvedAt = Math.floor(Date.now() / 1000);
    const executableAfter = approvedAt + 3600;
    const result = classifyExecution(
      receipt([log('ThresholdReached', [TX, approvedAt, executableAfter])]),
      VAULT,
      TX,
    );
    expect(result.outcome).toBe('timelock_started');
    expect(result.executableAfter).toBe(executableAfter);
    expect(result.message).toMatch(/Nothing has executed yet/);
  });

  it('reports "approved_only" when approveAndExecute records an approval but cannot execute', () => {
    const result = classifyExecution(
      receipt([log('TransactionApproved', [TX, EXECUTOR])]),
      VAULT,
      TX,
    );
    expect(result.outcome).toBe('approved_only');
    expect(result.message).toMatch(/threshold is not yet met/);
  });

  it('treats a reached threshold whose delay already elapsed as approved_only', () => {
    const approvedAt = Math.floor(Date.now() / 1000) - 7200;
    const result = classifyExecution(
      receipt([log('ThresholdReached', [TX, approvedAt, approvedAt])]),
      VAULT,
      TX,
    );
    expect(result.outcome).toBe('approved_only');
  });

  it('ignores events for a different transaction hash', () => {
    const other = '0x' + 'cd'.repeat(32);
    const result = classifyExecution(
      receipt([log('TransactionExecuted', [other, EXECUTOR])]),
      VAULT,
      TX,
    );
    expect(result.outcome).toBe('approved_only');
  });

  it('ignores vault-shaped events emitted by a different contract', () => {
    const impostor = '0x00ffffffffffffffffffffffffffffffffffffff';
    const result = classifyExecution(
      receipt([log('TransactionExecuted', [TX, EXECUTOR], impostor)]),
      VAULT,
      TX,
    );
    expect(result.outcome).toBe('approved_only');
  });
});

describe('extractProposedTxHash', () => {
  it('reads the hash out of TransactionProposed', () => {
    const r = receipt([
      log('TransactionProposed', [TX, EXECUTOR, EXECUTOR, 0n, '0x', 0, 0]),
    ]);
    expect(extractProposedTxHash(r, VAULT)).toBe(TX);
  });

  it('returns null when the event is absent', () => {
    expect(extractProposedTxHash(receipt([]), VAULT)).toBeNull();
  });
});
