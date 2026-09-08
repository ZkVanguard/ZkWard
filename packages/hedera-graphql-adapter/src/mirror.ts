/**
 * Minimal Mirror Node REST client.
 *
 * Extracted from lib/services/hedera/mirror-node.ts in the ZkWard repo,
 * trimmed to just the calls this adapter needs. No Hedera SDK dep here —
 * we hit the public Mirror endpoints with fetch().
 */

import type { HederaNetwork } from './types';

const MIRROR_HOSTS: Record<HederaNetwork, string> = {
  testnet: 'https://testnet.mirrornode.hedera.com/api/v1',
  mainnet: 'https://mainnet.mirrornode.hedera.com/api/v1',
};

export interface MirrorContract {
  contract_id: string;
  evm_address: string;
  created_timestamp: string | null;
}

export interface MirrorLog {
  address: string;
  data: string;
  index: number;
  topics: string[];
  timestamp: string;
  block_hash: string;
  block_number: number;
  transaction_hash: string;
}

export interface MirrorContractCallResult {
  result: string;
  status: string;
}

export interface MirrorClientOptions {
  network: HederaNetwork;
  /** Override the default Mirror Node base URL. Useful for local mock servers. */
  base?: string;
  /** Per-request timeout in ms. Default 10 000. Set to 0 to disable. */
  timeoutMs?: number;
  /**
   * Custom `fetch` implementation. Defaults to global `fetch`. Inject to add
   * retries, request logging, an HTTPS proxy, or to route through a service
   * mesh. Signature is the standard WHATWG `fetch` — anything that satisfies
   * `typeof fetch` works (undici, node-fetch v3, cross-fetch, etc.).
   */
  fetch?: typeof globalThis.fetch;
}

export class MirrorClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly _fetch: typeof globalThis.fetch;
  /** Sticky flag — flips to true on any Mirror Node request failure or non-2xx.
   *  Read by the preset to populate `_meta.hasIndexingErrors`. Reset with
   *  `clearIndexingErrors()` when the caller has acknowledged them. */
  hasIndexingErrors = false;
  /** Last error message seen, for debugging. */
  lastError: string | null = null;

  constructor(opts: MirrorClientOptions) {
    this.base = opts.base ?? MIRROR_HOSTS[opts.network];
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  clearIndexingErrors(): void {
    this.hasIndexingErrors = false;
    this.lastError = null;
  }

  private async request(input: string, init?: RequestInit): Promise<Response | null> {
    const ctrl = this.timeoutMs > 0 ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : null;
    try {
      const r = await this._fetch(input, { ...init, signal: ctrl?.signal });
      if (!r.ok) {
        this.hasIndexingErrors = true;
        this.lastError = `${input} → HTTP ${r.status}`;
        return null;
      }
      return r;
    } catch (e) {
      this.hasIndexingErrors = true;
      this.lastError = `${input} → ${e instanceof Error ? e.message : String(e)}`;
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fetchJson<T>(path: string): Promise<T | null> {
    const r = await this.request(this.base + path);
    if (!r) return null;
    try {
      return (await r.json()) as T;
    } catch (e) {
      this.hasIndexingErrors = true;
      this.lastError = `${path} → invalid json: ${e instanceof Error ? e.message : String(e)}`;
      return null;
    }
  }

  getContract(evmAddress: string): Promise<MirrorContract | null> {
    return this.fetchJson<MirrorContract>(`/contracts/${evmAddress}`);
  }

  async getContractLogs(evmAddress: string, opts: { topic0?: string; limit?: number } = {}): Promise<MirrorLog[]> {
    const params = new URLSearchParams();
    params.set('order', 'desc');
    params.set('limit', String(opts.limit ?? 25));
    if (opts.topic0) params.set('topic0', opts.topic0);
    const r = await this.fetchJson<{ logs: MirrorLog[] }>(
      `/contracts/${evmAddress}/results/logs?${params.toString()}`,
    );
    return r?.logs ?? [];
  }

  /**
   * Pull the latest messages from an HCS topic. Base64-encoded payloads
   * are returned as-is; consumers decode. `limit` is capped at 100 by the
   * public Mirror; pass `next` from a previous response to page back further.
   */
  async getTopicMessages(
    topicId: string,
    opts: { limit?: number; order?: 'asc' | 'desc' } = {},
  ): Promise<Array<{ sequence_number: number; consensus_timestamp: string; message: string; running_hash?: string; payer_account_id?: string }>> {
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(100, opts.limit ?? 25)));
    params.set('order', opts.order ?? 'desc');
    const r = await this.fetchJson<{ messages?: Array<{ sequence_number: number; consensus_timestamp: string; message: string; running_hash?: string; payer_account_id?: string }> }>(
      `/topics/${topicId}/messages?${params.toString()}`,
    );
    return r?.messages ?? [];
  }

  /** Latest block — cheap way to source _meta.block. */
  async getLatestBlock(): Promise<{ number: number; timestampSec: number } | null> {
    const r = await this.fetchJson<{ blocks?: Array<{ number?: number; timestamp?: { from?: string } }> }>(
      '/blocks?limit=1&order=desc',
    );
    const b = r?.blocks?.[0];
    if (!b || b.number == null) return null;
    const fromSec = b.timestamp?.from ? parseInt(b.timestamp.from.split('.')[0] || '0', 10) : 0;
    return { number: b.number, timestampSec: fromSec };
  }

  /**
   * eth_call bridge via Mirror. Useful for view function reads.
   * `data` is 0x-prefixed calldata (selector + encoded params).
   */
  async contractCall(evmAddress: string, data: string): Promise<string | null> {
    const r = await this.request(`${this.base}/contracts/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: evmAddress, data, estimate: false }),
    });
    if (!r) return null;
    try {
      const j = (await r.json()) as MirrorContractCallResult;
      return j.result ?? null;
    } catch {
      this.hasIndexingErrors = true;
      return null;
    }
  }

  static base(network: HederaNetwork): string {
    return MIRROR_HOSTS[network];
  }
}

/** "1788757632.252720104" → Date */
export function mirrorTimestampToDate(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const [secs] = ts.split('.');
  const s = parseInt(secs || '0', 10);
  if (!Number.isFinite(s) || s <= 0) return null;
  return new Date(s * 1000);
}

/** "1788757632.252720104" → epoch seconds */
export function mirrorTimestampToSec(ts: string | null | undefined): number {
  if (!ts) return 0;
  const s = parseInt(ts.split('.')[0] || '0', 10);
  return Number.isFinite(s) ? s : 0;
}
