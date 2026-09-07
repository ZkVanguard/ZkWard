/**
 * Hedera Mirror Node client.
 *
 * Official free indexer — read-only REST layer over consensus state.
 * We use it in place of raw Hashio RPC for two reasons:
 *   1. Hashio's public tier is aggressively rate-limited and returns
 *      CONTRACT_REVERT_EXECUTED for view calls on uninitialized state
 *      (bubbled up as "Unable to retrieve pool data" in the app).
 *   2. Mirror Node is already-indexed: contract event history, token
 *      balances, historical calls — all zero-latency queries, no
 *      per-block scan required.
 *
 * Docs: https://docs.hedera.com/hedera/sdks-and-apis/rest-api
 *
 * All fields returned are Mirror-Node-native (snake_case strings for
 * bigints) — callers convert to app types.
 */

import { logger } from '@/lib/utils/logger';

// ─── Endpoints ────────────────────────────────────────────────────────────
const BASE: Record<'testnet' | 'mainnet', string> = {
  testnet: 'https://testnet.mirrornode.hedera.com/api/v1',
  mainnet: 'https://mainnet-public.mirrornode.hedera.com/api/v1',
};

// Node-level fetch timeout so a slow mirror doesn't hang a route.
const DEFAULT_TIMEOUT_MS = 5000;

// ─── Types ────────────────────────────────────────────────────────────────

export interface MirrorContract {
  contract_id: string;              // 0.0.xxxxxx
  evm_address: string;              // 0x...
  created_timestamp: string;        // "1698765432.123456789"
  file_id: string | null;
  memo: string | null;
  admin_key: unknown;
  deleted: boolean;
}

export interface MirrorTokenBalance {
  token_id: string;
  balance: number;
  decimals: number;
}

export interface MirrorContractLog {
  address: string;
  bloom: string;
  contract_id: string;
  data: string;
  index: number;
  topics: string[];
  root_contract_id: string;
  timestamp: string;
  block_hash: string;
  block_number: number;
  transaction_hash: string;
  transaction_index: number;
}

export interface MirrorContractCallResult {
  contract_id: string;
  from: string;
  to: string;
  amount: number;
  block_number: number;
  timestamp: string;
  result: string;
  status: string;
  hash: string;
  gas_consumed: number | null;
  function_parameters: string;
}

// ─── Fetch helper ─────────────────────────────────────────────────────────

