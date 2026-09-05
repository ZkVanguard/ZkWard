/**
 * A2A (Agent-to-Agent) protocol for cost-aware inference negotiation.
 *
 * Two of our seven agents talk to each other through the A2A bus to
 * settle who pays for a paid inference call and at what price:
 *
 *   1. Requester agent (analyst) emits Proposal — "I need signal X,
 *      willing to pay up to N micros"
 *   2. Responder agent (executor) evaluates the request against its
 *      provider registry and returns Acceptance (with concrete provider
 *      + price) OR CounterProposal (asking for a higher budget)
 *   3. Requester either agrees (accept counter) or aborts
 *   4. On agreement, the executor makes the paid x402 call via the
 *      existing lib/services/x402 client
 *   5. Settlement message closes the negotiation — carries paid=true,
 *      priceMicros, provider url, hcsTxId (audit)
 *
 * Every message carries the sender's HCS-14 DID so the trail is
 * verifiable — matches the "on-chain agent identity" extra-points
 * criterion of the Hedera prize.
 *
 * Kept protocol-first (not tied to our specific analyst/executor pair)
 * so a competitor can plug in.
 */

// ─── Message types ─────────────────────────────────────────────────────────

export type A2AMessageKind =
  | 'proposal'
  | 'counter-proposal'
  | 'acceptance'
  | 'rejection'
  | 'settlement';

/** Every message shares these envelope fields. */
export interface A2AEnvelope {
  /** Deterministic id — used as reply-to and dedup key. */
  id: string;
  /** UUIDv7 or ULID recommended for time-sorted uniqueness. */
  correlationId: string;
  /** HCS-14 DID of sender (did:hedera:...#agentId). */
  from: string;
  /** HCS-14 DID of intended recipient. Broadcast if omitted. */
  to?: string;
  /** Epoch ms. */
  at: number;
  kind: A2AMessageKind;
}

/**
 * Requester → responder. "I need this inference, here's my budget."
 * `service` is generic on purpose — the protocol handles any x402
 * service, not only signal-quality.
 */
export interface A2AProposal extends A2AEnvelope {
  kind: 'proposal';
  service: 'signal-quality' | 'risk-assessment' | 'trade-execution';
  params: Record<string, string>;   // e.g. { asset: 'BTC' }
  maxBudgetMicros: string;          // stringified microUSD
  deadline?: number;                // optional epoch ms; responder may reject if past
}

/**
 * Responder → requester when the responder can serve but at a higher
 * price than proposed. Carries a concrete provider so the requester can
 * decide whether the new price is worth it.
 */
export interface A2ACounterProposal extends A2AEnvelope {
  kind: 'counter-proposal';
  proposalId: string;               // id of the Proposal we're countering
  provider: string;                 // https URL of the x402 endpoint
  priceMicros: string;              // provider's actual per-call price
  reason: string;                   // human-readable justification
}

/**
 * Responder → requester agreeing to serve at the proposed budget (or
 * lower). Carries the concrete provider that will be called.
 */
export interface A2AAcceptance extends A2AEnvelope {
  kind: 'acceptance';
  proposalId: string;
  provider: string;
  priceMicros: string;              // exact price responder will pay
}

/**
 * Terminal — either side can send. No paid call was made.
 */
export interface A2ARejection extends A2AEnvelope {
  kind: 'rejection';
  proposalId: string;
  reason: string;
}

/**
 * Terminal — settlement message posted after a successful paid call.
 * Includes the payment result so the requester can verify the executor
 * actually paid the price they claimed.
 */
export interface A2ASettlement extends A2AEnvelope {
  kind: 'settlement';
  proposalId: string;
  provider: string;
  priceMicros: string;              // amount actually charged
  paid: boolean;
  resultDigest: string;             // sha256 of the response body — proof
  hcsTxId?: string;                 // when HCS audit is enabled
}

export type A2AMessage =
  | A2AProposal
  | A2ACounterProposal
  | A2AAcceptance
  | A2ARejection
  | A2ASettlement;

// ─── Negotiation state (per-correlation trace) ────────────────────────────

export type A2ANegotiationState =
  | 'open'          // proposal sent, no response yet
  | 'countered'     // counter proposal outstanding
  | 'accepted'      // both sides agree; awaiting settlement
  | 'settled'       // paid call complete
  | 'rejected'      // terminal without payment
  | 'expired';      // deadline passed

export interface A2ANegotiationTrace {
  correlationId: string;
  state: A2ANegotiationState;
  messages: A2AMessage[];
  startedAt: number;
  finishedAt?: number;
}

// ─── Validation ───────────────────────────────────────────────────────────

const KIND_SET: ReadonlySet<A2AMessageKind> = new Set<A2AMessageKind>([
  'proposal', 'counter-proposal', 'acceptance', 'rejection', 'settlement',
]);

/** Cheap runtime guard — reject malformed messages at the bus edge. */
export function isValidMessage(m: unknown): m is A2AMessage {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return false;
  if (typeof o.correlationId !== 'string' || o.correlationId.length === 0) return false;
  if (typeof o.from !== 'string' || o.from.length === 0) return false;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return false;
  if (typeof o.kind !== 'string' || !KIND_SET.has(o.kind as A2AMessageKind)) return false;
  return true;
}

/**
 * Fold a message stream into a terminal state. Consumers use this to
 * decide whether to wait, cancel, or move on.
 */
export function foldState(messages: A2AMessage[]): A2ANegotiationState {
  if (messages.length === 0) return 'open';
  const kinds = messages.map((m) => m.kind);
  if (kinds.includes('settlement')) return 'settled';
  if (kinds.includes('rejection')) return 'rejected';
  if (kinds.includes('acceptance')) return 'accepted';
  if (kinds.includes('counter-proposal')) return 'countered';
  return 'open';
}
