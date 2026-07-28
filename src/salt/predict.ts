import { AbiCoder, Interface, concat, getCreate2Address, keccak256, solidityPacked } from 'quais';
import { QuaiVaultAbi, QuaiVaultProxyBytecode } from '../abi/index.js';
import type { Address, Bytes32, CreateVaultParams } from '../types.js';
import { ValidationError } from '../errors/index.js';

const vaultInterface = new Interface(QuaiVaultAbi);

/**
 * Encode the `initialize` call the factory delegatecalls from the proxy constructor.
 *
 * This MUST match `QuaiVaultFactory._createWallet` exactly — including the module and
 * delegatecall-target arrays. Encoding `[]` for those while deploying with a non-empty
 * array yields a different bytecode hash, so the mined address will not be the address
 * the factory actually deploys to.
 */
export function encodeInitData(params: {
  owners: Address[];
  threshold: number;
  minExecutionDelay?: number;
  initialModules?: Address[];
  initialDelegatecallTargets?: Address[];
}): string {
  return vaultInterface.encodeFunctionData('initialize', [
    params.owners,
    params.threshold,
    params.minExecutionDelay ?? 0,
    params.initialModules ?? [],
    params.initialDelegatecallTargets ?? [],
  ]);
}

/**
 * keccak256 of the full proxy creation bytecode (creation code + ABI-encoded
 * constructor args), which is the third input to CREATE2.
 *
 * Constant for a given set of create params, so it is computed once and reused
 * across every mining attempt.
 */
export function computeBytecodeHash(implementation: Address, initData: string): Bytes32 {
  const encodedArgs = AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes'],
    [implementation, initData],
  );
  return keccak256(concat([QuaiVaultProxyBytecode, encodedArgs]));
}

/**
 * The factory namespaces user salts by caller:
 * `fullSalt = keccak256(abi.encodePacked(msg.sender, userSalt))`.
 * Two deployers using the same user salt therefore get different addresses.
 */
export function computeFullSalt(deployer: Address, userSalt: Bytes32): Bytes32 {
  return keccak256(solidityPacked(['address', 'bytes32'], [deployer, userSalt]));
}

/**
 * Reproduce `QuaiVaultFactory.predictWalletAddress` off-chain — no RPC needed.
 */
export function predictVaultAddress(args: {
  factory: Address;
  implementation: Address;
  deployer: Address;
  salt: Bytes32;
  params: CreateVaultParams;
}): Address {
  const initData = encodeInitData(args.params);
  const bytecodeHash = computeBytecodeHash(args.implementation, initData);
  const fullSalt = computeFullSalt(args.deployer, args.salt);
  return getCreate2Address(args.factory, fullSalt, bytecodeHash);
}

/**
 * The shard prefix of a Quai address: `0x` plus the leading byte.
 *
 * Quai addresses are shard-scoped. A vault deployed outside the deployer's shard is
 * unreachable from it, which is why deployment requires mining a salt rather than
 * picking one at random.
 */
export function shardPrefixOf(address: Address): string {
  if (typeof address !== 'string' || !address.startsWith('0x') || address.length < 4) {
    throw new ValidationError(`Cannot derive a shard prefix from "${address}".`);
  }
  return address.slice(0, 4).toLowerCase();
}
