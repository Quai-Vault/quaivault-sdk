import { describe, expect, it, vi } from 'vitest';
import { isTransient, withRetry } from '../src/chain/retry.js';
import { AbortError } from '../src/errors/index.js';

describe('isTransient', () => {
  it('treats network, server and timeout codes as transient', () => {
    for (const code of ['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 'BAD_DATA']) {
      expect(isTransient({ code }), code).toBe(true);
    }
  });

  it('never retries a revert — CALL_EXCEPTION is deterministic', () => {
    expect(isTransient({ code: 'CALL_EXCEPTION', data: '0xdeadbeef' })).toBe(false);
  });

  it('never retries a user rejection or a nonce/funds problem', () => {
    for (const code of [
      'ACTION_REJECTED',
      'NONCE_EXPIRED',
      'INSUFFICIENT_FUNDS',
      'INVALID_ARGUMENT',
      'REPLACEMENT_UNDERPRICED',
      'TRANSACTION_REPLACED',
    ]) {
      expect(isTransient({ code }), code).toBe(false);
    }
  });

  it('retries rate limits and 5xx, but not 4xx client errors', () => {
    expect(isTransient({ status: 429 })).toBe(true);
    expect(isTransient({ status: 503 })).toBe(true);
    expect(isTransient({ status: 500 })).toBe(true);
    expect(isTransient({ status: 400 })).toBe(false);
    expect(isTransient({ status: 404 })).toBe(false);
  });

  it('reads the status out of a nested quais transport response', () => {
    expect(isTransient({ info: { response: { status: 502 } } })).toBe(true);
    expect(isTransient({ info: { response: { status: 401 } } })).toBe(false);
  });

  it('recognises raw transport failures by message', () => {
    expect(isTransient(new Error('fetch failed'))).toBe(true);
    expect(isTransient(new Error('socket hang up'))).toBe(true);
    expect(isTransient(new Error('read ECONNRESET'))).toBe(true);
    expect(isTransient(new Error('Request timed out'))).toBe(true);
  });

  it('unwraps one level of cause', () => {
    expect(isTransient({ message: 'wrapped', cause: new Error('ECONNREFUSED') })).toBe(true);
  });

  it('defaults to permanent for anything unrecognised', () => {
    // Erring this way surfaces genuine bugs immediately instead of hiding them
    // behind three slow attempts.
    expect(isTransient(new Error('something specific went wrong'))).toBe(false);
    expect(isTransient(null)).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });

  it('does not loop forever on a self-referencing cause', () => {
    const err: Record<string, unknown> = { message: 'x' };
    err.cause = err;
    expect(isTransient(err)).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the first success without delay', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    expect(await withRetry(fn)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ code: 'SERVER_ERROR' })
      .mockResolvedValue('ok');
    expect(await withRetry(fn, { baseDelayMs: 1 })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue({ code: 'TIMEOUT' });
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a permanent error — a revert must surface at once', async () => {
    const fn = vi.fn().mockRejectedValue({ code: 'CALL_EXCEPTION' });
    await expect(withRetry(fn, { maxAttempts: 5, baseDelayMs: 1 })).rejects.toMatchObject({
      code: 'CALL_EXCEPTION',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports each retry through onRetry', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ code: 'NETWORK_ERROR' })
      .mockRejectedValueOnce({ code: 'NETWORK_ERROR' })
      .mockResolvedValue('ok');

    await withRetry(fn, { baseDelayMs: 1, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1 });
    expect(onRetry.mock.calls[1]![0]).toMatchObject({ attempt: 2 });
  });

  it('keeps every backoff within maxDelayMs', async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue({ code: 'TIMEOUT' });
    await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 20,
      onRetry: ({ delayMs }) => delays.push(delayMs),
    }).catch(() => undefined);

    expect(delays).toHaveLength(4);
    // Full jitter: uniform in [0, ceiling], and the ceiling is clamped.
    for (const d of delays) expect(d).toBeLessThanOrEqual(20);
  });

  it('aborts promptly via signal', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue({ code: 'TIMEOUT' });
    const promise = withRetry(fn, { maxAttempts: 5, baseDelayMs: 50, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow(/abort/i);
  });

  it('does not call fn at all when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(fn).not.toHaveBeenCalled();
  });

  // A consumer distinguishing "the user pressed Ctrl-C" from "this genuinely failed"
  // switches on `code`, so abort must not surface as a bare Error from either the
  // pre-flight check or the backoff sleep.
  it('reports abort as a typed AbortError from the pre-flight check', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(withRetry(async () => 'ok', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORTED',
    });
  });

  it('reports abort as a typed AbortError from the backoff sleep', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue({ code: 'TIMEOUT' });
    const promise = withRetry(fn, { maxAttempts: 5, baseDelayMs: 50, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError', code: 'ABORTED' });
  });

  it('does not treat an abort as transient', () => {
    expect(isTransient(new AbortError('Something'))).toBe(false);
  });
});
