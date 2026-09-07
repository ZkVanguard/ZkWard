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

  input Pool_filter {
    id: Bytes
    network: String
  }

  input Transaction_filter {
    type: TxType
    actor: Bytes
  }

  type Query {
    pool(id: Bytes!): Pool
    pools(first: Int = 10, where: Pool_filter): [Pool!]!
    transaction(id: Bytes!): Transaction
    transactions(first: Int = 25, orderBy: String, orderDirection: OrderDirection, where: Transaction_filter): [Transaction!]!
    member(id: Bytes!): Member
    members(first: Int = 25): [Member!]!
    _meta: _Meta_
  }
`;
