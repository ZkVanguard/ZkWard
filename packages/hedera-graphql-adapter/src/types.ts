/**
 * Public types for @zkward/hedera-graphql-adapter.
 */

export type HederaNetwork = 'testnet' | 'mainnet';

export type Preset = 'erc4626' | 'custom' | 'auto';

export interface AttestationConfig {
  /** Master switch. When false, `?attest=1` returns a `reason` and no HCS write. */
  enabled: boolean;
  /** HCS topic to submit response hashes to. */
  topicId: string;
  /** Hedera operator account id (0.0.x). */
  operatorId: string;
  /** Hedera operator private key (hex or DER). */
  operatorKey: string;
  /** Optional network override — defaults to the adapter's network. */
  network?: HederaNetwork;
}

export interface CustomEventDef {
  /** Human-readable event name — used only for logs. */
  name: string;
  /** Canonical event signature, e.g. `Transfer(address,address,uint256)`. */
  signature: string;
  /** Called for every matching log. Return an entity write, or null to skip. */
  map?: (log: DecodedLog) => EventProjection | null;
}

export interface DecodedLog {
  /** Raw event signature. */
  signature: string;
  /** Topic0 keccak of signature. */
  topic0: string;
  /** Indexed params in-order (topics[1..]). */
  indexedTopics: string[];
  /** ABI-decoded non-indexed params — best-effort by preset. */
  data: string;
  block: number;
  timestamp: string;      // Mirror Node "seconds.nanos"
  timestampSec: number;
  transactionHash: string;
  logIndex: number;
  /** Convenience — event sender / actor (topics[1] for most standard events). */
  actor: string;
}

export interface EventProjection {
  /** Transaction kind used by the shared schema. */
  txType?: 'DEPOSIT' | 'WITHDRAW' | 'OTHER';
  amount?: bigint;
  shares?: bigint;
  actor?: string;
  memo?: Record<string, unknown>;
}

export interface AdapterConfig {
  network: HederaNetwork;
  /** EVM address of the contract being indexed. */
  contract: string;
  /** How to interpret events. Defaults to 'auto'. */
  preset?: Preset;
  /** For preset: 'custom' — user-supplied event definitions. */
  events?: CustomEventDef[];
  /** Optional HCS attestation config; omit or set enabled:false to disable. */
  attestation?: AttestationConfig;
  /** Override Mirror Node base URL — mostly for testing. */
  mirrorNodeBase?: string;
  /**
   * Per-request Mirror Node timeout in ms. Default 10 000. Set 0 to disable
   * (not recommended in production — a hung Mirror will hang the adapter).
   */
  mirrorTimeoutMs?: number;
  /**
   * Custom `fetch` implementation for Mirror Node calls. Anything that
   * satisfies WHATWG `fetch` works — inject to add retries, logging,
   * an HTTPS proxy, or to route through a service mesh.
   *
   * Default: `globalThis.fetch` (Node 18+ built-in).
   */
  mirrorFetch?: typeof globalThis.fetch;
  /**
   * TTL for the internal pool + logs cache in ms. Default 30 000. Set to
   * 0 to disable caching (every GraphQL request hits Mirror). Higher values
   * reduce Mirror load; lower values reduce staleness for frequently-changing
   * pools.
   */
  cacheTtlMs?: number;
  /**
   * Optional Hedera Consensus Service topic that carries AI decision
   * receipts (x402 paid-inference calls, hedge projections, query
   * attestations). When set, the adapter exposes a `signals` query that
   * reconstructs `{ asset, direction, confidence, source, timestamp }`
   * from the topic messages — turning the HCS audit trail into
   * GraphQL-queryable decision history.
   *
   * Example: `0.0.10393879` on Hedera testnet.
   * Omit to disable — `signals` returns an empty array.
   */
  auditTopicId?: string;
}

export interface ExecuteInput {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  /** Whether to HCS-attest the response bytes (only fires if attestation enabled). */
  attest?: boolean;
}

export interface AttestationResult {
  attested: boolean;
  reason?: string;
  responseHash?: string;
  hashAlgo?: 'sha256';
  txId?: string;
  topicId?: string;
  consensusSeq?: string;
  finalityMs?: number;
  explorerUrl?: string;
  network?: HederaNetwork;
  attestedAt?: string;
}

export type AdapterErrorCode =
  | 'VALIDATION_ERROR'
  | 'PARSE_ERROR'
  | 'MIRROR_UNAVAILABLE'
  | 'MIRROR_TIMEOUT'
  | 'RESOLVER_ERROR'
  | 'UNKNOWN';

export interface AdapterError {
  message: string;
  extensions?: {
    code: AdapterErrorCode;
    /** Whether a retry might succeed (transient upstream failure). */
    retryable?: boolean;
    /** Location in the query that triggered it, if known. */
    path?: readonly (string | number)[];
    /** Underlying cause preview — safe to surface to clients. */
    cause?: string;
  };
}

export interface ExecuteResult<T = unknown> {
  data?: T;
  errors?: AdapterError[];
  extensions?: {
    _attestation?: AttestationResult;
  };
}

export interface Adapter {
  /** Execute a GraphQL query against the adapter. */
  execute: <T = unknown>(input: ExecuteInput) => Promise<ExecuteResult<T>>;
  /** Return the effective SDL — useful for `graphql-playground` and introspection UIs. */
  getSchemaSDL: () => string;
  /** Config the adapter was constructed with. Useful for debug endpoints. */
  getConfig: () => Readonly<AdapterConfig>;
}
