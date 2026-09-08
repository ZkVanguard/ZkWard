/**
 * ERC-4626 preset — maps Deposited / Withdrawn events into the
 * standardized Pool / Transaction / Member entity shape.
 *
 * Contract shape expected:
 *   event Deposited(address indexed member, uint256 amount, uint256 shares)
 *   event Withdrawn(address indexed member, uint256 shares, uint256 amount)
 *
 * View methods used (via Mirror eth_call bridge):
 *   totalShares() → uint256 (SimpleUsdcVault style; falls back to totalSupply)
 *   totalAssets() → uint256
 *   memberCount() → uint256 (optional; derived from tx stream if missing)
 */

import { MirrorClient } from '../mirror';
import { decodeUint, normalizeLog, topicToAddress } from '../events';
import type { HederaNetwork } from '../types';

// Precomputed topic0 hashes to avoid a keccak dependency. Verified via
// keccak256(utf8Bytes("EventName(argTypes)")).
export const ERC4626_TOPICS = {
  Deposited: '0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca',
  Withdrawn: '0x92ccf450a286a957af52509bc1c9939d1a6a481783e142e41e2499f0bb66ebc6',
} as const;

// Common storage-getter selectors. SimpleUsdcVault uses auto-getters
// that differ from ERC-20 conventions; we probe.
export const ERC4626_SELECTORS = {
  // uint256 public totalShares — 0x3a98ef39
  totalShares: '0x3a98ef39',
  // uint256 public totalSupply — 0x18160ddd (ERC-20 fallback)
  totalSupply: '0x18160ddd',
  // uint256 public totalAssets — 0x01e1d114
  totalAssets: '0x01e1d114',
  // uint256 public memberCount — 0x11aee380 (SimpleUsdcVault-specific)
  memberCount: '0x11aee380',
} as const;

interface PoolShape {
  id: string;
  network: string;
  totalShares: string;
  totalNav: string;
  sharePrice: string;
  memberCount: number;
  totalFeesCollected: string;
  createdAtBlock: string;
  createdAtTimestamp: string;
  updatedAtBlock: string | null;
  updatedAtTimestamp: string | null;
}

interface TxShape {
  id: string;
  pool: string;
  type: 'DEPOSIT' | 'WITHDRAW';
  actor: string;
  amount: string;
  shares: string;
  sharePrice: string;
  blockNumber: string;
  timestamp: string;
  transactionHash: string;
}

interface MemberShape {
  id: string;
  pool: string;
  address: string;
  currentShares: string;
  totalDeposited: string;
  totalWithdrawn: string;
  joinedAtBlock: string;
  joinedAtTimestamp: string;
  lastActionAtBlock: string | null;
  lastActionAtTimestamp: string | null;
}

/**
 * Standard-subgraph filter operators. Applies a `where` map with any mix of
 *   { field, field_not, field_in, field_not_in, field_gt, field_gte, field_lt,
 *     field_lte, field_contains } to an array of rows. Matches the ops Graph
 * tooling auto-generates. Numeric ops use BigInt to survive uint256 values.
 * Missing/undefined fields are silently ignored — matches Graph semantics.
 */
