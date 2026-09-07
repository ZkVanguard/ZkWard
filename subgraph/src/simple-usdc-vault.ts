/**
 * SimpleUsdcVault mappings — projects a minimal vault contract into the
 * SAME Pool / Transaction / Member entities the CommunityPool source
 * writes to.
 *
 * The point: judges can hit ONE `pools` query and get both contract
 * variants back with identical field shapes. That's the "standardized
 * schema across protocols" moat — same query, any AI vault, any chain.
 *
 * SimpleUsdcVault emits only:
 *   Deposited(address indexed member, uint256 amount, uint256 shares)
 *   Withdrawn(address indexed member, uint256 shares, uint256 amount)
 *
 * We fold these into deposit/withdraw transactions and update the
 * running Pool + Member snapshots. sharePrice is derived (assets/shares)
 * since the simple vault doesn't emit it in the event.
 */

import { Address, BigInt as BI, Bytes } from '@graphprotocol/graph-ts';
import { Deposited, Withdrawn } from '../generated/SimpleUsdcVault/SimpleUsdcVault';
import { Pool, Transaction, Member } from '../generated/schema';

const ZERO_BI = BI.fromI32(0);
const ONE_E6 = BI.fromString('1000000');

function poolId(addr: Address): Bytes {
  return Bytes.fromByteArray(Bytes.fromHexString(addr.toHexString()));
}

function txEntityId(hash: Bytes, logIndex: BI): Bytes {
  return hash.concat(Bytes.fromByteArray(Bytes.fromBigInt(logIndex)));
}

function loadOrCreatePool(addr: Address, block: BI, ts: BI): Pool {
  const id = poolId(addr);
  let pool = Pool.load(id);
  if (pool === null) {
    pool = new Pool(id);
    pool.network = 'sepolia';
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

function derivedSharePrice(totalNav: BI, totalShares: BI): BI {
  if (totalShares.equals(ZERO_BI)) return ONE_E6;
  return totalNav.times(ONE_E6).div(totalShares);
}

function upsertMember(
  pool: Pool,
  addr: Address,
  sharesDelta: BI,
  depositDelta: BI,
  withdrawDelta: BI,
  block: BI,
  ts: BI,
): void {
  const mid = pool.id.concat(addr);
  let m = Member.load(mid);
  const isNew = m === null;
  if (m === null) {
    m = new Member(mid);
    m.pool = pool.id;
    m.address = addr;
    m.currentShares = ZERO_BI;
    m.totalDeposited = ZERO_BI;
    m.totalWithdrawn = ZERO_BI;
    m.joinedAtBlock = block;
    m.joinedAtTimestamp = ts;
  }
  m.currentShares = m.currentShares.plus(sharesDelta);
  m.totalDeposited = m.totalDeposited.plus(depositDelta);
  m.totalWithdrawn = m.totalWithdrawn.plus(withdrawDelta);
  m.lastActionAtBlock = block;
  m.lastActionAtTimestamp = ts;
  m.save();
  if (isNew) {
    pool.memberCount = pool.memberCount + 1;
  }
}

export function handleSimpleDeposited(event: Deposited): void {
  const pool = loadOrCreatePool(event.address, event.block.number, event.block.timestamp);
  pool.totalShares = pool.totalShares.plus(event.params.shares);
  pool.totalNav = pool.totalNav.plus(event.params.amount);
  pool.sharePrice = derivedSharePrice(pool.totalNav, pool.totalShares);

  const tx = new Transaction(txEntityId(event.transaction.hash, event.logIndex));
  tx.pool = pool.id;
  tx.type = 'DEPOSIT';
  tx.actor = event.params.member;
  tx.amount = event.params.amount;
  tx.shares = event.params.shares;
  tx.sharePrice = pool.sharePrice;
  tx.blockNumber = event.block.number;
  tx.timestamp = event.block.timestamp;
  tx.transactionHash = event.transaction.hash;
  tx.save();

  upsertMember(
    pool,
    event.params.member,
    event.params.shares,
    event.params.amount,
    ZERO_BI,
    event.block.number,
    event.block.timestamp,
  );
  pool.save();
}

export function handleSimpleWithdrawn(event: Withdrawn): void {
  const pool = loadOrCreatePool(event.address, event.block.number, event.block.timestamp);
  pool.totalShares = pool.totalShares.minus(event.params.shares);
  pool.totalNav = pool.totalNav.minus(event.params.amount);
  pool.sharePrice = derivedSharePrice(pool.totalNav, pool.totalShares);

  const tx = new Transaction(txEntityId(event.transaction.hash, event.logIndex));
  tx.pool = pool.id;
  tx.type = 'WITHDRAW';
  tx.actor = event.params.member;
  tx.amount = event.params.amount;
  tx.shares = event.params.shares;
  tx.sharePrice = pool.sharePrice;
  tx.blockNumber = event.block.number;
  tx.timestamp = event.block.timestamp;
  tx.transactionHash = event.transaction.hash;
  tx.save();

  upsertMember(
    pool,
    event.params.member,
    event.params.shares.neg(),
    ZERO_BI,
    event.params.amount,
    event.block.number,
    event.block.timestamp,
  );
  pool.save();
}
