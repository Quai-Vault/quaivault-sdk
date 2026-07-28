import type { RealtimeChannel } from '@supabase/realtime-js';
import { isAddress } from 'quais';
import type { IndexerClient } from './client.js';
import { ValidationError } from '../errors/index.js';
import type { Address } from '../types.js';

/** Indexer tables a vault subscription can follow. */
export type WatchTopic =
  | 'transactions'
  | 'confirmations'
  | 'owners'
  | 'modules'
  | 'deposits'
  | 'tokenTransfers'
  | 'recoveries'
  | 'signedMessages';

const TABLE_FOR: Record<WatchTopic, string> = {
  transactions: 'transactions',
  confirmations: 'confirmations',
  owners: 'wallet_owners',
  modules: 'wallet_modules',
  deposits: 'deposits',
  tokenTransfers: 'token_transfers',
  recoveries: 'social_recoveries',
  signedMessages: 'signed_messages',
};

export interface WatchEvent {
  topic: WatchTopic;
  table: string;
  /** Postgres operation that produced the event. */
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  /** Row after the change. Absent for DELETE. */
  row: Record<string, unknown> | null;
  /** Row before the change, when the table's replica identity provides it. */
  previous: Record<string, unknown> | null;
}

export interface WatchOptions {
  topics?: WatchTopic[];
  /** Called on subscription lifecycle changes, so callers can surface reconnects. */
  onStatus?: (status: string, error?: Error) => void;
}

/** Handle returned by {@link watchVault}. Call `unsubscribe` to release the channel. */
export interface Subscription {
  unsubscribe(): Promise<void>;
  readonly topics: WatchTopic[];
}

const DEFAULT_TOPICS: WatchTopic[] = ['transactions', 'confirmations', 'owners'];

/**
 * Follow indexer changes for one vault over Supabase Realtime.
 *
 * All topics share a single channel — one WebSocket per vault rather than one per
 * table, which matters because Realtime caps concurrent channels per client.
 *
 * Realtime delivers *indexer* writes, so events arrive only after the indexer has
 * processed the block. It is a change feed, not a chain subscription: use it to know
 * when to re-read, and re-read through `Vault` so approval counts stay correct.
 */
export function watchVault(
  client: IndexerClient,
  vault: Address,
  handler: (event: WatchEvent) => void,
  options: WatchOptions = {},
): Subscription {
  // The address is interpolated into a PostgREST filter string, so validate it here
  // rather than trusting the caller — this function is exported, not just reached
  // through `Vault.watch()` where the address is already checked.
  if (!isAddress(vault)) {
    throw new ValidationError(`Invalid vault address for subscription: "${vault}".`);
  }
  const topics = options.topics ?? DEFAULT_TOPICS;
  const address = vault.toLowerCase();
  const schema = client.config.schema;

  // Channel names must be unique per client; include the vault so two handles on
  // different vaults do not collide.
  const channel: RealtimeChannel = client.channel(`quaivault:${schema}:${address}`);

  for (const topic of topics) {
    const table = TABLE_FOR[topic];
    channel.on(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'postgres_changes' as any,
      {
        event: '*',
        schema,
        table,
        // Every watched table keys the vault on wallet_address.
        filter: `wallet_address=eq.${address}`,
      },
      (payload: {
        eventType: 'INSERT' | 'UPDATE' | 'DELETE';
        new: Record<string, unknown> | null;
        old: Record<string, unknown> | null;
      }) => {
        handler({
          topic,
          table,
          type: payload.eventType,
          row: payload.new && Object.keys(payload.new).length > 0 ? payload.new : null,
          previous: payload.old && Object.keys(payload.old).length > 0 ? payload.old : null,
        });
      },
    );
  }

  channel.subscribe((status, err) => {
    options.onStatus?.(status, err instanceof Error ? err : undefined);
  });

  return {
    topics,
    async unsubscribe() {
      await client.removeChannel(channel);
    },
  };
}
