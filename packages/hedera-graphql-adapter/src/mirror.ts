/**
 * Minimal Mirror Node REST client.
 *
 * Extracted from lib/services/hedera/mirror-node.ts in the ZkWard repo,
 * trimmed to just the calls this adapter needs. No Hedera SDK dep here —
 * we hit the public Mirror endpoints with fetch().
 */

import type { HederaNetwork } from './types.js';

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
  base?: string;
}

export class MirrorClient {
  private readonly base: string;

  constructor(opts: MirrorClientOptions) {
    this.base = opts.base ?? MIRROR_HOSTS[opts.network];
  }

  private async fetch<T>(path: string): Promise<T | null> {
    const r = await fetch(this.base + path);
    if (!r.ok) return null;
    return (await r.json()) as T;
  }

  getContract(evmAddress: string): Promise<MirrorContract | null> {
    return this.fetch<MirrorContract>(`/contracts/${evmAddress}`);
  }

  async getContractLogs(evmAddress: string, opts: { topic0?: string; limit?: number } = {}): Promise<MirrorLog[]> {
    const params = new URLSearchParams();
    params.set('order', 'desc');
    params.set('limit', String(opts.limit ?? 25));
    if (opts.topic0) params.set('topic0', opts.topic0);
    const r = await this.fetch<{ logs: MirrorLog[] }>(
      `/contracts/${evmAddress}/results/logs?${params.toString()}`,
    );
    return r?.logs ?? [];
  }

  /**
   * eth_call bridge via Mirror. Useful for view function reads.
   * `data` is 0x-prefixed calldata (selector + encoded params).
   */
  async contractCall(evmAddress: string, data: string): Promise<string | null> {
    const r = await fetch(`${this.base}/contracts/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: evmAddress, data, estimate: false }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as MirrorContractCallResult;
    return j.result ?? null;
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
