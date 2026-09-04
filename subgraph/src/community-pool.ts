/**
 * ZkWard Standardized Vault mappings.
 *
 * Handlers here translate on-chain events into the standardized entity
 * shapes defined in ../schema.graphql. Kept mechanical — one handler
 * per event, minimal derivation logic — so a competitor AI vault that
 * emits the same event surface can reuse this file with only the
 * contract address swapped.
 *
 * Types (Pool, NavSnapshot, etc.) come from `graph codegen` — run that
 * after cloning + placing the CommunityPool ABI at ../abis/CommunityPool.json.
 */

import { Address, BigInt as BI, Bytes } from '@graphprotocol/graph-ts';
import {
  Deposited,
  Withdrawn,
  Rebalanced,
  RebalanceTradeExecuted,
  AllocationUpdated,
  PoolHedgeOpened,
  PoolHedgeClosed,
  FeesCollected,
  FeesWithdrawn,
  MemberJoined,
} from '../generated/CommunityPool/CommunityPool';
import {
  Pool,
  NavSnapshot,
  PoolAllocation,
  Rebalance,
  RebalanceTrade,
  Hedge,
  Transaction,
  Member,
} from '../generated/schema';

// ─── Helpers ───────────────────────────────────────────────────────────────

const ZERO_BI = BI.fromI32(0);

function poolId(addr: Address): Bytes {
  return Bytes.fromByteArray(Bytes.fromHexString(addr.toHexString()));
}

function loadOrCreatePool(addr: Address, block: BI, ts: BI): Pool {
  const id = poolId(addr);
  let pool = Pool.load(id);
  if (pool === null) {
    pool = new Pool(id);
    pool.network = 'sepolia'; // Updated per-deployment in subgraph.yaml scope
    pool.totalShares = ZERO_BI;
    pool.totalNav = ZERO_BI;
    pool.sharePrice = ZERO_BI;
    pool.memberCount = 0;
    pool.totalFeesCollected = ZERO_BI;
    pool.createdAtBlock = block;
    pool.createdAtTimestamp = ts;
  }
  pool.updatedAtBlock = block;
  pool.updatedAtTimestamp = ts;
  return pool as Pool;
}

function txEntityId(hash: Bytes, logIndex: BI): Bytes {
  return hash.concat(Bytes.fromByteArray(Bytes.fromBigInt(logIndex)));
}

// ─── Deposits / Withdrawals ────────────────────────────────────────────────

export function handleDeposited(event: Deposited): void {
  const pool = loadOrCreatePool(event.address, event.block.number, event.block.timestamp);
  pool.totalShares = pool.totalShares.plus(event.params.sharesReceived);
  pool.sharePrice = event.params.sharePrice;
  pool.save();

  const tx = new Transaction(txEntityId(event.transaction.hash, event.logIndex));
  tx.pool = pool.id;
  tx.type = 'DEPOSIT';
  tx.actor = event.params.member;
  tx.amount = event.params.amountUSD;
  tx.shares = event.params.sharesReceived;
  tx.sharePrice = event.params.sharePrice;
  tx.blockNumber = event.block.number;
  tx.timestamp = event.block.timestamp;
  tx.transactionHash = event.transaction.hash;
  tx.save();

  writeNavSnapshot(pool, event.block.number, event.block.timestamp, event.transaction.hash, event.logIndex);
  updateMember(pool, event.params.member, event.params.sharesReceived, event.params.amountUSD, ZERO_BI, event.block.number, event.block.timestamp);
}

export function handleWithdrawn(event: Withdrawn): void {
  const pool = loadOrCreatePool(event.address, event.block.number, event.block.timestamp);
  pool.totalShares = pool.totalShares.minus(event.params.sharesBurned);
  pool.sharePrice = event.params.sharePrice;
  pool.save();

  const tx = new Transaction(txEntityId(event.transaction.hash, event.logIndex));
  tx.pool = pool.id;
  tx.type = 'WITHDRAW';
  tx.actor = event.params.member;
  tx.amount = event.params.amountUSD;
  tx.shares = event.params.sharesBurned;
  tx.sharePrice = event.params.sharePrice;
  tx.blockNumber = event.block.number;
  tx.timestamp = event.block.timestamp;
  tx.transactionHash = event.transaction.hash;
  tx.save();

  writeNavSnapshot(pool, event.block.number, event.block.timestamp, event.transaction.hash, event.logIndex);
  updateMember(pool, event.params.member, event.params.sharesBurned.neg(), ZERO_BI, event.params.amountUSD, event.block.number, event.block.timestamp);
}

