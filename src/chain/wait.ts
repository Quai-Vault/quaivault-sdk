import { AbortError, ValidationError } from '../errors/index.js';

export function validatePolling(timeoutMs: number, intervalMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 ||
      !Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > 2_147_483_647) {
    throw new ValidationError('Polling requires a finite non-negative timeout and a positive timer interval.');
  }
}

export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new AbortError('Waiting')); return; }
    const abort = () => { clearTimeout(timer); reject(new AbortError('Waiting')); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
