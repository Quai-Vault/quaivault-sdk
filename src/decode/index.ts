import { Interface, formatQuai, getBytes } from 'quais';
import { interfaces } from '../encode/index.js';
import type {
  AbiLookup,
  AbiSource,
  Address,
  DecodedCall,
  Hex,
  TransactionKind,
} from '../types.js';
import type { InterfaceAbi } from 'quais';

export interface DecodeContext {
  /** The vault the transaction belongs to — used to detect self-calls. */
  vault: Address;
  to: Address;
  value: bigint;
  data: Hex;
  /** Known module addresses, for classifying `module_config` calls. */
  socialRecovery?: Address;
  multiSendCallOnly?: Address;
  /**
   * ABIs for contracts the SDK does not ship, keyed by address. See {@link AbiLookup}.
   *
   * Consulted only after every built-in match has failed, and only for the exact `to`
   * address — so a supplied ABI can add detail the SDK lacks but can never override how
   * a vault self-call or a known module call is read.
   */
  abis?: AbiLookup;
}

export interface DecodeResult {
  kind: TransactionKind;
  decoded?: DecodedCall;
  summary: string;
  /** Provenance of the ABI behind this result. See {@link AbiSource}. */
  abiSource: AbiSource;
}

const SELF_CALL_ADMIN = new Set([
  'addOwner',
  'removeOwner',
  'changeThreshold',
  'enableModule',
  'disableModule',
  'cancelByConsensus',
  'setMinExecutionDelay',
  'addDelegatecallTarget',
  'removeDelegatecallTarget',
]);

const MESSAGE_SIGNING = new Set(['signMessage', 'unsignMessage']);