// ─── Rebalance ─────────────────────────────────────────────────────────────

export function handleRebalanced(event: Rebalanced): void {
  const pool = loadOrCreatePool(event.address, event.block.number, event.block.timestamp);
  pool.save();

  const rebalance = new Rebalance(txEntityId(event.transaction.hash, event.logIndex));
  rebalance.pool = pool.id;
  rebalance.executor = event.params.executor;
  const prev = event.params.previousBps;
  const next = event.params.newBps;
  const prevArr = new Array<BI>(prev.length);
  const nextArr = new Array<BI>(next.length);
  for (let i = 0; i < prev.length; i++) {
    prevArr[i] = prev[i];
    nextArr[i] = next[i];
  }
  rebalance.previousBps = prevArr;
  rebalance.newBps = nextArr;
  rebalance.reasonHash = event.params.reasonHash;
  rebalance.blockNumber = event.block.number;
  rebalance.timestamp = event.block.timestamp;
  rebalance.transactionHash = event.transaction.hash;
  rebalance.save();
}

export function handleRebalanceTradeExecuted(event: RebalanceTradeExecuted): void {
  // Trade entities are children of the enclosing Rebalance (same tx).
  // We attach by txHash prefix so mappings don't need a lookup keyed on the
  // rebalance logIndex specifically.
  const trade = new RebalanceTrade(txEntityId(event.transaction.hash, event.logIndex));
  // We use the tx hash to correlate — the sibling Rebalance entity id
  // starts with the same txHash prefix. Consumers query rebalances then
  // filter trades in-tx client-side, keeping mappings simple.
  trade.rebalance = event.transaction.hash;
  trade.assetIndex = event.params.assetIndex;
  trade.amountIn = event.params.amountIn;
  trade.amountOut = event.params.amountOut;
  trade.isBuy = event.params.isBuy;
  trade.blockNumber = event.block.number;
  trade.timestamp = event.block.timestamp;
  trade.transactionHash = event.transaction.hash;
  trade.save();
}

// ─── Allocations ───────────────────────────────────────────────────────────

export function handleAllocationUpdated(event: AllocationUpdated): void {
  const pool = loadOrCreatePool(event.address, event.block.number, event.block.timestamp);
  const idBytes = pool.id.concat(Bytes.fromByteArray(Bytes.fromI32(event.params.assetIndex)));
  let alloc = PoolAllocation.load(idBytes);
  if (alloc === null) {
    alloc = new PoolAllocation(idBytes);
    alloc.pool = pool.id;
    alloc.assetIndex = event.params.assetIndex;
  }
  alloc.targetBps = event.params.newBps;
  alloc.updatedAtBlock = event.block.number;
  alloc.updatedAtTimestamp = event.block.timestamp;
  alloc.save();
}

// ─── Hedge Lifecycle ───────────────────────────────────────────────────────

export function handlePoolHedgeOpened(event: PoolHedgeOpened): void {
  const pool = loadOrCreatePool(event.address, event.block.number, event.block.timestamp);
  const hedge = new Hedge(event.params.hedgeId);
  hedge.pool = pool.id;
  hedge.pairIndex = event.params.pairIndex;
  hedge.collateralAmount = event.params.collateralAmount;
  hedge.leverage = event.params.leverage;
  hedge.isLong = event.params.isLong;
  hedge.status = 'OPEN';
  hedge.openReasonHash = event.params.reasonHash;
  hedge.openedAtBlock = event.block.number;
  hedge.openedAtTimestamp = event.block.timestamp;
  hedge.openedInTx = event.transaction.hash;
  hedge.save();
}

export function handlePoolHedgeClosed(event: PoolHedgeClosed): void {
  const hedge = Hedge.load(event.params.hedgeId);
  if (hedge === null) return; // Close before open — ignore, indexer will surface via subgraph errors
  hedge.status = 'CLOSED';
  hedge.closeReasonHash = event.params.reasonHash;
  hedge.realizedPnl = event.params.pnl;
  hedge.closedAtBlock = event.block.number;
  hedge.closedAtTimestamp = event.block.timestamp;
  hedge.closedInTx = event.transaction.hash;
  hedge.save();
}