function applyWhereFilter<T>(rows: T[], where?: Record<string, unknown>): T[] {
  if (!where || Object.keys(where).length === 0) return rows;
  return rows.filter((row) => {
    for (const [key, expected] of Object.entries(where)) {
      if (expected === null || expected === undefined) continue;

      const m = key.match(/^(.+?)_(gt|gte|lt|lte|in|not_in|not|contains|starts_with|ends_with)$/);
      const field = m ? m[1] : key;
      const op = m ? m[2] : 'eq';
      const raw = (row as Record<string, unknown>)[field];
      if (raw === undefined) return false;

      // Bytes comparisons are case-insensitive to match Graph subgraph behavior.
      const asString = String(raw);
      const asLower = asString.toLowerCase();

      if (op === 'eq') {
        if (asLower !== String(expected).toLowerCase()) return false;
      } else if (op === 'not') {
        if (asLower === String(expected).toLowerCase()) return false;
      } else if (op === 'in') {
        const list = Array.isArray(expected) ? expected.map((v) => String(v).toLowerCase()) : [];
        if (!list.includes(asLower)) return false;
      } else if (op === 'not_in') {
        const list = Array.isArray(expected) ? expected.map((v) => String(v).toLowerCase()) : [];
        if (list.includes(asLower)) return false;
      } else if (op === 'contains') {
        if (!asLower.includes(String(expected).toLowerCase())) return false;
      } else if (op === 'starts_with') {
        if (!asLower.startsWith(String(expected).toLowerCase())) return false;
      } else if (op === 'ends_with') {
        if (!asLower.endsWith(String(expected).toLowerCase())) return false;
      } else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
        // Prefer BigInt for numeric strings (uint256-safe). Fall back to Number.
        let av: bigint | number, bv: bigint | number;
        try {
          av = BigInt(asString);
          bv = BigInt(String(expected));
        } catch {
          av = Number(asString);
          bv = Number(expected);
        }
        if (op === 'gt' && !(av > bv)) return false;
        if (op === 'gte' && !(av >= bv)) return false;
        if (op === 'lt' && !(av < bv)) return false;
        if (op === 'lte' && !(av <= bv)) return false;
      }
    }
    return true;
  });
}

function decodeUint256Response(hex: string | null): bigint {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex.length > 66 ? '0x' + hex.slice(2, 66) : hex);
}

async function readViewUint(client: MirrorClient, address: string, selector: string, fallback?: string): Promise<bigint> {
  const primary = await client.contractCall(address, selector);
  if (primary && primary !== '0x') return decodeUint256Response(primary);
  if (fallback) {
    const alt = await client.contractCall(address, fallback);
    if (alt && alt !== '0x') return decodeUint256Response(alt);
  }
  return 0n;
}

export interface Erc4626PresetOptions {
  client: MirrorClient;
  contract: string;
  network: HederaNetwork;
  /** Human-readable network label emitted on Pool.network. Default "hedera-{network}". */
  networkLabel?: string;
  /** Assumed asset decimals (default 6 for USDC-style vaults). */
  decimals?: number;
  /** TTL for pool / logs cache in ms. Default 30000. Set to 0 to disable. */
  cacheTtlMs?: number;
  /** Optional HCS topic ID (0.0.x) carrying x402 receipts + hedge projections
   *  to expose via the `signals` GraphQL query. */
  auditTopicId?: string;
}

interface NavSnapshotShape {
  id: string;
  timestamp: string;
  totalNavUsd: string;
  hcsSeq: number | null;
}

/** Reconstruct a NavSnapshot from a hedge-projection HCS message. */
function decodeNavSnapshot(msg: {
  sequence_number: number;
  consensus_timestamp: string;
  message: string;
}): NavSnapshotShape | null {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(msg.message, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p.kind !== 'hedge-projection' || typeof p.poolNavUsd !== 'number') return null;
  const seq = msg.sequence_number;
  const ts = String(parseInt(msg.consensus_timestamp.split('.')[0] || '0', 10));
  // Store in 6-decimal micros to match the rest of the schema.
  const navMicros = BigInt(Math.round(p.poolNavUsd * 1_000_000));
  return {
    id: `hcs-nav-${seq}`,
    timestamp: ts,
    totalNavUsd: navMicros.toString(),
    hcsSeq: seq,
  };
}

interface SignalShape {
  id: string;
  asset: string;
  direction: string;
  confidence: number;
  source: string;
  timestamp: string;
  hcsSeq: number | null;
  hcsTxId: string | null;
}

