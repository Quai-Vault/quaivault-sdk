import { Interface, AbiCoder } from 'quais';
import type { ErrorFragment } from 'quais';
import {
  QuaiVaultAbi,
  QuaiVaultFactoryAbi,
  SocialRecoveryModuleAbi,
  QuaiVaultProxyAbi,
} from '../abi/index.js';
import type { DecodedRevert, Hex } from '../types.js';

const SOLIDITY_ERROR_SELECTOR = '0x08c379a0'; // Error(string)
const SOLIDITY_PANIC_SELECTOR = '0x4e487b71'; // Panic(uint256)

interface ErrorEntry {
  fragment: ErrorFragment;
  iface: Interface;
}

/** selector -> fragment, built once across every ABI the SDK knows about. */
let registry: Map<string, ErrorEntry> | null = null;

function buildRegistry(): Map<string, ErrorEntry> {
  const map = new Map<string, ErrorEntry>();
  for (const abi of [QuaiVaultAbi, QuaiVaultFactoryAbi, SocialRecoveryModuleAbi, QuaiVaultProxyAbi]) {
    const iface = new Interface(abi);
    iface.forEachError((fragment) => {
      // First ABI wins; collisions across our own contracts are same-signature by construction.
      if (!map.has(fragment.selector)) map.set(fragment.selector, { fragment, iface });
    });
  }
  return map;
}

function getRegistry(): Map<string, ErrorEntry> {
  if (!registry) registry = buildRegistry();
  return registry;
}

/**
 * Guidance keyed by custom error name. This is the difference between
 * "execution reverted (unknown custom error)" and something a caller can act on.
 */
const REMEDIATION: Record<string, string> = {
  // --- QuaiVault: authorisation
  NotAnOwner: 'The calling address is not an owner of this vault.',
  OnlySelf:
    'This function can only be invoked as a vault self-call. Propose a transaction targeting the vault itself.',
  NotAnAuthorizedModule: 'The caller is not an enabled module on this vault.',
  NotProposer: 'Only the address that proposed a transaction may cancel it directly.',

  // --- QuaiVault: transaction lifecycle
  TransactionDoesNotExist: 'No transaction with that hash exists on this vault.',
  TransactionAlreadyExecuted: 'This transaction has already been executed and is terminal.',
  TransactionAlreadyCancelled: 'This transaction has already been cancelled or expired.',
  TransactionAlreadyExists:
    'An identical transaction (same target, value, data and nonce) is already pending.',
  AlreadyApproved: 'This owner has already approved the transaction.',
  NotApproved: 'This owner has no active approval to revoke.',
  NotEnoughApprovals: 'The approval threshold has not been reached yet.',
  CannotCancelApprovedTransaction:
    'The transaction reached quorum, which permanently locks proposer-cancel. Propose a cancelByConsensus self-call instead.',
  TransactionIsExpired: 'The transaction passed its expiration timestamp and can no longer execute.',
  TransactionNotExpired: 'The transaction has not passed its expiration timestamp yet.',
  TimelockNotElapsed: 'The execution delay has not elapsed. Retry after the timelock expires.',
  ExpirationTooSoon:
    'The expiration must be later than now plus the execution delay, so at least one execution attempt is possible.',
  SelfCallCannotHaveValue: 'Self-calls must have value 0.',
  InvalidDestinationAddress: 'The destination address is the zero address.',
  CalldataTooShort: 'Self-call data must contain at least a 4-byte function selector.',
  UnrecognizedSelfCall:
    'The self-call selector is not one the vault dispatches. Check the encoded function against the QuaiVault ABI.',

  // --- QuaiVault: owners and threshold
  OwnersRequired: 'At least one owner is required.',
  TooManyOwners: 'A vault may have at most 20 owners.',
  MaxOwnersReached: 'This vault already has the maximum of 20 owners.',
  InvalidThreshold: 'The threshold must be between 1 and the number of owners.',
  InvalidOwnerAddress:
    'Owner addresses cannot be the zero address, the vault itself, or the sentinel 0x…01.',
  DuplicateOwner: 'The owner list contains a duplicate address.',
  AlreadyAnOwner: 'That address is already an owner.',
  CannotRemoveOwnerWouldFallBelowThreshold:
    'Removing this owner would leave fewer owners than the threshold. Lower the threshold first.',

  // --- QuaiVault: modules and delegatecall
  ModuleAlreadyEnabled: 'That module is already enabled.',
  ModuleNotEnabled: 'That module is not enabled on this vault.',
  InvalidModule: 'Module addresses cannot be the zero address or the sentinel 0x…01.',
  InvalidPrevModule:
    'The predecessor in the module linked list is stale — the module list changed since the proposal was created.',
  MaxModulesReached: 'This vault already has the maximum of 50 modules.',
  DelegateCallNotAllowed:
    'DelegateCall targets must be explicitly whitelisted. Propose addDelegatecallTarget for this address first.',
  DelegatecallTargetAlreadyAllowed: 'That address is already on the DelegateCall whitelist.',
  DelegatecallTargetNotAllowed: 'That address is not on the DelegateCall whitelist.',
  ImplementationSlotTampered:
    'A DelegateCall overwrote the ERC1967 implementation slot and was reverted. The target contract is hostile or buggy.',

  // --- QuaiVault: misc
  ExecutionDelayTooLong: 'The execution delay may not exceed 30 days (2,592,000 seconds).',
  MessageNotSigned: 'That message hash is not currently signed by the vault.',

  // --- Factory
  InvalidImplementationAddress: 'The implementation address is the zero address.',
  InvalidWalletAddress: 'The vault address is the zero address.',
  WalletAlreadyRegistered: 'That vault is already registered with the factory.',
  CallerIsNotAnOwner: 'Only an owner of the vault may register it with the factory.',
  InvalidWalletImplementation:
    'The address is not a QuaiVaultProxy pointing at this factory’s implementation.',

  // --- SocialRecoveryModule
  GuardiansRequired: 'At least one guardian is required.',
  TooManyGuardians: 'Too many guardians for the recovery configuration.',
  RecoveryPeriodTooShort: 'The recovery period is below the module minimum.',
  CannotUpdateConfigWhileRecoveriesPending:
    'Cancel or resolve all pending recoveries before changing the guardian configuration.',
  InvalidGuardianAddress: 'A guardian address is invalid.',
  DuplicateGuardian: 'The guardian list contains a duplicate address.',
  RecoveryNotConfigured: 'This vault has no social recovery configuration.',
  NotAGuardian: 'The calling address is not a guardian of this vault.',
  RecoveryAlreadyInitiated: 'An identical recovery is already pending.',
  RecoveryNotInitiated: 'No recovery with that hash exists.',
  RecoveryAlreadyExecuted: 'That recovery has already been executed.',
  RecoveryPeriodNotElapsed: 'The recovery time lock has not elapsed yet.',
  RecoveryExpired: 'The recovery passed its expiration deadline.',
  RecoveryNotExpired: 'The recovery has not expired yet.',
  TooManyPendingRecoveries: 'This vault has reached its cap on concurrent pending recoveries.',
  RecoveryExceedsMaxOwners:
    'Applying this recovery would temporarily exceed the 20-owner maximum during the add-before-remove sequence.',
  MustBeCalledByWallet: 'This function must be called by the vault itself.',
};

