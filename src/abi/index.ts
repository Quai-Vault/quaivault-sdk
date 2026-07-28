/**
 * QuaiVault contract ABIs.
 *
 * Generated from quaivault-contracts hardhat artifacts by `npm run sync-abis`.
 * Do not edit the JSON files by hand — CI checks them for drift.
 */
import QuaiVaultArtifact from './QuaiVault.json' with { type: 'json' };
import QuaiVaultFactoryArtifact from './QuaiVaultFactory.json' with { type: 'json' };
import QuaiVaultProxyArtifact from './QuaiVaultProxy.json' with { type: 'json' };
import SocialRecoveryModuleArtifact from './SocialRecoveryModule.json' with { type: 'json' };
import MultiSendCallOnlyArtifact from './MultiSendCallOnly.json' with { type: 'json' };

import type { InterfaceAbi } from 'quais';

export const QuaiVaultAbi = QuaiVaultArtifact.abi as InterfaceAbi;
export const QuaiVaultFactoryAbi = QuaiVaultFactoryArtifact.abi as InterfaceAbi;
export const QuaiVaultProxyAbi = QuaiVaultProxyArtifact.abi as InterfaceAbi;
export const SocialRecoveryModuleAbi = SocialRecoveryModuleArtifact.abi as InterfaceAbi;
export const MultiSendCallOnlyAbi = MultiSendCallOnlyArtifact.abi as InterfaceAbi;

/**
 * QuaiVaultProxy creation bytecode.
 * Required to reproduce `QuaiVaultFactory.predictWalletAddress` off-chain, which
 * is what makes CREATE2 salt mining possible without an RPC round-trip per attempt.
 */
export const QuaiVaultProxyBytecode = QuaiVaultProxyArtifact.bytecode as string;

/** Minimal ERC20 fragments used for balance reads and transfer encoding. */
export const Erc20Abi = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
] as const;

/** Minimal ERC721 fragments. */
export const Erc721Abi = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
  'function setApprovalForAll(address operator, bool approved)',
] as const;

/** Minimal ERC1155 fragments. */
export const Erc1155Abi = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
  'function uri(uint256 id) view returns (string)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
  'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)',
  'function setApprovalForAll(address operator, bool approved)',
] as const;