/** Reconstruct a Signal from any HCS message we know how to parse. */
function decodeSignal(msg: {
  sequence_number: number;
  consensus_timestamp: string;
  message: string;
}): SignalShape[] {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(msg.message, 'base64').toString('utf8'));
  } catch {
    return [];
  }
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;
  const seq = msg.sequence_number;
  const ts = String(parseInt(msg.consensus_timestamp.split('.')[0] || '0', 10));
  const baseId = `hcs-${seq}`;

  // x402-payment-receipt: { asset, signal, confidence, paid, ts }
  if (typeof p.asset === 'string' && typeof p.signal === 'string' && typeof p.confidence === 'number') {
    return [{
      id: baseId,
      asset: p.asset,
      direction: p.signal,
      confidence: Math.round(p.confidence),
      source: 'x402-payment-receipt',
      timestamp: ts,
      hcsSeq: seq,
      hcsTxId: null,
    }];
  }

  // hedge-projection: { kind: 'hedge-projection', positions: [{ symbol, side, signalConfidence }] }
  if (p.kind === 'hedge-projection' && Array.isArray(p.positions)) {
    const rows: SignalShape[] = [];
    for (const pos of p.positions as Array<Record<string, unknown>>) {
      if (typeof pos.symbol !== 'string' || typeof pos.side !== 'string') continue;
      // side is LONG/SHORT → normalize to BULLISH/BEARISH so consumers can filter
      const direction = pos.side === 'SHORT' ? 'BEARISH' : pos.side === 'LONG' ? 'BULLISH' : String(pos.side);
      rows.push({
        id: `${baseId}-${String(pos.symbol)}`,
        asset: pos.symbol,
        direction,
        confidence: typeof pos.signalConfidence === 'number' ? Math.round(pos.signalConfidence) : 0,
        source: 'hedge-projection',
        timestamp: ts,
        hcsSeq: seq,
        hcsTxId: null,
      });
    }
    return rows;
  }

  return [];
}

/**
 * Time-bounded memoizer. Same key + same window → same promise (which
 * means concurrent callers within the window share the in-flight request
 * and multi-field queries only pay the network cost once).
 */
function ttlMemo<T>(ttlMs: number): (key: string, fn: () => Promise<T>) => Promise<T> {
  const cache = new Map<string, { at: number; value: Promise<T> }>();
  return (key, fn) => {
    if (ttlMs <= 0) return fn();
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
    const value = fn().catch((e) => { cache.delete(key); throw e; });
    cache.set(key, { at: now, value });
    return value;
  };
}

