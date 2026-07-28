import { PostgrestClient } from '@supabase/postgrest-js';
import { RealtimeClient, type RealtimeChannel } from '@supabase/realtime-js';
import type { z } from 'zod';
import type { IndexerConfig, IndexerHealth, Page } from '../types.js';
import { AbortError, IndexerQueryError } from '../errors/index.js';
import { IndexerStateSchema, toNumber } from './schemas.js';

/** Replaced at build time by tsup's `define`; absent when running from source. */
declare const __SDK_VERSION__: string | undefined;

const SDK_VERSION = typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : 'dev';

/**
 * The indexer uses one Postgres schema per network, chosen at runtime, so the client
 * cannot be pinned to postgrest-js's default `"public"` schema generic.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPostgrestClient = PostgrestClient<any, any, any>;

/**
 * Thin wrapper over the indexer's Supabase project.
 *
 * Built on `@supabase/postgrest-js` and `@supabase/realtime-js` directly rather than
 * the `@supabase/supabase-js` umbrella. The umbrella's constructor instantiates auth,
 * storage and functions clients unconditionally, so no bundler can shake them out —
 * and this SDK uses none of the three. Going direct costs 57 KB → 22 KB gzip, and the
 * only thing given up is `createClient`'s URL and header wiring, reproduced below.
 *
 * The anon key is a public read-only credential: the indexer's RLS grants `anon`
 * SELECT on every table and nothing else, with all writes reserved for
 * `service_role`. It carries no authority beyond reading already-public chain data.
 */
export class IndexerClient {
  readonly config: IndexerConfig;
  private readonly client: AnyPostgrestClient;
  private realtime: RealtimeClient | null = null;
  private healthCache: { value: IndexerHealth; at: number } | null = null;
  private inflightHealth: Promise<IndexerHealth> | null = null;

  /**
   * Health results are reused for this long to keep read paths cheap.
   *
   * This and `waitForBlock`'s deadline are elapsed-time arithmetic, so they use the
   * raw local clock rather than `ClientOptions.now` — see the note in `chain/retry.ts`.
   */
  readonly healthCacheMs: number;

  constructor(config: IndexerConfig, options: { healthCacheMs?: number } = {}) {
    this.config = config;
    this.healthCacheMs = options.healthCacheMs ?? 5_000;

    // What `createClient` does for the REST half. Both headers are required: PostgREST
    // authenticates on `apikey`, while the `Authorization` bearer is what selects the
    // `anon` role the RLS policies are written against.
    this.client = new PostgrestClient(`${baseUrl(config.url)}/rest/v1`, {
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        'x-client-info': `quaivault-sdk/${SDK_VERSION}`,
      },
      schema: config.schema,
    }) as AnyPostgrestClient;
  }

  /** The PostgREST client, for queries the SDK does not wrap. */
  get rest(): AnyPostgrestClient {
    return this.client;
  }

  from(table: string) {
    return this.client.from(table);
  }

  /**
   * Realtime client, constructed on first use.
   *
   * Lazy because it opens a WebSocket and starts a heartbeat, and the large majority
   * of SDK usage never calls `watch()`. Nothing here should cost a socket unless
   * somebody asked to follow a vault.
   */
  private realtimeClient(): RealtimeClient {
    if (!this.realtime) {
      this.realtime = new RealtimeClient(
        `${baseUrl(this.config.url).replace(/^http/, 'ws')}/realtime/v1`,
        { params: { apikey: this.config.anonKey } },
      );
    }
    return this.realtime;
  }

  /** Open a Realtime channel. See `watchVault`, which is what callers should use. */
  channel(name: string): RealtimeChannel {
    return this.realtimeClient().channel(name);
  }

  /** Close a channel opened by {@link channel}. */
  async removeChannel(channel: RealtimeChannel): Promise<void> {
    await this.realtimeClient().removeChannel(channel);
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
    build: (q: ReturnType<AnyPostgrestClient["from"]>) => PromiseLike<{
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

  /**
   * Paged select: an exact `hasMore`, an approximate `total`.
   *
   * Both halves of that are deliberate. An `exact` count makes Postgres scan every
   * matching row on every page request, which is invisible on a young vault and
   * quadratic on a busy one — so the count is `estimated`, cheap and good enough for
   * "roughly how much history is there".
   *
   * But `hasMore` derived from an estimate would be a lie a caller can act on: a
   * paging loop that stops early drops real rows. So callers request one row beyond
   * the page and this trims it, which answers "is there another page" exactly, for
   * the cost of a single extra row.
   */
  async selectPage<S extends z.ZodTypeAny>(
    table: string,
    schema: S,
    limit: number,
    build: (q: ReturnType<AnyPostgrestClient['from']>) => PromiseLike<{
      data: unknown[] | null;
      error: { message: string; code?: string } | null;
      count?: number | null;
    }>,
  ): Promise<Page<z.infer<S>>> {
    const { data, error, count } = await build(this.client.from(table));
    if (error) {
      throw new IndexerQueryError(`Indexer query on "${table}" failed: ${error.message}`, error);
    }

    const rows = data ?? [];
    const hasMore = rows.length > limit;
    const parsed = (hasMore ? rows.slice(0, limit) : rows).map(
      (row) => schema.parse(row) as z.infer<S>,
    );

    return {
      data: parsed,
      // Never report a total below what was just handed out, however the estimate lands.
      total: Math.max(count ?? 0, parsed.length),
      hasMore,
    };
  }

  /** Single-row variant. Returns null for PostgREST's "no rows" code. */
  async selectOne<S extends z.ZodTypeAny>(
    table: string,
    schema: S,
    build: (q: ReturnType<AnyPostgrestClient["from"]>) => PromiseLike<{
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
      if (options.signal?.aborted) throw new AbortError('Waiting for the indexer');

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
      // One deadline covering headers *and* body. Clearing the timer as soon as
      // `fetch` resolved would leave `res.json()` unbounded, and a server that
      // answers its headers promptly then stalls the body would hang every `auto`
      // read behind it — `health()` gates them all.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetch(new URL('/health', this.config.healthUrl), {
          signal: controller.signal,
        });

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
      } finally {
        clearTimeout(timer);
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

/**
 * Normalise a project URL to a base with no trailing slash.
 *
 * `new URL('rest/v1', base)` — what supabase-js uses — silently replaces the last path
 * segment when the base carries a path, so a self-hosted indexer mounted under a
 * prefix would get the wrong endpoint. Concatenation is blunter and correct.
 */
function baseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}
