import type { NetworkConfig } from '../types.js';

/**
 * Built-in network presets.
 *
 * Contract addresses track the deployments recorded in quaivault-www/contracts.md.
 *
 * The indexer credentials ship with the SDK so it works out of the box. The
 * publishable key is a public, read-only credential: the indexer's RLS grants the
 * `anon` role `SELECT` on every table and nothing else, with all writes reserved for
 * `service_role`. It exposes only chain data that is already public.
 *
 * Override any of it with `QUAIVAULT_INDEXER_URL` / `_ANON_KEY` / `_SCHEMA`, or with
 * `connect({ indexer: { … } })` — needed if the key is ever rotated ahead of an SDK
 * release, or to point at a self-hosted indexer.
 */

const INDEXER_URL = 'https://xbftgyuxaxagptudledv.supabase.co';

/** Public, read-only Supabase publishable key. Safe to distribute — see above. */
const INDEXER_PUBLISHABLE_KEY = 'sb_publishable_EO-sTB-jqUzlsiugOEks-Q_qRtHDaHU';

export const mainnet: NetworkConfig = {
  name: 'mainnet',
  chainId: 9,
  rpcUrl: 'https://rpc.quai.network',
  explorerUrl: 'https://quaiscan.io',
  contracts: {
    implementation: '0x0038E6d84412A10CdcE41b0f62A05350023f1fb6',
    factory: '0x003613aC5FFd45bFF7B2F0210DA2fF660908c488',
    socialRecovery: '0x000dbc29Bdd311C29a4008164052fc2E67c0D937',
    multiSendCallOnly: '0x003f62e6a7f2EB6b94345a9A41671888eC4A3ebA',
  },
  indexer: {
    url: INDEXER_URL,
    anonKey: INDEXER_PUBLISHABLE_KEY,
    schema: 'mainnet',
    healthUrl: 'https://index.quaivault.org',
  },
};

export const testnet: NetworkConfig = {
  name: 'testnet',
  chainId: 15000,
  // Orchard moved from rpc.orchard.quai.network (now NXDOMAIN) to this hostname.
  rpcUrl: 'https://orchard.rpc.quai.network',
  explorerUrl: 'https://orchard.quaiscan.io',
  contracts: {
    implementation: '0x004E539Cf477A5Cb456A56023f083cD91Bc4934e',
    factory: '0x002d1305D597c157bB975967FA2e5337674b0E5F',
    socialRecovery: '0x003a465e661D0E44C1e78b7B256D8C37f699E61e',
    multiSendCallOnly: '0x002ae8A47C2da497fe569AfCF0486410aA1093E0',
  },
  indexer: {
    url: INDEXER_URL,
    anonKey: INDEXER_PUBLISHABLE_KEY,
    schema: 'testnet',
    healthUrl: 'https://index.devnet.quaivault.org',
  },
};

export const networks = { mainnet, testnet } as const;

export type NetworkName = keyof typeof networks;

export function isNetworkName(value: unknown): value is NetworkName {
  return typeof value === 'string' && value in networks;
}
