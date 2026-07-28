import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import type { IndexerConfig, IndexerHealth } from '../types.js';
import { IndexerQueryError } from '../errors/index.js';
import { IndexerStateSchema, toNumber } from './schemas.js';

const SDK_VERSION = '0.1.0';

/**
 * The indexer uses one Postgres schema per network, chosen at runtime, so the
 * client cannot be pinned to supabase-js's default `"public"` schema generic.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any, any, any>;

/**
 * Thin wrapper over the indexer's Supabase project.
 *
 * The anon key is a public read-only credential: the indexer's RLS grants `anon`
 * SELECT on every table and nothing else, with all writes reserved for
 * `service_role`. It carries no authority beyond reading already-public chain data.
 */
export class IndexerClient {
  readonly config: IndexerConfig;
  private readonly client: AnySupabaseClient;
  private healthCache: { value: IndexerHealth; at: number } | null = null;
  private inflightHealth: Promise<IndexerHealth> | null = null;

  /** Health results are reused for this long to keep read paths cheap. */
  readonly healthCacheMs: number;

  constructor(config: IndexerConfig, options: { healthCacheMs?: number } = {}) {
    this.config = config;
    this.healthCacheMs = options.healthCacheMs ?? 5_000;
    this.client = createClient(config.url, config.anonKey, {
      db: { schema: config.schema },
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-client-info': `quaivault-sdk/${SDK_VERSION}` } },
    });
  }

  /** Raw Supabase client, for queries the SDK does not wrap. */
  get raw(): AnySupabaseClient {
    return this.client;
  }

  from(table: string) {
    return this.client.from(table);
  }

  /**
   * Run a query, parse each row, and surface failures as `IndexerQueryError`.
   *
   * No retry wrapper here on purpose. `postgrest-js` already retries GET/HEAD/OPTIONS
   * internally (3 attempts, retryable statuses and fetch errors, honouring
   * `Retry-After`), and it reports failures as a resolved `{ error }` value rather
   * than a rejection — so an outer `withRetry` would be dead code that silently
   * multiplied attempts if it were ever made to work. Chain reads, which do reject,
   * are retried in `src/chain/retry.ts`.
   */
  async select<S extends z.ZodTypeAny>(
    table: string,
    schema: S,
    build: (q: ReturnType<AnySupabaseClient["from"]>) => PromiseLike<{
      data: unknown[] | null;
      error: { message: string; code?: string } | null;
    }>,
  ): Promise<Array<z.infer<S>>> {
    const { data, error } = await build(this.client.from(table));
    if (error) {
      throw new IndexerQueryError(`Indexer query on "${table}" failed: ${error.message}`, error);
    }
    return (data ?? []).map((row) => schema.parse(row) as z.infer<S>);
  }

  /** Single-row variant. Returns null for PostgREST's "no rows" code. */
  async selectOne<S extends z.ZodTypeAny>(
    table: string,
    schema: S,
    build: (q: ReturnType<AnySupabaseClient["from"]>) => PromiseLike<{
      data: unknown | null;
      error: { message: string; code?: string } | null;
    }>,
  ): Promise<z.infer<S> | null> {
    const { data, error } = await build(this.client.from(table));
    if (error) {
      if (error.code === 'PGRST116') return null; // no rows matched
      throw new IndexerQueryError(`Indexer query on "${table}" failed: ${error.message}`, error);
    }
    return data === null ? null : (schema.parse(data) as z.infer<S>);
  }

  /** The indexer's sync head, straight from the `indexer_state` table. */
  async state(): Promise<{ lastIndexedBlock: number; isSyncing: boolean } | null> {
    const row = await this.selectOne('indexer_state', IndexerStateSchema, (q) =>
      q.select('*').eq('id', 'main').single(),
    );
    if (!row) return null;
    return {
      lastIndexedBlock: toNumber(row.last_indexed_block),
      isSyncing: row.is_syncing ?? false,
    };
  }

  /**
   * Liveness and lag. Prefers the HTTP health endpoint (which knows the chain head)
   * and falls back to the `indexer_state` table when it is unreachable.
   */
  async health(force = false): Promise<IndexerHealth> {
    const now = Date.now();
    if (!force && this.healthCache && now - this.healthCache.at < this.healthCacheMs) {
      return this.healthCache.value;
    }
    if (this.inflightHealth) return this.inflightHealth;

    this.inflightHealth = this.probeHealth()
      .then((value) => {
        this.healthCache = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        this.inflightHealth = null;
      });

    return this.inflightHealth;
  }

  /**
   * Block until the indexer has processed `blockNumber`.
   *
   * Closes the write-then-read race: a transaction confirmed at block N is not
   * queryable until the indexer reaches N, so `propose()` immediately followed by
   * `pendingTransactions()` will silently miss it. Await this in between.
   *
   * Resolves immediately when the head is already at or past the target.
   */
  async waitForBlock(
    blockNumber: number,
    options: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ reached: boolean; lastIndexedBlock: number }> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1_500;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (options.signal?.aborted) throw new Error('Aborted');

      // Bypass the health cache: a stale hit would add a needless poll interval.
      const state = await this.state();
      const head = state?.lastIndexedBlock ?? 0;
      if (head >= blockNumber) return { reached: true, lastIndexedBlock: head };

      if (Date.now() + pollIntervalMs > deadline) {
        return { reached: false, lastIndexedBlock: head };
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  private async probeHealth(): Promise<IndexerHealth> {
    if (this.config.healthUrl) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        const res = await fetch(new URL('/health', this.config.healthUrl), {
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));

        const body = (await res.json()) as {
          status?: string;
          details?: {
            currentBlock?: number;
            lastIndexedBlock?: number;
            blocksBehind?: number;
            isSyncing?: boolean;
          };
        };
        const d = body.details ?? {};
        return {
          available: res.ok && body.status === 'healthy',
          lastIndexedBlock: d.lastIndexedBlock ?? 0,
          chainHead: d.currentBlock,
          blocksBehind: d.blocksBehind,
          isSyncing: d.isSyncing ?? false,
          ...(res.ok ? {} : { error: `health endpoint returned ${res.status}` }),
        };
      } catch {
        // Fall through to the database probe — a dead health server does not imply
        // a dead indexer, and reads go to Supabase anyway.
      }
    }

    try {
      const state = await this.state();
      if (!state) {
        return { available: false, lastIndexedBlock: 0, isSyncing: false, error: 'no indexer_state row' };
      }
      return {
        available: true,
        lastIndexedBlock: state.lastIndexedBlock,
        isSyncing: state.isSyncing,
      };
    } catch (err) {
      return {
        available: false,
        lastIndexedBlock: 0,
        isSyncing: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
