/**
 * Retry policy for transient RPC and indexer failures.
 *
 * Scoped deliberately to **reads**. Retrying a write risks broadcasting the same
 * transaction twice — a resubmit that looks like a timeout to the client may already
 * be in the mempool — so every write path in this SDK calls through unretried.
 */

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** First backoff delay. Doubles each attempt. Default 250ms. */
  baseDelayMs?: number;
  /** Ceiling on any single backoff. Default 4000ms. */
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
} as const;

/**
 * Error codes `quais` raises that reflect a deterministic outcome, not a blip.
 * Retrying these can only produce the same answer more slowly.
 */
const PERMANENT_CODES = new Set([
  'CALL_EXCEPTION', // the call reverted — deterministic
  'INVALID_ARGUMENT',
  'MISSING_ARGUMENT',
  'UNEXPECTED_ARGUMENT',
  'NOT_IMPLEMENTED',
  'UNSUPPORTED_OPERATION',
  'ACTION_REJECTED', // the user declined in their wallet
  'NONCE_EXPIRED',
  'INSUFFICIENT_FUNDS',
  'REPLACEMENT_UNDERPRICED',
  'TRANSACTION_REPLACED',
  'VALUE_MISMATCH',
]);

/** Codes that usually clear on their own. */
const TRANSIENT_CODES = new Set(['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 'BAD_DATA']);

/** Substrings seen in raw transport failures that carry no structured code. */
const TRANSIENT_PATTERNS = [
  'fetch failed',
  'econnreset',
  'econnrefused',
  'etimedout',
  'epipe',
  'socket hang up',
  'network error',
  'timeout',
  'timed out',
  'rate limit',
  'too many requests',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
  'temporarily unavailable',
  'connection terminated',
  'server error',
];

/** HTTP statuses worth another attempt. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as Record<string, unknown>;
  for (const key of ['status', 'statusCode']) {
    const value = e[key];
    if (typeof value === 'number') return value;
  }
  // quais nests the transport response under `info`
  const info = e.info as Record<string, unknown> | undefined;
  const response = info?.response as Record<string, unknown> | undefined;
  if (typeof response?.status === 'number') return response.status;
  return undefined;
}

/**
 * Whether an error is worth retrying.
 *
 * Errs toward *not* retrying: an unrecognised error is treated as permanent, so a
 * genuine bug surfaces immediately instead of being masked by three slow attempts.
 */
export function isTransient(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (PERMANENT_CODES.has(code)) return false;
    if (TRANSIENT_CODES.has(code)) return true;
  }

  const status = statusOf(error);
  if (status !== undefined) return TRANSIENT_STATUS.has(status);

  const message = error instanceof Error ? error.message : String(error);
  const haystack = message.toLowerCase();
  if (TRANSIENT_PATTERNS.some((p) => haystack.includes(p))) return true;

  // Unwrap one level — quais commonly wraps the transport error.
  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) return isTransient(cause);

  return false;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Run `fn`, retrying transient failures with exponential backoff and full jitter.
 *
 * Jitter matters more than usual here: several vaults refreshing on the same tick
 * would otherwise retry in lockstep and hammer a rate-limited endpoint in waves.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) throw new Error('Aborted');
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isTransient(error)) throw error;

      const ceiling = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delayMs = Math.round(Math.random() * ceiling);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, options.signal);
    }
  }

  throw lastError;
}
