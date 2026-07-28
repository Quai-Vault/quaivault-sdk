/**
 * Copies ABIs (and the proxy creation bytecode, needed for CREATE2 address
 * prediction) out of the quaivault-contracts hardhat artifacts into src/abi.
 *
 * The SDK is the single distribution point for QuaiVault ABIs. Run this on every
 * contracts release; CI fails if the committed output differs from the artifacts.
 *
 *   npm run sync-abis -- [--contracts <path>] [--check]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'src', 'abi');

/** artifact path (relative to artifacts/contracts) -> output basename */
const ARTIFACTS: Array<{ path: string; name: string; withBytecode?: boolean }> = [
  { path: 'QuaiVault.sol/QuaiVault.json', name: 'QuaiVault' },
  { path: 'QuaiVaultFactory.sol/QuaiVaultFactory.json', name: 'QuaiVaultFactory' },
  // Proxy creation bytecode is required to reproduce factory.predictWalletAddress.
  { path: 'QuaiVaultProxy.sol/QuaiVaultProxy.json', name: 'QuaiVaultProxy', withBytecode: true },
  { path: 'modules/SocialRecoveryModule.sol/SocialRecoveryModule.json', name: 'SocialRecoveryModule' },
  { path: 'libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json', name: 'MultiSendCallOnly' },
];

interface Artifact {
  contractName: string;
  abi: unknown[];
  bytecode: string;
}

function parseArgs(argv: string[]) {
  let contracts = resolve(HERE, '..', '..', 'quaivault-contracts');
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    // Safe: the `argv[i + 1]` guard on this same line proves the index exists.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (argv[i] === '--contracts' && argv[i + 1]) contracts = resolve(argv[++i]!);
    else if (argv[i] === '--check') check = true;
  }
  return { contracts, check };
}

function main() {
  const { contracts, check } = parseArgs(process.argv.slice(2));
  const artifactRoot = join(contracts, 'artifacts', 'contracts');

  if (!existsSync(artifactRoot)) {
    console.error(
      `[sync-abis] No artifacts at ${artifactRoot}\n` +
        `            Run \`npx hardhat compile\` in ${contracts} first, ` +
        `or pass --contracts <path>.`,
    );
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const drift: string[] = [];

  for (const { path, name, withBytecode } of ARTIFACTS) {
    const artifact = JSON.parse(readFileSync(join(artifactRoot, path), 'utf8')) as Artifact;

    const out: Record<string, unknown> = { contractName: artifact.contractName, abi: artifact.abi };
    if (withBytecode) out.bytecode = artifact.bytecode;

    const serialized = JSON.stringify(out, null, 2) + '\n';
    const target = join(OUT_DIR, `${name}.json`);

    if (check) {
      const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
      if (current !== serialized) drift.push(name);
    } else {
      writeFileSync(target, serialized);
      console.log(`[sync-abis] wrote src/abi/${name}.json (${artifact.abi.length} entries)`);
    }
  }

  if (check) {
    if (drift.length > 0) {
      console.error(
        `[sync-abis] ABI drift detected in: ${drift.join(', ')}\n` +
          `            Run \`npm run sync-abis\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log('[sync-abis] no drift');
  }
}

main();