function formatArgs(fragment: ErrorFragment, args: readonly unknown[]): string {
  if (args.length === 0) return '';
  const parts = fragment.inputs.map((input, i) => {
    const value = args[i];
    const rendered = typeof value === 'bigint' ? value.toString() : String(value);
    return input.name ? `${input.name}: ${rendered}` : rendered;
  });
  return `(${parts.join(', ')})`;
}

/**
 * Decode revert data against every QuaiVault ABI, plus the two Solidity builtins.
 * Returns `undefined` for empty data or an unrecognised selector.
 */
export function decodeRevert(data: unknown): DecodedRevert | undefined {
  if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 10) return undefined;

  const selector = data.slice(0, 10).toLowerCase();
  const coder = AbiCoder.defaultAbiCoder();

  if (selector === SOLIDITY_ERROR_SELECTOR) {
    try {
      const [reason] = coder.decode(['string'], '0x' + data.slice(10));
      return {
        name: 'Error',
        args: [reason],
        selector,
        message: String(reason),
      };
    } catch {
      return undefined;
    }
  }

  if (selector === SOLIDITY_PANIC_SELECTOR) {
    try {
      const [code] = coder.decode(['uint256'], '0x' + data.slice(10));
      return {
        name: 'Panic',
        args: [code],
        selector,
        message: `Panic(0x${BigInt(code).toString(16)}) — arithmetic or assertion failure in the target contract`,
      };
    } catch {
      return undefined;
    }
  }

  const entry = getRegistry().get(selector);
  if (!entry) return undefined;

  let args: unknown[] = [];
  try {
    args = Array.from(entry.iface.decodeErrorResult(entry.fragment, data));
  } catch {
    // Selector matched but the payload did not — report the name without args.
  }

  const name = entry.fragment.name;
  const remediation = REMEDIATION[name];
  const rendered = `${name}${formatArgs(entry.fragment, args)}`;

  return {
    name,
    args,
    selector,
    message: remediation ? `${rendered} — ${remediation}` : rendered,
  };
}

/** Remediation text for a custom error name, if the SDK knows one. */
export function remediationFor(errorName: string): string | undefined {
  return REMEDIATION[errorName];
}

/**
 * Pull revert data out of the many shapes providers use, then decode it.
 * Handles quais/ethers `CALL_EXCEPTION` errors, raw RPC error bodies and nested causes.
 */
export function decodeRevertFromError(error: unknown): DecodedRevert | undefined {
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number): DecodedRevert | undefined => {
    if (node == null || depth > 6 || seen.has(node)) return undefined;
    if (typeof node === 'string') return decodeRevert(node);
    if (typeof node !== 'object') return undefined;
    seen.add(node);

    const obj = node as Record<string, unknown>;
    for (const key of ['data', 'errorData', 'return', 'returnData']) {
      const decoded = decodeRevert(obj[key]);
      if (decoded) return decoded;
    }
    for (const key of ['error', 'cause', 'info', 'body', 'value']) {
      const decoded = walk(obj[key], depth + 1);
      if (decoded) return decoded;
    }
    return undefined;
  };

  return walk(error, 0);
}

/** All known custom error selectors. Exposed for tooling and tests. */
export function knownErrorSelectors(): Array<{ selector: Hex; signature: string }> {
  return Array.from(getRegistry().entries()).map(([selector, { fragment }]) => ({
    selector,
    signature: fragment.format('sighash'),
  }));
}
