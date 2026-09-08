/**
 * Shared standardized entity schema.
 *
 * The whole point of this adapter is that Hedera contracts respond to the
 * SAME query surface that a Messari-style standardized subgraph on The
 * Graph does. Anything mapped by a preset ends up in these entities.
 */

export const SHARED_TYPEDEFS = /* GraphQL */ `
  scalar BigInt
  scalar Bytes

  enum OrderDirection { asc, desc }
  enum TxType { DEPOSIT, WITHDRAW, OTHER }

  type Pool {
    id: Bytes!
    network: String!
    totalShares: BigInt!
    totalNav: BigInt!
    sharePrice: BigInt!
    memberCount: Int!
    totalFeesCollected: BigInt!
    createdAtBlock: BigInt!
    createdAtTimestamp: BigInt!
    updatedAtBlock: BigInt
    updatedAtTimestamp: BigInt
  }

  type Transaction {
    id: Bytes!
    pool: Pool!
    type: TxType!
    actor: Bytes!
    amount: BigInt!
    shares: BigInt!
    sharePrice: BigInt!
    blockNumber: BigInt!
    timestamp: BigInt!
    transactionHash: Bytes!
  }

  type Member {
    id: Bytes!
    pool: Pool!
    address: Bytes!
    currentShares: BigInt!
    totalDeposited: BigInt!
    totalWithdrawn: BigInt!
    joinedAtBlock: BigInt!
    joinedAtTimestamp: BigInt!
    lastActionAtBlock: BigInt
    lastActionAtTimestamp: BigInt
  }

  type _Block_ {
    number: Int!
    timestamp: Int
  }

  type _Meta_ {
    block: _Block_!
    deployment: String!
    hasIndexingErrors: Boolean!
  }

  """
  Time-series pool NAV snapshot reconstructed from the HCS audit trail.
  Every trader tick (~5min) anchors { poolNavUsd, positions } on HCS via
  hedge-projection messages; this query surfaces that as a chart-ready
  series. Consumers get share-price / NAV over time without needing to
  replay every event or trust an off-chain aggregator.
  Requires the adapter to be constructed with auditTopicId set.
  """
  type NavSnapshot {
    id: ID!
    timestamp: BigInt!
    totalNavUsd: BigInt!
    hcsSeq: Int
  }

  """
  AI-agent decision signal reconstructed from the HCS audit trail.
  Every x402 paid-inference call and every hedge-projection message
  writes { asset, signal, confidence } to Hedera Consensus Service —
  this query surfaces that history as GraphQL, so an AI consumer can
  read the same substrate the trader wrote.
  Requires the adapter to be constructed with auditTopicId set.
  """
  type Signal {
    id: ID!
    asset: String!
    direction: String!
    confidence: Int!
    source: String!
    timestamp: BigInt!
    hcsSeq: Int
    hcsTxId: String
  }

  """
  Standard Graph-subgraph filter shape. Each scalar field expands into
  { field, field_not, field_in, field_not_in } plus { field_gt / _lt / _gte / _lte }
  for numeric fields — same conventions Graph tooling auto-generates.
  """
  input Pool_filter {
    id: Bytes
    id_in: [Bytes!]
    id_not: Bytes
    network: String
    network_in: [String!]
    network_contains: String
  }

  input Transaction_filter {
    type: TxType
    type_in: [TxType!]
    type_not: TxType
    actor: Bytes
    actor_in: [Bytes!]
    actor_not: Bytes
    amount_gt: BigInt
    amount_gte: BigInt
    amount_lt: BigInt
    amount_lte: BigInt
    shares_gt: BigInt
    shares_lt: BigInt
    timestamp_gt: BigInt
    timestamp_gte: BigInt
    timestamp_lt: BigInt
    timestamp_lte: BigInt
    blockNumber_gt: BigInt
    blockNumber_lt: BigInt
  }

  input Signal_filter {
    asset: String
    asset_in: [String!]
    asset_not: String
    source: String
    source_in: [String!]
    direction: String
    direction_in: [String!]
    confidence_gt: Int
    confidence_gte: Int
    confidence_lt: Int
    confidence_lte: Int
    timestamp_gt: BigInt
    timestamp_lt: BigInt
  }

  type Query {
    pool(id: Bytes!): Pool
    pools(first: Int = 10, skip: Int = 0, where: Pool_filter): [Pool!]!
    transaction(id: Bytes!): Transaction
    transactions(first: Int = 25, skip: Int = 0, orderBy: String, orderDirection: OrderDirection, where: Transaction_filter): [Transaction!]!
    member(id: Bytes!): Member
    members(first: Int = 25, skip: Int = 0): [Member!]!
    signals(first: Int = 25, skip: Int = 0, where: Signal_filter): [Signal!]!
    navHistory(first: Int = 100, skip: Int = 0): [NavSnapshot!]!
    _meta: _Meta_
  }
`;
