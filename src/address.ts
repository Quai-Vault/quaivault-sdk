import { getAddress, getZoneForAddress, isAddress, isQiAddress } from 'quais';
import { ValidationError } from './errors/index.js';
import type { Address } from './types.js';

/**
 * Address validation for Quai's dual-ledger, sharded address space.
 *
 * Two independent properties are encoded in a Quai address:
 *
 * - **Zone** — the first byte (`0x00`–`0x02`, `0x10`–`0x12`, `0x20`–`0x22`). An address
 *   outside those ranges belongs to no shard and cannot hold state.
 * - **Ledger** — the 9th bit, i.e. the high bit of the *second* byte. Set means Qi (the
 *   UTXO ledger); clear means Quai (the EVM account ledger).
 *
 * They are genuinely orthogonal: `0x008111…` sits in zone `0x00` yet is a Qi address, so
 * a zone check alone is not enough.
 *
 * **Qi addresses cannot interact with smart contracts.** A Qi owner could never sign a
 * vault transaction, a Qi guardian could never approve a recovery, and native value sent
 * to one leaves the Quai ledger. The contracts do not check for this — `_addOwner` only
 * rejects the zero address, the vault itself and the module sentinel — so admitting one
 * permanently reduces the number of addresses able to reach the threshold, and enough of
 * them bricks the vault. The SDK therefore rejects Qi addresses wherever an address is
 * committed to a role or receives value.
 */

export type AddressLedger = 'quai' | 'qi';

export interface AddressCheck {
  valid: boolean;
  checksummed?: Address;
  /** Zone prefix, e.g. `0x00`. Absent when the address belongs to no shard. */
  zone?: string;
  ledger?: AddressLedger;
  reason?: string;
}

/** Inspect an address without throwing. */
export function inspectAddress(value: unknown): AddressCheck {
  if (typeof value !== 'string' || !isAddress(value)) {
    return { valid: false, reason: 'not a valid address' };
  }
  const checksummed = getAddress(value);
  const zone = getZoneForAddress(checksummed);
  const ledger: AddressLedger = isQiAddress(checksummed) ? 'qi' : 'quai';

  if (!zone) {
    return {
      valid: false,
      checksummed,
      ledger,
      reason: 'belongs to no Quai shard (its leading byte is not a valid zone prefix)',
    };
  }
  if (ledger === 'qi') {
    return {
      valid: false,
      checksummed,
      zone,
      ledger,
      reason: 'is a Qi-ledger address, which cannot interact with smart contracts on Quai',
    };
  }
  return { valid: true, checksummed, zone, ledger };
}

/** Whether an address is shard-valid and on the Quai ledger. */
export function isUsableQuaiAddress(value: unknown): boolean {
  return inspectAddress(value).valid;
}

/**
 * Assert an address can participate in Quai smart-contract calls, returning it
 * checksummed.
 *
 * Use for any address being committed to a role (owner, guardian, module, delegatecall
 * target) or receiving value. Do **not** use it for addresses being *removed* — a Qi
 * address that predates this check must still be removable — nor for read-only lookups,
 * where rejecting the query is less useful than answering it.
 */
export function assertQuaiAddress(value: unknown, label = 'address'): Address {
  const check = inspectAddress(value);
  if (check.valid) return check.checksummed as Address;

  const shown = typeof value === 'string' ? value : String(value);
  const remediation =
    check.ledger === 'qi'
      ? 'Qi is the UTXO ledger and has no contract execution. Use a Quai-ledger address ' +
        '(the 9th bit of the address — the high bit of its second byte — must be clear).'
      : 'Quai addresses must begin with a valid zone prefix: 0x00–0x02, 0x10–0x12, or 0x20–0x22.';

  throw new ValidationError(`Invalid ${label} "${shown}": it ${check.reason}.`, remediation);
}

/** Assert every address in a list, reporting the offending index. */
export function assertQuaiAddresses(values: readonly unknown[], label: string): Address[] {
  return values.map((value, i) => assertQuaiAddress(value, `${label}[${i}]`));
}