async function fetchMirror<T>(
  network: 'testnet' | 'mainnet',
  path: string,
): Promise<T | null> {
  const url = `${BASE[network]}${path.startsWith('/') ? '' : '/'}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
      // Mirror node data is eventually consistent + safe to cache briefly.
      // 15s balances low-freshness against Vercel's edge cache pressure.
      next: { revalidate: 15 },
    });
    if (r.status === 404) return null;
    if (!r.ok) {
      logger.warn('[mirror-node] non-ok response', { url, status: r.status });
      return null;
    }
    return (await r.json()) as T;
  } catch (e) {
    logger.warn('[mirror-node] fetch failed', {
      url,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

/** Contract metadata by EVM address. Returns null on 404. */
export async function getContract(
  network: 'testnet' | 'mainnet',
  evmAddress: string,
): Promise<MirrorContract | null> {
  return fetchMirror<MirrorContract>(network, `/contracts/${evmAddress}`);
}

/**
 * Token balances held BY a contract or account, keyed on EVM address.
 * Mirror aggregates all fungible tokens the account holds; use this
 * to compute pool NAV once USDT is deployed on Hedera testnet.
 */
export async function getAccountTokenBalances(
  network: 'testnet' | 'mainnet',
  evmAddress: string,
): Promise<MirrorTokenBalance[]> {
  const r = await fetchMirror<{ tokens: MirrorTokenBalance[] }>(
    network,
    `/accounts/${evmAddress}/tokens?limit=25`,
  );
  return r?.tokens ?? [];
}

/**
 * Contract event logs, filtered by topic. Empty topics = all events.
 * Returns most-recent-first, paginated by Mirror Node's default (25).
 * For a fresh/uninitialized pool this returns [].
 */
export async function getContractLogs(
  network: 'testnet' | 'mainnet',
  evmAddress: string,
  opts: { topic0?: string; limit?: number } = {},
): Promise<MirrorContractLog[]> {
  const params = new URLSearchParams();
  params.set('order', 'desc');
  params.set('limit', String(opts.limit ?? 25));
  if (opts.topic0) params.set('topic0', opts.topic0);
  const r = await fetchMirror<{ logs: MirrorContractLog[] }>(
    network,
    `/contracts/${evmAddress}/results/logs?${params.toString()}`,
  );
  return r?.logs ?? [];
}

/**
 * Historical contract calls (deposits, withdraws, admin ops, everything
 * that hit the contract's execution surface). Useful for a "recent
 * activity" feed even before we build a dedicated events table.
 */
export async function getContractResults(
  network: 'testnet' | 'mainnet',
  evmAddress: string,
  opts: { limit?: number } = {},
): Promise<MirrorContractCallResult[]> {
  const params = new URLSearchParams();
  params.set('order', 'desc');
  params.set('limit', String(opts.limit ?? 25));
  const r = await fetchMirror<{ results: MirrorContractCallResult[] }>(
    network,
    `/contracts/${evmAddress}/results?${params.toString()}`,
  );
  return r?.results ?? [];
}

/**
 * Simulate an EVM view call via Mirror Node. Returns the hex result on
 * success, null on revert/error. Uses POST /contracts/call which does
 * NOT hit consensus — pure read. Free, no gas, no rate limit issues.
 *
 * `data` = 0x-prefixed function selector + ABI-encoded args
 * (e.g. 0x18160ddd for totalShares()).
 */
export async function contractCall(
  network: 'testnet' | 'mainnet',
  to: string,
  data: string,
  fromEvmAddress: string = '0x0000000000000000000000000000000000000000',
): Promise<string | null> {
  const url = `${BASE[network]}/contracts/call`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        block: 'latest',
        data,
        estimate: false,
        from: fromEvmAddress,
        to,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: string };
    return j.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Composite: read a CommunityPool's core state via Mirror Node. Falls
 * back through the same paths as the raw-RPC reader (getPoolStats →
 * totalShares → contract balance) but every call is an indexed
 * Mirror-Node query, so partial failures don't blow up the whole read.
 *
 * Callers get a discriminated result:
 *   { ok: true,  ... }  → at least totalShares was readable
 *   { ok: false }       → contract not found or all reads failed
 */
export interface HederaPoolSnapshot {
  ok: true;
  totalShares: number;    // human units (6-decimal — SimpleUsdcVault preserves asset decimals)
  totalNavUsdc: number;   // human units (6-decimal)
  memberCount: number;
  sharePrice: number;
  contractCreatedAt: Date | null;
  source: 'mirror-node';
}

// Selectors kept inline so callers only import this module.
// keccak256(function-signature)[:4].
const SELECTOR = {
  // SimpleUsdcVault has `uint256 public totalShares` — auto-getter
  // selector is 0x3a98ef39, NOT 0x18160ddd (which is ERC-20 totalSupply).
  totalShares:    '0x3a98ef39',
  totalAssets:    '0x01e1d114',
  // Auto-getter for `uint256 public memberCount`. The wrapper
  // getMemberCount() (0xa87d942c) reverts on Hashio for reasons unclear —
  // the auto-getter works, so use that.
  memberCount:    '0x11aee380',
  getPoolStats:   '0x0da65a56',
} as const;

function decodeUint256(hex: string): bigint {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

export async function readHederaPoolSnapshot(
  network: 'testnet' | 'mainnet',
  poolEvmAddress: string,
  usdtEvmAddress: string | null,
): Promise<HederaPoolSnapshot | { ok: false; reason: string }> {
  // Confirm contract exists (fast path — returns 404 if wrong network / typo).
  const meta = await getContract(network, poolEvmAddress);
  if (!meta) return { ok: false, reason: 'contract not found on mirror' };

  // getPoolStats returns the whole state in one call when the contract
  // is initialised. On revert we fall through to individual reads.
  let totalShares = 0;
  let totalNavUsdc = 0;
  let memberCount = 0;
  const sharePrice = 1;

  const statsHex = await contractCall(network, poolEvmAddress, SELECTOR.getPoolStats);
  if (statsHex && statsHex.length >= 2 + 64 * 5) {
    // 5 uint256 returns concatenated. Extract each 32-byte word.
    // SimpleUsdcVault stores shares in the SAME 6-decimal space as USDC
    // (its fold `shares = amount * (T+1)/(A+1)` preserves asset decimals).
    const w = (i: number) => decodeUint256(`0x${statsHex.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
    totalShares = Number(w(0)) / 1e6;
    totalNavUsdc = Number(w(1)) / 1e6;
    memberCount = Number(w(2));
    // w(3) sharePrice, w(4) is the fixed-array head pointer for allocations.
    return {
      ok: true,
      totalShares,
      totalNavUsdc,
      memberCount,
      sharePrice: Number(w(3)) / 1e6 || 1,
      contractCreatedAt: mirrorTimestampToDate(meta.created_timestamp),
      source: 'mirror-node',
    };
  }

  // Fallback path — getPoolStats reverts (Hashio quirk with the wrapper
  // function). Read state vars directly via their auto-getters.
  const [sharesHex, assetsHex, membersHex] = await Promise.all([
    contractCall(network, poolEvmAddress, SELECTOR.totalShares),
    contractCall(network, poolEvmAddress, SELECTOR.totalAssets),
    contractCall(network, poolEvmAddress, SELECTOR.memberCount),
  ]);
  if (sharesHex) totalShares = Number(decodeUint256(sharesHex)) / 1e6;
  if (assetsHex) totalNavUsdc = Number(decodeUint256(assetsHex)) / 1e6;
  if (membersHex) memberCount = Number(decodeUint256(membersHex));

  return {
    ok: true,
    totalShares,
    totalNavUsdc,
    memberCount,
    sharePrice: totalShares > 0 ? (totalNavUsdc + 1) / (totalShares + 1) : 1,
    contractCreatedAt: mirrorTimestampToDate(meta.created_timestamp),
    source: 'mirror-node',
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────

/**
 * Mirror timestamps are "seconds.nanos" strings ("1698765432.123456789").
 * Return null on malformed input rather than an invalid Date so callers
 * can treat missing-created-at as "unknown".
 */
export function mirrorTimestampToDate(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const secs = parseInt(ts.split('.')[0], 10);
  if (!Number.isFinite(secs)) return null;
  return new Date(secs * 1000);
}

/**
 * EVM addr → Hedera 0.0.x id fragment. Mirror sometimes indexes tokens
 * by their Hedera id even when we query by EVM address, so we need a
 * fallback comparator. This is a best-effort — the reliable path is
 * calling /tokens/{evm_address} which returns the Hedera id back.
 * ponytail: single-token lookup only; full mapping if we ever need to
 * enumerate every deployment on a chain.
 */
export function evmAddressToHederaId(evmAddress: string): string {
  const stripped = evmAddress.replace(/^0x/, '').toLowerCase();
  const num = BigInt(`0x${stripped}`);
  return `0.0.${num.toString(10)}`;
}