export function createErc4626Preset(opts: Erc4626PresetOptions) {
  const { client, contract, network, networkLabel = `hedera-${network}`, decimals = 6, cacheTtlMs = 30_000, auditTopicId } = opts;
  const decimalsMultiplier = 10n ** BigInt(decimals);
  const vaultAddress = contract.toLowerCase();
  const memo = ttlMemo<unknown>(cacheTtlMs);

  async function fetchNavHistory(limit: number): Promise<NavSnapshotShape[]> {
    if (!auditTopicId) return [];
    // Always fetch the max Mirror allows — hedge-projection messages are
    // interleaved with x402 + attestation messages, so a small `first`
    // must still scan a wide window to surface any nav snapshots.
    // v0.6 will add real pagination via Mirror's `?next` link.
    const raw = await memo(
      `nav-history:${auditTopicId}`,
      () => client.getTopicMessages(auditTopicId, { limit: 100, order: 'desc' }),
    ) as Awaited<ReturnType<typeof client.getTopicMessages>>;
    const decoded: NavSnapshotShape[] = [];
    for (const msg of raw) {
      const snap = decodeNavSnapshot(msg);
      if (snap) decoded.push(snap);
    }
    return decoded.slice(0, limit);
  }

  async function fetchSignals(limit: number, skip: number, filter?: Record<string, unknown>): Promise<SignalShape[]> {
    if (!auditTopicId) return [];
    const raw = await memo(
      `signals:${auditTopicId}`,
      () => client.getTopicMessages(auditTopicId, { limit: 100 }),
    ) as Awaited<ReturnType<typeof client.getTopicMessages>>;

    const decoded: SignalShape[] = [];
    for (const msg of raw) {
      for (const s of decodeSignal(msg)) decoded.push(s);
    }
    const filtered = applyWhereFilter(decoded, filter);
    return filtered.slice(skip, skip + limit);
  }

  function fetchPool(): Promise<PoolShape | null> {
    return memo(`pool:${vaultAddress}`, async () => {
      const meta = await client.getContract(vaultAddress);
      if (!meta) return null;

      const [totalShares, totalAssets, memberCount] = await Promise.all([
        readViewUint(client, vaultAddress, ERC4626_SELECTORS.totalShares, ERC4626_SELECTORS.totalSupply),
        readViewUint(client, vaultAddress, ERC4626_SELECTORS.totalAssets),
        readViewUint(client, vaultAddress, ERC4626_SELECTORS.memberCount),
      ]);

      const sharePriceScaled = totalShares === 0n
        ? decimalsMultiplier
        : (totalAssets * decimalsMultiplier) / totalShares;

      const createdSec = meta.created_timestamp
        ? Math.floor(new Date(parseInt(meta.created_timestamp.split('.')[0]!, 10) * 1000).getTime() / 1000)
        : 0;

      return {
        id: vaultAddress,
        network: networkLabel,
        totalShares: totalShares.toString(),
        totalNav: totalAssets.toString(),
        sharePrice: sharePriceScaled.toString(),
        memberCount: Number(memberCount),
        totalFeesCollected: '0',
        createdAtBlock: '0',
        createdAtTimestamp: String(createdSec),
        updatedAtBlock: null,
        updatedAtTimestamp: String(Math.floor(Date.now() / 1000)),
      };
    }) as Promise<PoolShape | null>;
  }

  // Underlying log fetch is cached; per-request filter is cheap and stays
  // uncached so `where` variants remain accurate without cache-key blowup.
  function fetchAllLogsCached(): Promise<ReturnType<typeof client.getContractLogs>> {
    return memo(`logs:${vaultAddress}`, () => client.getContractLogs(vaultAddress, { limit: 100 })) as Promise<ReturnType<typeof client.getContractLogs>>;
  }

  async function fetchTransactions(
    limit: number,
    skip: number,
    filter?: Record<string, unknown>,
    orderBy?: string,
    orderDirection?: 'asc' | 'desc',
  ): Promise<TxShape[]> {
    const logs = await fetchAllLogsCached();
    let rows: TxShape[] = [];
    for (const raw of logs) {
      const log = normalizeLog(raw);
      let type: 'DEPOSIT' | 'WITHDRAW' | null = null;
      if (log.topic0 === ERC4626_TOPICS.Deposited) type = 'DEPOSIT';
      else if (log.topic0 === ERC4626_TOPICS.Withdrawn) type = 'WITHDRAW';
      if (!type) continue;

      const actor = topicToAddress(log.indexedTopics[0]);

      // Deposited(amount, shares) — amount first
      // Withdrawn(shares, amount) — shares first
      const [w0, w1] = [decodeUint(log.data, 0), decodeUint(log.data, 1)];
      const amount = type === 'DEPOSIT' ? w0 : w1;
      const shares = type === 'DEPOSIT' ? w1 : w0;

      rows.push({
        id: `${log.transactionHash}-${log.logIndex}`,
        pool: vaultAddress,
        type,
        actor,
        amount: amount.toString(),
        shares: shares.toString(),
        sharePrice: '0',
        blockNumber: String(log.block),
        timestamp: String(log.timestampSec),
        transactionHash: log.transactionHash,
      });
    }

    rows = applyWhereFilter(rows, filter);

    // Sort in-place if the caller specified an orderBy the schema declares.
    // Uses BigInt compare for the numeric columns so 32-byte values sort right.
    const sortable: Record<string, (r: TxShape) => bigint> = {
      timestamp: (r) => BigInt(r.timestamp),
      blockNumber: (r) => BigInt(r.blockNumber),
      amount: (r) => BigInt(r.amount),
      shares: (r) => BigInt(r.shares),
    };
    const key = orderBy && sortable[orderBy] ? sortable[orderBy] : sortable.timestamp;
    const dir = orderDirection === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = key(a), bv = key(b);
      return av === bv ? 0 : (av < bv ? -1 : 1) * dir;
    });

    return rows.slice(skip, skip + limit);
  }

  async function findTransactionById(id: string): Promise<TxShape | null> {
    const rows = await fetchTransactions(1000, 0);
    return rows.find((t) => t.id === id) ?? null;
  }

  async function findMemberById(id: string): Promise<MemberShape | null> {
    const rows = await fetchMembers(1000);
    return rows.find((m) => m.id.toLowerCase() === id.toLowerCase()) ?? null;
  }

  async function fetchMembers(limit: number): Promise<MemberShape[]> {
    const txs = await fetchTransactions(200, 0);
    const acc = new Map<string, MemberShape>();
    for (const tx of txs) {
      let m = acc.get(tx.actor);
      if (!m) {
        m = {
          id: `${vaultAddress}-${tx.actor}`,
          pool: vaultAddress,
          address: tx.actor,
          currentShares: '0',
          totalDeposited: '0',
          totalWithdrawn: '0',
          joinedAtBlock: tx.blockNumber,
          joinedAtTimestamp: tx.timestamp,
          lastActionAtBlock: tx.blockNumber,
          lastActionAtTimestamp: tx.timestamp,
        };
        acc.set(tx.actor, m);
      }
      const cur = BigInt(m.currentShares);
      if (tx.type === 'DEPOSIT') {
        m.currentShares = (cur + BigInt(tx.shares)).toString();
        m.totalDeposited = (BigInt(m.totalDeposited) + BigInt(tx.amount)).toString();
      } else {
        m.currentShares = (cur - BigInt(tx.shares)).toString();
        m.totalWithdrawn = (BigInt(m.totalWithdrawn) + BigInt(tx.amount)).toString();
      }
      m.lastActionAtBlock = tx.blockNumber;
      m.lastActionAtTimestamp = tx.timestamp;
    }
    return Array.from(acc.values()).slice(0, limit);
  }

  return {
    fetchPool,
    fetchTransactions,
    fetchMembers,
    resolvers: {
      Query: {
        pool: async (_r: unknown, args: { id: string }) => {
          if (args.id.toLowerCase() !== vaultAddress) return null;
          return await fetchPool();
        },
        pools: async (_r: unknown, args: { first?: number; skip?: number; where?: Record<string, unknown> }) => {
          const p = await fetchPool();
          const all: PoolShape[] = p ? [p] : [];
          const filtered = applyWhereFilter(all as unknown as Record<string, unknown>[], args.where) as unknown as PoolShape[];
          const skip = args.skip ?? 0;
          return filtered.slice(skip, skip + (args.first ?? 10));
        },
        transaction: async (_r: unknown, args: { id: string }) => {
          return await findTransactionById(args.id);
        },
        transactions: async (_r: unknown, args: { first?: number; skip?: number; where?: Record<string, unknown>; orderBy?: string; orderDirection?: 'asc' | 'desc' }) => {
          return await fetchTransactions(args.first ?? 25, args.skip ?? 0, args.where, args.orderBy, args.orderDirection);
        },
        member: async (_r: unknown, args: { id: string }) => {
          return await findMemberById(args.id);
        },
        members: async (_r: unknown, args: { first?: number; skip?: number }) => {
          const all = await fetchMembers(1000);
          const skip = args.skip ?? 0;
          return all.slice(skip, skip + (args.first ?? 25));
        },
        signals: async (_r: unknown, args: { first?: number; skip?: number; where?: Record<string, unknown> }) => {
          return await fetchSignals(args.first ?? 25, args.skip ?? 0, args.where);
        },
        navHistory: async (_r: unknown, args: { first?: number; skip?: number }) => {
          const all = await fetchNavHistory(1000);
          const skip = args.skip ?? 0;
          return all.slice(skip, skip + (args.first ?? 100));
        },
        _meta: async () => {
          // Fast path — Mirror's /blocks endpoint is one call vs walking
          // a full log record. Cached for the same TTL as pool state.
          const block = await memo(`block:latest`, () => client.getLatestBlock()) as Awaited<ReturnType<typeof client.getLatestBlock>>;
          return {
            block: {
              number: block?.number ?? 0,
              timestamp: block?.timestampSec ?? Math.floor(Date.now() / 1000),
            },
            deployment: `hedera-mirror-adapter:${vaultAddress}`,
            // Reflects whether ANY Mirror Node request has failed since the
            // client booted (or since clearIndexingErrors() was called).
            // Downstream consumers can gate on this like they would with a
            // Graph subgraph reporting indexer lag.
            hasIndexingErrors: client.hasIndexingErrors,
          };
        },
      },
      Transaction: {
        pool: async () => await fetchPool(),
      },
      Member: {
        pool: async () => await fetchPool(),
      },
    },
  };
}
