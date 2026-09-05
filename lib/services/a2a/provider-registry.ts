/**
 * Provider registry — discoverable x402 services for A2A negotiation.
 *
 * Executor agents query this registry when they receive an A2A
 * Proposal: "who serves signal-quality inference? at what price?" The
 * cheapest provider that fits the requester's budget wins.
 *
 * Registry entries are code-defined today; registering via HCS-14
 * service descriptors is the natural next step so external providers
 * can plug in without a code push.
 */

export interface Provider {
  id: string;                              // stable slug
  url: string;                             // x402 endpoint
  service: 'signal-quality' | 'risk-assessment' | 'trade-execution';
  priceMicros: string;                     // per-call, stringified microUSD
  network: 'hedera-testnet' | 'hedera-mainnet' | 'base-mainnet' | 'base-sepolia';
  operator: string;                        // DID or free-form identifier
  latencyP95Ms?: number;                   // for tie-breaking on ties
  metadata?: Record<string, string>;
}

// ─── Default registry ─────────────────────────────────────────────────────
// Our own endpoint is first. Additional entries would be third-party
// providers plugged in by the executor agent's owner. Prices here match
// X402_PRICE_USDC_MICROS on each provider — the registry is a discovery
// hint; the actual 402 intent is the source of truth for the price.

function ownEndpoint(): string {
  // Prefer explicit URL if operator set it in env — matches whatever the
  // executor agent would reach at runtime. Fallback URL is for local dev.
  return (process.env.X402_TRADER_ENDPOINT_URL || '').trim()
    || (process.env.NEXT_PUBLIC_URL || '').trim().replace(/\/$/, '') + '/api/hedera/x402/signal-quality'
    || 'https://www.zkward.com/api/hedera/x402/signal-quality';
}

export const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: 'zkward-signal-quality-hedera',
    url: ownEndpoint(),
    service: 'signal-quality',
    priceMicros: (process.env.X402_PRICE_USDC_MICROS || '100').trim(),
    network: (process.env.HEDERA_NETWORK === 'mainnet' ? 'hedera-mainnet' : 'hedera-testnet') as Provider['network'],
    operator: 'did:hedera:zkward#executor',
    latencyP95Ms: 800,
    metadata: { source: 'PredictionAggregatorService v0.4.0' },
  },
];

// ─── Discovery ────────────────────────────────────────────────────────────

export interface DiscoverArgs {
  service: Provider['service'];
  maxPriceMicros: string;
  network?: Provider['network'];
  registry?: Provider[]; // for tests
}

export interface DiscoverResult {
  provider: Provider | null;
  reason?: string;
  considered: number;
  candidates: number; // count that passed the service filter, before price filter
}

/**
 * Find the cheapest provider that (1) serves the requested service, (2)
 * fits the budget, (3) matches the network filter if supplied. Ties
 * broken by lower p95 latency.
 */
export function discoverProviders(args: DiscoverArgs): DiscoverResult {
  const registry = args.registry ?? DEFAULT_PROVIDERS;
  const byService = registry.filter((p) => p.service === args.service);
  if (byService.length === 0) {
    return { provider: null, reason: `no providers for service '${args.service}'`, considered: registry.length, candidates: 0 };
  }
  const byNetwork = args.network
    ? byService.filter((p) => p.network === args.network)
    : byService;
  if (byNetwork.length === 0) {
    return { provider: null, reason: `no providers on network '${args.network}'`, considered: registry.length, candidates: byService.length };
  }
  const budget = BigInt(args.maxPriceMicros);
  const affordable = byNetwork.filter((p) => BigInt(p.priceMicros) <= budget);
  if (affordable.length === 0) {
    const cheapest = byNetwork.reduce((min, p) =>
      BigInt(p.priceMicros) < BigInt(min.priceMicros) ? p : min,
    );
    return {
      provider: null,
      reason: `budget ${args.maxPriceMicros} < cheapest available ${cheapest.priceMicros} @ ${cheapest.id}`,
      considered: registry.length,
      candidates: byNetwork.length,
    };
  }
  affordable.sort((a, b) => {
    const priceCmp = Number(BigInt(a.priceMicros) - BigInt(b.priceMicros));
    if (priceCmp !== 0) return priceCmp;
    return (a.latencyP95Ms ?? Number.MAX_SAFE_INTEGER) - (b.latencyP95Ms ?? Number.MAX_SAFE_INTEGER);
  });
  return { provider: affordable[0], reason: undefined, considered: registry.length, candidates: byNetwork.length };
}
