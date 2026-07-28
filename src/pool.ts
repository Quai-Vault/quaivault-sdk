/**
 * Map with a bounded number of in-flight promises, preserving input order.
 *
 * A plain `Promise.all` over a fan-out the caller does not control is a liability:
 * `balances()` can reach `maxTokens × maxTokenIdChecks` — 5,000 with the defaults —
 * concurrent RPC reads from one call, and a batched transaction read fans out over
 * however many hashes the caller passed. Public endpoints rate-limit long before
 * either, and the failures come back as transient errors on reads that would each
 * have succeeded on their own.
 *
 * Rejections propagate: the first failure rejects the whole call, matching
 * `Promise.all`. Callers that want per-item tolerance catch inside `fn`.
 */
export async function mapPooled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      // Safe: the bound check above proves the index is in range.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      results[i] = await fn(items[i]!, i);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Default ceiling on concurrent chain reads issued by one SDK call. */
export const DEFAULT_CONCURRENCY = 8;
