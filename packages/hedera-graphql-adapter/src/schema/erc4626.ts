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

import { MirrorClient } from '../mirror.js';
import { decodeUint, normalizeLog, topicToAddress } from '../events.js';
import type { HederaNetwork } from '../types.js';

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
}

export function createErc4626Preset(opts: Erc4626PresetOptions) {
  const { client, contract, network, networkLabel = `hedera-${network}`, decimals = 6 } = opts;
  const decimalsMultiplier = 10n ** BigInt(decimals);
  const vaultAddress = contract.toLowerCase();

  async function fetchPool(): Promise<PoolShape | null> {
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
  }

  async function fetchTransactions(limit: number, filter?: { type?: string; actor?: string }): Promise<TxShape[]> {
    // Fetch broad; filter client-side. Mirror topic0 filter has quirks
    // on some deployments, so we grab everything and dispatch.
    const logs = await client.getContractLogs(vaultAddress, { limit: Math.min(limit * 3, 100) });
    const rows: TxShape[] = [];
    for (const raw of logs) {
      const log = normalizeLog(raw);
      let type: 'DEPOSIT' | 'WITHDRAW' | null = null;
      if (log.topic0 === ERC4626_TOPICS.Deposited) type = 'DEPOSIT';
      else if (log.topic0 === ERC4626_TOPICS.Withdrawn) type = 'WITHDRAW';
      if (!type) continue;
      if (filter?.type && filter.type !== type) continue;

      const actor = topicToAddress(log.indexedTopics[0]);
      if (filter?.actor && filter.actor.toLowerCase() !== actor) continue;

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
      if (rows.length >= limit) break;
    }
    return rows;
  }

  async function fetchMembers(limit: number): Promise<MemberShape[]> {
    const txs = await fetchTransactions(200);
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
        pools: async (_r: unknown, args: { first?: number; where?: { id?: string; network?: string } }) => {
          if (args.where?.id && args.where.id.toLowerCase() !== vaultAddress) return [];
          if (args.where?.network && args.where.network !== networkLabel) return [];
          const p = await fetchPool();
          return p ? [p].slice(0, args.first ?? 10) : [];
        },
        transactions: async (_r: unknown, args: { first?: number; where?: { type?: string; actor?: string } }) => {
          return await fetchTransactions(args.first ?? 25, args.where);
        },
        members: async (_r: unknown, args: { first?: number }) => {
          return await fetchMembers(args.first ?? 25);
        },
        _meta: async () => {
          const nowSec = Math.floor(Date.now() / 1000);
          const txs = await fetchTransactions(1).catch(() => []);
          const lastBlock = txs[0] ? Number(txs[0].blockNumber) : 0;
          return {
            block: { number: lastBlock, timestamp: nowSec },
            deployment: `hedera-mirror-adapter:${vaultAddress}`,
            hasIndexingErrors: false,
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