// ─── Fees ──────────────────────────────────────────────────────────────────

export function handleFeesCollected(event: FeesCollected): void {
  const pool = loadOrCreatePool(event.address, event.block.number, event.block.timestamp);
  const total = event.params.managementFee.plus(event.params.performanceFee);
  pool.totalFeesCollected = pool.totalFeesCollected.plus(total);
  pool.save();

  const tx = new Transaction(txEntityId(event.transaction.hash, event.logIndex));
  tx.pool = pool.id;
  tx.type = 'FEES_COLLECTED';
  tx.actor = event.address;
  tx.amount = total;
  tx.shares = ZERO_BI;
  tx.sharePrice = ZERO_BI;
  tx.managementFeeAmount = event.params.managementFee;
  tx.performanceFeeAmount = event.params.performanceFee;
  tx.blockNumber = event.block.number;
  tx.timestamp = event.block.timestamp;
  tx.transactionHash = event.transaction.hash;
  tx.save();
}

export function handleFeesWithdrawn(event: FeesWithdrawn): void {
  const pool = loadOrCreatePool(event.address, event.block.number, event.block.timestamp);
  const tx = new Transaction(txEntityId(event.transaction.hash, event.logIndex));
  tx.pool = pool.id;
  tx.type = 'FEES_WITHDRAWN';
  tx.actor = event.params.treasury;
  tx.amount = event.params.amount;
  tx.shares = ZERO_BI;
  tx.sharePrice = ZERO_BI;
  tx.blockNumber = event.block.number;
  tx.timestamp = event.block.timestamp;
  tx.transactionHash = event.transaction.hash;
  tx.save();
}

// ─── Members ───────────────────────────────────────────────────────────────

export function handleMemberJoined(event: MemberJoined): void {
  const pool = loadOrCreatePool(event.address, event.block.number, event.block.timestamp);
  const mid = pool.id.concat(event.params.member);
  let member = Member.load(mid);
  if (member === null) {
    member = new Member(mid);
    member.pool = pool.id;
    member.address = event.params.member;
    member.currentShares = ZERO_BI;
    member.totalDeposited = ZERO_BI;
    member.totalWithdrawn = ZERO_BI;
    member.joinedAtBlock = event.block.number;
    member.joinedAtTimestamp = event.block.timestamp;
    pool.memberCount = pool.memberCount + 1;
    pool.save();
  }
  member.lastActionAtBlock = event.block.number;
  member.lastActionAtTimestamp = event.block.timestamp;
  member.save();
}

// ─── Internal ──────────────────────────────────────────────────────────────

function writeNavSnapshot(pool: Pool, block: BI, ts: BI, txHash: Bytes, logIndex: BI): void {
  const snap = new NavSnapshot(txEntityId(txHash, logIndex));
  snap.pool = pool.id;
  snap.totalNav = pool.totalNav; // NB: totalNav updates on Rebalance / off-chain oracle push, not on every deposit
  snap.totalShares = pool.totalShares;
  snap.sharePrice = pool.sharePrice;
  snap.blockNumber = block;
  snap.timestamp = ts;
  snap.transactionHash = txHash;
  snap.save();
}

function updateMember(
  pool: Pool,
  addr: Address,
  sharesDelta: BI,
  depositAmount: BI,
  withdrawAmount: BI,
  block: BI,
  ts: BI,
): void {
  const mid = pool.id.concat(addr);
  let member = Member.load(mid);
  if (member === null) {
    member = new Member(mid);
    member.pool = pool.id;
    member.address = addr;
    member.currentShares = ZERO_BI;
    member.totalDeposited = ZERO_BI;
    member.totalWithdrawn = ZERO_BI;
    member.joinedAtBlock = block;
    member.joinedAtTimestamp = ts;
  }
  member.currentShares = member.currentShares.plus(sharesDelta);
  member.totalDeposited = member.totalDeposited.plus(depositAmount);
  member.totalWithdrawn = member.totalWithdrawn.plus(withdrawAmount);
  member.lastActionAtBlock = block;
  member.lastActionAtTimestamp = ts;
  member.save();
}