function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function formatDuration(seconds: number): string {
  if (seconds === 0) return 'none';
  const units: Array<[number, string]> = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, label] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${label}${n === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} seconds`;
}

function namedArgs(fragmentInputs: ReadonlyArray<{ name: string }>, args: readonly unknown[]) {
  const out: Record<string, unknown> = {};
  fragmentInputs.forEach((input, i) => {
    out[input.name || `arg${i}`] = args[i];
  });
  return out;
}

/**
 * Classify and describe a proposed vault transaction from its calldata.
 *
 * Resolution order matters: self-calls are checked against the vault ABI first,
 * because several vault selectors would otherwise be ambiguous with token calls.
 */
export function decodeCall(ctx: DecodeContext): DecodeResult {
  const { vault, to, value, data } = ctx;
  const isSelfCall = to.toLowerCase() === vault.toLowerCase();
  const hasData = typeof data === 'string' && data !== '0x' && data.length > 2;

  if (!hasData) {
    return {
      kind: 'transfer',
      summary: `Transfer ${formatQuai(value)} QUAI to ${short(to)}`,
      // No ABI involved — a bare value transfer is fully described by its own fields.
      abiSource: 'builtin',
    };
  }

  // --- vault self-calls
  if (isSelfCall) {
    const parsed = tryParse(interfaces.vault, data);
    if (parsed) {
      const decoded: DecodedCall = {
        name: parsed.name,
        signature: parsed.signature,
        args: parsed.args,
        target: 'vault',
        selector: parsed.selector,
      };
      if (MESSAGE_SIGNING.has(parsed.name)) {
        return {
          kind: 'message_signing',
          decoded,
          summary:
            parsed.name === 'signMessage'
              ? 'Sign a message on behalf of the vault (EIP-1271)'
              : 'Revoke a previously signed message (EIP-1271)',
          abiSource: 'builtin',
        };
      }
      if (SELF_CALL_ADMIN.has(parsed.name)) {
        return {
          kind: 'wallet_admin',
          decoded,
          summary: describeAdmin(parsed.name, parsed.args),
          abiSource: 'builtin',
        };
      }
      return {
        kind: 'wallet_admin',
        decoded,
        summary: `Vault self-call: ${parsed.name}`,
        abiSource: 'builtin',
      };
    }
  }

  // --- social recovery module
  if (ctx.socialRecovery && to.toLowerCase() === ctx.socialRecovery.toLowerCase()) {
    const parsed = tryParse(interfaces.recovery, data);
    if (parsed) {
      const decoded: DecodedCall = { ...parsed, target: 'socialRecovery' };
      if (parsed.name === 'setupRecovery') {
        const guardians = parsed.args.guardians as unknown[] | undefined;
        const threshold = parsed.args.threshold;
        return {
          kind: 'recovery_setup',
          decoded,
          summary: `Configure social recovery: ${guardians?.length ?? '?'} guardians, ${String(
            threshold ?? '?',
          )} required`,
          abiSource: 'builtin',
        };
      }
      return {
        kind: 'module_config',
        decoded,
        summary: `Social recovery: ${parsed.name}`,
        abiSource: 'builtin',
      };
    }
  }

  // --- MultiSend batch
  if (ctx.multiSendCallOnly && to.toLowerCase() === ctx.multiSendCallOnly.toLowerCase()) {
    const parsed = tryParse(interfaces.multiSend, data);
    if (parsed?.name === 'multiSend') {
      const inner = decodeMultiSendPayload(parsed.args.transactions as Hex);
      return {
        kind: 'batched_call',
        decoded: { ...parsed, target: 'multiSend' },
        summary: `Batched call: ${inner.length} sub-transaction${inner.length === 1 ? '' : 's'}`,
        abiSource: 'builtin',
      };
    }
  }

  // --- module execution via Zodiac
  const asVault = tryParse(interfaces.vault, data);
  if (asVault?.name.startsWith('execTransactionFromModule')) {
    return {
      kind: 'module_execution',
      decoded: { ...asVault, target: 'vault' },
      summary: `Module execution against ${short(String(asVault.args.to ?? to))}`,
      abiSource: 'builtin',
    };
  }

  // --- caller-supplied ABI for this exact address
  //
  // Placed ahead of the token heuristics below because it is better evidence. Those
  // heuristics identify a call by selector shape alone and will happily read any
  // contract exposing `transfer(address,uint256)` as an ERC20. A caller who has told us
  // *which contract this address is* has said something the selector cannot.
  //
  // Still behind the built-ins: a supplied ABI must never change how a vault self-call
  // or a known module call is read.
  const supplied = toInterface(lookup(ctx.abis, to));
  if (supplied) {
    const parsed = tryParse(supplied, data);
    if (parsed) {
      return {
        kind: 'external_call',
        decoded: { ...parsed, target: 'external' },
        summary:
          `Call ${parsed.name} on ${short(to)}` +
          (value > 0n ? ` with ${formatQuai(value)} QUAI` : ''),
        abiSource: 'supplied',
      };
    }
  }

  // --- token standards
  const erc20 = tryParse(interfaces.erc20, data);
  if (erc20 && ['transfer', 'approve', 'transferFrom'].includes(erc20.name)) {
    return {
      kind: 'erc20_transfer',
      decoded: { ...erc20, target: 'erc20' },
      summary: describeErc20(erc20.name, erc20.args, to),
      abiSource: 'builtin',
    };
  }

  const erc1155 = tryParse(interfaces.erc1155, data);
  if (erc1155 && erc1155.name.startsWith('safe')) {
    return {
      kind: 'erc1155_transfer',
      decoded: { ...erc1155, target: 'erc1155' },
      summary:
        erc1155.name === 'safeBatchTransferFrom'
          ? `Transfer a batch of ERC1155 tokens from ${short(to)}`
          : `Transfer ERC1155 token #${String(erc1155.args.id ?? '?')} from ${short(to)}`,
      abiSource: 'builtin',
    };
  }

  const erc721 = tryParse(interfaces.erc721, data);
  if (erc721 && erc721.name === 'safeTransferFrom') {
    return {
      kind: 'erc721_transfer',
      decoded: { ...erc721, target: 'erc721' },
      summary: `Transfer NFT #${String(erc721.args.tokenId ?? '?')} to ${short(
        String(erc721.args.to ?? '?'),
      )}`,
      abiSource: 'builtin',
    };
  }

  const selector = data.slice(0, 10);
  return {
    kind: 'external_call',
    summary:
      `Call ${short(to)} (selector ${selector})` +
      (value > 0n ? ` with ${formatQuai(value)} QUAI` : ''),
    // Nothing matched. Saying so beats guessing: an honest "unknown" is a weaker claim
    // than a wrong one, and a reviewer can act on the difference.
    abiSource: 'none',
  };
}

function tryParse(
  iface: Interface,
  data: Hex,
): { name: string; signature: string; args: Record<string, unknown>; selector: Hex } | null {
  try {
    const parsed = iface.parseTransaction({ data });
    if (!parsed) return null;
    return {
      name: parsed.name,
      signature: parsed.fragment.format('sighash'),
      args: namedArgs(parsed.fragment.inputs, parsed.args),
      // Taken from the calldata rather than the fragment: it is what was actually
      // called, which is the thing a reviewer needs to check independently.
      selector: data.slice(0, 10) as Hex,
    };
  } catch {
    return null;
  }
}

