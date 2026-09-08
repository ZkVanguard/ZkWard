/**
 * Load a real subgraph.yaml + wire it into the adapter.
 *
 * The Graph doesn't natively index Hedera, so `graph deploy` would
 * refuse the manifest. This loader lets any Hedera dApp keep the same
 * subgraph.yaml + schema.graphql + abis/ workflow they'd use on a
 * Graph-indexed chain, and get a working GraphQL endpoint against
 * Hedera Mirror Node instead.
 *
 * Extracts from the manifest:
 *   - dataSources[0].source.address  → contract
 *   - dataSources[0].network         → hedera-testnet / hedera-mainnet
 *   - dataSources[0].source.startBlock (informational — Mirror doesn't
 *     support pre-block time-travel; we track from Mirror's current head)
 *   - dataSources[0].mapping.eventHandlers[].event → detects erc4626 shape
 *
 * If Deposited/Withdrawn are present, uses the erc4626 preset directly.
 * Otherwise throws a clear error pointing at the roadmap — full custom-
 * event support ships in v0.7.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { createHederaGraphQLAdapter } from './index';
import type { Adapter, AttestationConfig, HederaNetwork } from './types';

interface DataSourceSource {
  address?: string;
  startBlock?: number;
  abi?: string;
}

interface EventHandler {
  event?: string;
  handler?: string;
}

interface DataSource {
  kind?: string;
  name?: string;
  network?: string;
  source?: DataSourceSource;
  mapping?: {
    kind?: string;
    apiVersion?: string;
    language?: string;
    entities?: string[];
    abis?: Array<{ name?: string; file?: string }>;
    eventHandlers?: EventHandler[];
    file?: string;
  };
}

interface SubgraphManifest {
  specVersion?: string;
  description?: string;
  schema?: { file?: string };
  dataSources?: DataSource[];
  templates?: DataSource[];
}

const ERC4626_EVENTS = new Set([
  'Deposited(indexed address,uint256,uint256)',
  'Withdrawn(indexed address,uint256,uint256)',
  // ERC-4626 CommunityPool ships longer signatures (uint256[4] arrays,
  // reasonHash strings). Any manifest that declares Deposited + Withdrawn
  // with the (address, uint256, uint256) subset qualifies — extra tuple
  // args on the more elaborate variants are ignored here.
]);

function normalizeSig(sig: string): string {
  // strip whitespace + `indexed` markers for matching
  return sig.replace(/\s+/g, '').toLowerCase();
}

function containsErc4626Events(handlers: EventHandler[]): boolean {
  const sigs = handlers.map((h) => normalizeSig(h.event ?? ''));
  const hasDeposit = sigs.some((s) => s.startsWith('deposited('));
  const hasWithdraw = sigs.some((s) => s.startsWith('withdrawn('));
  return hasDeposit && hasWithdraw;
}

function mapNetwork(net: string): HederaNetwork | null {
  const n = net.toLowerCase();
  if (n === 'hedera-testnet' || n === 'hedera:testnet' || n === 'testnet') return 'testnet';
  if (n === 'hedera-mainnet' || n === 'hedera:mainnet' || n === 'mainnet') return 'mainnet';
  return null;
}

export interface FromSubgraphYamlOptions {
  /** Override auto-detected network. */
  network?: HederaNetwork;
  /** Which data source to use (0-indexed). Default 0. */
  dataSourceIndex?: number;
  /** Attestation config to pass through to the adapter. */
  attestation?: AttestationConfig;
  /** Optional HCS audit topic — enables `signals` + `navHistory` queries. */
  auditTopicId?: string;
  /** Per-request Mirror Node timeout in ms. Default 10_000. */
  mirrorTimeoutMs?: number;
  /** Cache TTL. Default 30_000. */
  cacheTtlMs?: number;
}

/**
 * Load a subgraph.yaml and return a fully-configured Adapter.
 *
 * @example
 * ```ts
 * import { fromSubgraphYaml } from '@zkward/hedera-graphql-adapter';
 * const adapter = fromSubgraphYaml('./subgraph.yaml');
 * const result = await adapter.execute({ query: '{ pools { totalNav } }' });
 * ```
 */
export function fromSubgraphYaml(manifestPath: string, opts: FromSubgraphYamlOptions = {}): Adapter {
  const abs = resolve(manifestPath);
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (e) {
    throw new Error(`fromSubgraphYaml: cannot read ${abs}: ${e instanceof Error ? e.message : String(e)}`);
  }

  let manifest: SubgraphManifest;
  try {
    manifest = parseYaml(raw) as SubgraphManifest;
  } catch (e) {
    throw new Error(`fromSubgraphYaml: yaml parse error in ${abs}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`fromSubgraphYaml: manifest at ${abs} did not parse to an object`);
  }

  const idx = opts.dataSourceIndex ?? 0;
  const ds = manifest.dataSources?.[idx];
  if (!ds) throw new Error(`fromSubgraphYaml: no dataSources[${idx}] in ${abs}`);
  const address = ds.source?.address;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`fromSubgraphYaml: dataSources[${idx}].source.address must be a 0x-prefixed EVM address, got ${address}`);
  }

  const network = opts.network ?? (ds.network ? mapNetwork(ds.network) : null);
  if (!network) {
    throw new Error(
      `fromSubgraphYaml: could not map network ${ds.network ?? '<missing>'} to hedera-{testnet|mainnet}. ` +
      `Set dataSources[${idx}].network to 'hedera-testnet' or pass opts.network. ` +
      `The Graph doesn't index Hedera natively — this loader routes the same manifest to Mirror Node.`,
    );
  }

  const handlers = ds.mapping?.eventHandlers ?? [];
  if (!containsErc4626Events(handlers)) {
    const seen = handlers.map((h) => h.event).filter(Boolean).join(', ');
    throw new Error(
      `fromSubgraphYaml: this manifest doesn't declare the erc4626 event pair ` +
      `(Deposited + Withdrawn). Saw handlers: [${seen}]. ` +
      `Full custom event support lands in v0.7; for now, either add the erc4626 events to the manifest ` +
      `or construct the adapter directly via createHederaGraphQLAdapter({ preset: 'erc4626', contract, network }).`,
    );
  }

  return createHederaGraphQLAdapter({
    network,
    contract: address,
    preset: 'erc4626',
    attestation: opts.attestation,
    auditTopicId: opts.auditTopicId,
    mirrorTimeoutMs: opts.mirrorTimeoutMs,
    cacheTtlMs: opts.cacheTtlMs,
  });
}

/**
 * Convenience: parse a subgraph.yaml manifest to its normalized shape
 * without constructing an adapter. Useful for validation + inspection.
 * Resolves file paths relative to the manifest's directory.
 */
export function parseSubgraphManifest(manifestPath: string): {
  manifest: SubgraphManifest;
  dir: string;
  contract: string;
  network: HederaNetwork;
  eventSignatures: string[];
} {
  const abs = resolve(manifestPath);
  const dir = dirname(abs);
  const raw = readFileSync(abs, 'utf8');
  const manifest = parseYaml(raw) as SubgraphManifest;
  const ds = manifest.dataSources?.[0];
  if (!ds?.source?.address) throw new Error('parseSubgraphManifest: no dataSources[0].source.address');
  const network = mapNetwork(ds.network ?? '');
  if (!network) throw new Error(`parseSubgraphManifest: unsupported network ${ds.network}`);
  return {
    manifest,
    dir,
    contract: ds.source.address,
    network,
    eventSignatures: (ds.mapping?.eventHandlers ?? []).map((h) => h.event ?? '').filter(Boolean),
  };
}
