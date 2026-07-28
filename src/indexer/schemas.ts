import { z } from 'zod';

/**
 * Row schemas for the indexer's Postgres tables.
 *
 * Mirrors quaivault-indexer/supabase/migrations/schema.sql. Parsing is strict on
 * shape but tolerant of added columns, so an indexer that ships new fields does not
 * break an older SDK.
 */

const address = z.string();
const nullableNumber = z.union([z.number(), z.string()]).nullable().optional();

export const WalletSchema = z.object({
  address: address,
  name: z.string().nullable().optional(),
  threshold: z.number(),
  owner_count: z.number(),
  created_at_block: z.union([z.number(), z.string()]),
  created_at_tx: z.string(),
  min_execution_delay: z.number().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});
export type WalletRow = z.infer<typeof WalletSchema>;

export const WalletOwnerSchema = z.object({
  wallet_address: address,
  owner_address: address,
  added_at_block: z.union([z.number(), z.string()]),
  added_at_tx: z.string(),
  removed_at_block: nullableNumber,
  removed_at_tx: z.string().nullable().optional(),
  is_active: z.boolean(),
});
export type WalletOwnerRow = z.infer<typeof WalletOwnerSchema>;

export const TransactionStatusEnum = z.enum([
  'pending',
  'executed',
  'cancelled',
  'expired',
  'failed',
]);

export const TransactionSchema = z.object({
  wallet_address: address,
  tx_hash: z.string(),
  to_address: address,
  value: z.string(),
  data: z.string().nullable().optional(),
  transaction_type: z.string(),
  decoded_params: z.unknown().nullable().optional(),
  status: TransactionStatusEnum,
  confirmation_count: z.number().nullable().optional(),
  submitted_by: address,
  submitted_at_block: z.union([z.number(), z.string()]),
  submitted_at_tx: z.string(),
  executed_at_block: nullableNumber,
  executed_at_tx: z.string().nullable().optional(),
  executed_by: z.string().nullable().optional(),
  cancelled_at_block: nullableNumber,
  cancelled_at_tx: z.string().nullable().optional(),
  expiration: z.union([z.number(), z.string()]).nullable().optional(),
  execution_delay: z.number().nullable().optional(),
  approved_at: z.union([z.number(), z.string()]).nullable().optional(),
  executable_after: z.union([z.number(), z.string()]).nullable().optional(),
  is_expired: z.boolean().nullable().optional(),
  failed_return_data: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});
export type TransactionRow = z.infer<typeof TransactionSchema>;

export const ConfirmationSchema = z.object({
  wallet_address: address,
  tx_hash: z.string(),
  owner_address: address,
  confirmed_at_block: z.union([z.number(), z.string()]),
  confirmed_at_tx: z.string(),
  revoked_at_block: nullableNumber,
  revoked_at_tx: z.string().nullable().optional(),
  is_active: z.boolean(),
});
export type ConfirmationRow = z.infer<typeof ConfirmationSchema>;

export const WalletModuleSchema = z.object({
  wallet_address: address,
  module_address: address,
  enabled_at_block: z.union([z.number(), z.string()]),
  enabled_at_tx: z.string(),
  disabled_at_block: nullableNumber,
  disabled_at_tx: z.string().nullable().optional(),
  is_active: z.boolean(),
});
export type WalletModuleRow = z.infer<typeof WalletModuleSchema>;

export const DelegatecallTargetSchema = z.object({
  wallet_address: address,
  target_address: address,
  added_at_block: z.union([z.number(), z.string()]),
  added_at_tx: z.string(),
  removed_at_block: nullableNumber,
  removed_at_tx: z.string().nullable().optional(),
  is_active: z.boolean(),
});
export type DelegatecallTargetRow = z.infer<typeof DelegatecallTargetSchema>;

export const DepositSchema = z.object({
  wallet_address: address,
  sender_address: address,
  amount: z.string(),
  deposited_at_block: z.union([z.number(), z.string()]),
  deposited_at_tx: z.string(),
  created_at: z.string().nullable().optional(),
});
export type DepositRow = z.infer<typeof DepositSchema>;

export const TokenSchema = z.object({
  address: address,
  standard: z.enum(['ERC20', 'ERC721', 'ERC1155']),
  symbol: z.string(),
  name: z.string(),
  decimals: z.number(),
  discovered_at_block: nullableNumber,
  discovered_via: z.string().nullable().optional(),
});
export type TokenRow = z.infer<typeof TokenSchema>;

export const TokenTransferSchema = z.object({
  token_address: address,
  wallet_address: address,
  from_address: address,
  to_address: address,
  value: z.string(),
  token_id: z.string().nullable().optional(),
  batch_index: z.number().nullable().optional(),
  direction: z.enum(['inflow', 'outflow']),
  block_number: z.union([z.number(), z.string()]),
  transaction_hash: z.string(),
  log_index: z.number(),
});
export type TokenTransferRow = z.infer<typeof TokenTransferSchema>;

export const SignedMessageSchema = z.object({
  wallet_address: address,
  msg_hash: z.string(),
  data: z.string().nullable().optional(),
  signed_at_block: z.union([z.number(), z.string()]),
  signed_at_tx: z.string(),
  unsigned_at_block: nullableNumber,
  unsigned_at_tx: z.string().nullable().optional(),
  is_active: z.boolean(),
});
export type SignedMessageRow = z.infer<typeof SignedMessageSchema>;

export const IndexerStateSchema = z.object({
  id: z.string(),
  last_indexed_block: z.union([z.number(), z.string()]),
  last_block_hash: z.string().nullable().optional(),
  last_indexed_at: z.string().nullable().optional(),
  is_syncing: z.boolean().nullable().optional(),
});
export type IndexerStateRow = z.infer<typeof IndexerStateSchema>;

export const RecoveryConfigSchema = z.object({
  wallet_address: address,
  threshold: z.number(),
  recovery_period: z.union([z.number(), z.string()]),
  setup_at_block: z.union([z.number(), z.string()]),
  setup_at_tx: z.string(),
  is_active: z.boolean(),
});
export type RecoveryConfigRow = z.infer<typeof RecoveryConfigSchema>;

export const RecoveryGuardianSchema = z.object({
  wallet_address: address,
  guardian_address: address,
  added_at_block: z.union([z.number(), z.string()]),
  added_at_tx: z.string(),
  is_active: z.boolean(),
});
export type RecoveryGuardianRow = z.infer<typeof RecoveryGuardianSchema>;

export const RecoverySchema = z.object({
  wallet_address: address,
  recovery_hash: z.string(),
  new_owners: z.array(address),
  new_threshold: z.number(),
  initiator_address: address,
  approval_count: z.number().nullable().optional(),
  required_threshold: z.number(),
  execution_time: z.union([z.number(), z.string()]),
  status: z.enum(['pending', 'executed', 'cancelled', 'invalidated', 'expired']),
  initiated_at_block: z.union([z.number(), z.string()]),
  initiated_at_tx: z.string(),
  expiration: z.union([z.number(), z.string()]).nullable().optional(),
});
export type RecoveryRow = z.infer<typeof RecoverySchema>;

export const RecoveryApprovalSchema = z.object({
  wallet_address: address,
  recovery_hash: z.string(),
  guardian_address: address,
  approved_at_block: z.union([z.number(), z.string()]),
  approved_at_tx: z.string(),
  is_active: z.boolean(),
});
export type RecoveryApprovalRow = z.infer<typeof RecoveryApprovalSchema>;

/** Coerce the bigint-ish columns Postgres returns as strings. */
export function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : fallback;
}