function describeAdmin(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'addOwner':
      return `Add owner ${short(String(args.owner))}`;
    case 'removeOwner':
      return `Remove owner ${short(String(args.owner))}`;
    case 'changeThreshold':
      return `Change approval threshold to ${String(args._threshold ?? args.threshold)}`;
    case 'enableModule':
      return `Enable module ${short(String(args.module))}`;
    case 'disableModule':
      return `Disable module ${short(String(args.module))}`;
    case 'setMinExecutionDelay':
      return `Set minimum execution delay to ${formatDuration(Number(args.delay ?? 0))}`;
    case 'addDelegatecallTarget':
      return `Whitelist ${short(String(args.target))} as a DelegateCall target`;
    case 'removeDelegatecallTarget':
      return `Remove ${short(String(args.target))} from the DelegateCall whitelist`;
    case 'cancelByConsensus':
      return `Cancel transaction ${short(String(args.txHash))} by consensus`;
    default:
      return `Vault admin: ${name}`;
  }
}

function describeErc20(name: string, args: Record<string, unknown>, tokenAddress: string): string {
  switch (name) {
    case 'transfer':
      return `Transfer ${String(args.amount)} units of token ${short(tokenAddress)} to ${short(
        String(args.to),
      )}`;
    case 'approve':
      return `Approve ${short(String(args.spender))} to spend ${String(args.amount)} units of ${short(
        tokenAddress,
      )}`;
    default:
      return `ERC20 ${name} on ${short(tokenAddress)}`;
  }
}

export interface DecodedBatchCall {
  operation: number;
  to: Address;
  value: bigint;
  data: Hex;
}

/**
 * Unpack a MultiSend payload into its constituent calls.
 * Layout per call: `operation(1) ‖ to(20) ‖ value(32) ‖ dataLength(32) ‖ data`.
 */
export function decodeMultiSendPayload(payload: Hex): DecodedBatchCall[] {
  const bytes = getBytes(payload);
  const out: DecodedBatchCall[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    // 1 + 20 + 32 + 32 = 85 bytes of fixed header
    if (offset + 85 > bytes.length) break;

    // Safe: the `offset + 85 > bytes.length` guard above proves this index is in range.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const operation = bytes[offset]!;
    offset += 1;

    const to = hexOf(bytes.subarray(offset, offset + 20));
    offset += 20;

    const value = BigInt(hexOf(bytes.subarray(offset, offset + 32)));
    offset += 32;

    const length = Number(BigInt(hexOf(bytes.subarray(offset, offset + 32))));
    offset += 32;

    if (offset + length > bytes.length) break;
    const data = hexOf(bytes.subarray(offset, offset + length));
    offset += length;

    out.push({ operation, to, value, data });
  }

  return out;
}

function hexOf(bytes: Uint8Array): string {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Call a caller-supplied lookup without letting it break the decode.
 *
 * `decodeCall` is pure, total and runs once per row across a whole history page. The
 * lookup is the one part of it written by someone else, so a resolver that throws —
 * a registry built from malformed input, a Proxy with an opinion — must cost that row
 * its detail and nothing more.
 */
function lookup(
  abis: AbiLookup | undefined,
  address: Address,
): InterfaceAbi | Interface | undefined {
  if (!abis) return undefined;
  try {
    return abis(address);
  } catch {
    return undefined;
  }
}

/**
 * Accept either a raw ABI or an already-built `Interface`.
 *
 * A malformed ABI yields `undefined` rather than throwing, for the same reason.
 */
function toInterface(abi: InterfaceAbi | Interface | undefined): Interface | undefined {
  if (!abi) return undefined;
  if (abi instanceof Interface) return abi;
  try {
    return new Interface(abi);
  } catch {
    return undefined;
  }
}

/**
 * Build an {@link AbiLookup} from an address-keyed set of ABIs.
 *
 * Keys are matched case-insensitively, so a checksummed address and a lowercased one
 * both find the same entry — worth having, because addresses arrive checksummed from
 * `getAddress` and lowercased from the indexer, and a silent miss here reads as "the
 * SDK could not decode this" rather than "your key was the wrong case".
 *
 * ```ts
 * const qv = connect({
 *   abis: abiRegistry({ '0x0033…': myTokenAbi }),
 * });
 * ```
 */
export function abiRegistry(entries: Record<string, InterfaceAbi | Interface>): AbiLookup {
  const byAddress = new Map<string, InterfaceAbi | Interface>();
  for (const [address, abi] of Object.entries(entries)) {
    byAddress.set(address.toLowerCase(), abi);
  }
  return (address) => byAddress.get(address.toLowerCase());
}
