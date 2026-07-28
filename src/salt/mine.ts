import { getCreate2Address, hexlify, isQuaiAddress, keccak256, randomBytes, solidityPacked } from 'quais';
import type { Address, Bytes32, CreateVaultParams, MinedSalt } from '../types.js';
import { SaltMiningError } from '../errors/index.js';
import { computeBytecodeHash, encodeInitData, shardPrefixOf } from './predict.js';

export interface MineSaltOptions {
  factory: Address;
  implementation: Address;
  /** Address that will call `createWallet`. The mined address lands on its shard. */
  deployer: Address;
  params: CreateVaultParams;
  /** Override the target shard prefix. Defaults to the deployer's. */
  targetPrefix?: string;
  maxAttempts?: number;
  /** Abort after this long. Default 120_000 ms. */
  timeoutMs?: number;
  /** Called roughly every 1000 attempts. */
  onProgress?: (attempts: number) => void;
  signal?: AbortSignal;
}

export interface MiningStrategy {
  readonly name: string;
  mine(options: Required<Pick<MineSaltOptions, 'factory' | 'deployer'>> & ResolvedMineJob): Promise<MinedSalt>;
}

/** Everything the inner loop needs, precomputed once. */
export interface ResolvedMineJob {
  bytecodeHash: Bytes32;
  targetPrefix: string;
  maxAttempts: number;
  timeoutMs: number;
  onProgress?: (attempts: number) => void;
  signal?: AbortSignal;
}

const DEFAULT_MAX_ATTEMPTS = 500_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const PROGRESS_INTERVAL = 1_000;
/** Attempts per synchronous chunk before yielding to the event loop. */
const CHUNK = 250;

function tryOne(
  factory: Address,
  deployer: Address,
  bytecodeHash: Bytes32,
  targetPrefix: string,
): { salt: Bytes32; address: Address } | null {
  const salt = hexlify(randomBytes(32));
  const fullSalt = keccak256(solidityPacked(['address', 'bytes32'], [deployer, salt]));
  const address = getCreate2Address(factory, fullSalt, bytecodeHash);

  if (address.toLowerCase().startsWith(targetPrefix) && isQuaiAddress(address)) {
    return { salt, address };
  }
  return null;
}

/**
 * Chunked single-threaded miner. Yields to the event loop between chunks so it does
 * not block a browser UI thread or a Node server's other work.
 *
 * Works everywhere, which makes it the safe default.
 */
export const syncStrategy: MiningStrategy = {
  name: 'sync',
  async mine({ factory, deployer, bytecodeHash, targetPrefix, maxAttempts, timeoutMs, onProgress, signal }) {
    const startedAt = Date.now();

    for (let attempts = 0; attempts < maxAttempts; ) {
      if (signal?.aborted) throw new SaltMiningError('Salt mining was aborted.');
      if (Date.now() - startedAt > timeoutMs) {
        throw new SaltMiningError(
          `Salt mining timed out after ${timeoutMs} ms (${attempts} attempts).`,
          'Raise timeoutMs, or use the worker_threads strategy on Node for more throughput.',
        );
      }

      const chunkEnd = Math.min(attempts + CHUNK, maxAttempts);
      for (; attempts < chunkEnd; attempts++) {
        const hit = tryOne(factory, deployer, bytecodeHash, targetPrefix);
        if (hit) {
          return {
            salt: hit.salt,
            predictedAddress: hit.address,
            attempts: attempts + 1,
            durationMs: Date.now() - startedAt,
          };
        }
        if ((attempts + 1) % PROGRESS_INTERVAL === 0) onProgress?.(attempts + 1);
      }

      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    throw new SaltMiningError(
      `No valid salt found for prefix ${targetPrefix} after ${maxAttempts} attempts.`,
      'Raise maxAttempts, or confirm the deployer address is on the shard you expect.',
    );
  },
};

/**
 * Node-only multi-core miner. Falls back to {@link syncStrategy} when
 * `node:worker_threads` is unavailable (browsers, restricted runtimes).
 */
export const workerThreadsStrategy: MiningStrategy = {
  name: 'worker_threads',
  async mine(job) {
    let Worker: typeof import('node:worker_threads').Worker;
    let availableParallelism: () => number;
    try {
      ({ Worker } = await import('node:worker_threads'));
      const os = await import('node:os');
      availableParallelism = os.availableParallelism ?? (() => os.cpus().length);
    } catch {
      return syncStrategy.mine(job);
    }

    const { factory, deployer, bytecodeHash, targetPrefix, maxAttempts, timeoutMs, onProgress, signal } = job;
    const workerCount = Math.max(1, Math.min(8, availableParallelism() - 1));
    const perWorker = Math.ceil(maxAttempts / workerCount);
    const startedAt = Date.now();

    // Inlined worker source keeps the package free of a separate entry file, so it
    // works the same whether consumed from source, from dist, or through a bundler.
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { getCreate2Address, hexlify, isQuaiAddress, keccak256, randomBytes, solidityPacked } = require('quais');
      const { factory, deployer, bytecodeHash, targetPrefix, maxAttempts } = workerData;
      for (let i = 0; i < maxAttempts; i++) {
        const salt = hexlify(randomBytes(32));
        const fullSalt = keccak256(solidityPacked(['address', 'bytes32'], [deployer, salt]));
        const address = getCreate2Address(factory, fullSalt, bytecodeHash);
        if (address.toLowerCase().startsWith(targetPrefix) && isQuaiAddress(address)) {
          parentPort.postMessage({ type: 'result', salt, address, attempts: i + 1 });
          return;
        }
        if ((i + 1) % ${PROGRESS_INTERVAL} === 0) parentPort.postMessage({ type: 'progress', attempts: i + 1 });
      }
      parentPort.postMessage({ type: 'exhausted', attempts: maxAttempts });
    `;

    return new Promise<MinedSalt>((resolve, reject) => {
      const workers: Array<InstanceType<typeof Worker>> = [];
      let settled = false;
      let exhausted = 0;
      let totalAttempts = 0;
      const progressByWorker = new Array<number>(workerCount).fill(0);

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        for (const w of workers) void w.terminate();
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const timer = setTimeout(
        () =>
          settle(() =>
            reject(
              new SaltMiningError(
                `Salt mining timed out after ${timeoutMs} ms (~${totalAttempts} attempts across ${workerCount} workers).`,
                'Raise timeoutMs or maxAttempts.',
              ),
            ),
          ),
        timeoutMs,
      );

      const onAbort = () => settle(() => reject(new SaltMiningError('Salt mining was aborted.')));
      signal?.addEventListener('abort', onAbort, { once: true });

      for (let i = 0; i < workerCount; i++) {
        const worker = new Worker(workerSource, {
          eval: true,
          workerData: { factory, deployer, bytecodeHash, targetPrefix, maxAttempts: perWorker },
        });
        workers.push(worker);

        worker.on('message', (msg: { type: string; salt?: string; address?: string; attempts?: number }) => {
          if (msg.type === 'progress') {
            progressByWorker[i] = msg.attempts ?? 0;
            totalAttempts = progressByWorker.reduce((a, b) => a + b, 0);
            onProgress?.(totalAttempts);
          } else if (msg.type === 'result') {
            settle(() =>
              resolve({
                salt: msg.salt as Bytes32,
                predictedAddress: msg.address as Address,
                attempts: totalAttempts + (msg.attempts ?? 0),
                durationMs: Date.now() - startedAt,
              }),
            );
          } else if (msg.type === 'exhausted') {
            if (++exhausted === workerCount) {
              settle(() =>
                reject(
                  new SaltMiningError(
                    `No valid salt found for prefix ${targetPrefix} after ${maxAttempts} attempts.`,
                    'Raise maxAttempts, or confirm the deployer address is on the shard you expect.',
                  ),
                ),
              );
            }
          }
        });

        worker.on('error', (err) =>
          settle(() => reject(new SaltMiningError(`Salt mining worker failed: ${err.message}`))),
        );
      }
    });
  },
};

/** Prefer worker_threads on Node; the sync miner degrades gracefully everywhere else. */
export function defaultStrategy(): MiningStrategy {
  const hasNode =
    typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node ===
    'string';
  return hasNode ? workerThreadsStrategy : syncStrategy;
}

/**
 * Mine a CREATE2 salt that deploys a vault onto the deployer's Quai shard.
 *
 * The predicted address is a pure function of (factory, implementation, deployer,
 * salt, create params) — so the caller can mine ahead of time, persist the salt,
 * and deploy later, as long as every one of those inputs is unchanged.
 */
export async function mineSalt(
  options: MineSaltOptions,
  strategy: MiningStrategy = defaultStrategy(),
): Promise<MinedSalt> {
  const targetPrefix = (options.targetPrefix ?? shardPrefixOf(options.deployer)).toLowerCase();
  const initData = encodeInitData(options.params);
  const bytecodeHash = computeBytecodeHash(options.implementation, initData);

  return strategy.mine({
    factory: options.factory,
    deployer: options.deployer,
    bytecodeHash,
    targetPrefix,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onProgress: options.onProgress,
    signal: options.signal,
  });
}
