/**
 * End-to-end A2A negotiation helper.
 *
 * `negotiateAndFetch()` is what a requester agent calls when it wants
 * a paid inference. Handles the full round-trip:
 *
 *   analyst-agent  ──proposal──▶  executor-agent
 *                                       │
 *                                       ├─ discoverProviders() picks cheapest
 *                                       │
 *   analyst-agent  ◀──acceptance── or  counter-proposal
 *                     ├─ if counter within tolerance: send acceptance
 *                     └─ otherwise: send rejection
 *
 *                                       │
 *                                       ├─ paid x402 call via callX402()
 *                                       │
 *   analyst-agent  ◀──settlement── executor-agent (with resultDigest)
 *
 * Every message hits lib/services/a2a/bus (in-process fanout + Redis
 * mirror + optional HCS audit). The whole trace is retrievable via
 * getTrace(correlationId).
 */

import { createHash, randomUUID } from 'crypto';
import { logger } from '@/lib/utils/logger';
import { publish, getTrace } from './bus';
import type {
  A2AProposal,
  A2ACounterProposal,
  A2AAcceptance,
  A2ARejection,
  A2ASettlement,
  A2ANegotiationTrace,
} from './protocol';
import { discoverProviders, type Provider } from './provider-registry';
import { callX402 } from '@/lib/services/x402/client';

// ─── Types ────────────────────────────────────────────────────────────────

export interface NegotiateArgs {
  /** DID of the requester (analyst) agent. */
  requesterDid: string;
  /** DID of the responder (executor) agent. */
  responderDid: string;
  service: Provider['service'];
  params: Record<string, string>;
  /** Requester's absolute cap — will never accept above this. */
  maxBudgetMicros: string;
  /** How much over the proposed budget the requester will accept if
   *  countered. Default 0 = reject any counter. */
  counterToleranceMicros?: string;
  /** For tests + demo — pass an explicit registry. */
  registry?: Provider[];
  /** Override the correlation id (for deterministic tests). */
  correlationId?: string;
}

export interface NegotiateResult<T> {
  ok: boolean;
  paid: boolean;
  reason?: string;
  data?: T;
  provider?: Provider;
  priceMicros?: string;
  correlationId: string;
  trace?: A2ANegotiationTrace;
}

// ─── The negotiation ──────────────────────────────────────────────────────

export async function negotiateAndFetch<T = unknown>(
  args: NegotiateArgs,
): Promise<NegotiateResult<T>> {
  const correlationId = args.correlationId ?? randomUUID();

  // 1. Requester emits Proposal.
  const proposal: A2AProposal = {
    id: randomUUID(),
    correlationId,
    from: args.requesterDid,
    to: args.responderDid,
    at: Date.now(),
    kind: 'proposal',
    service: args.service,
    params: args.params,
    maxBudgetMicros: args.maxBudgetMicros,
  };
  await publish(proposal);

  // 2. Responder evaluates via discoverProviders().
  const discovery = discoverProviders({
    service: args.service,
    maxPriceMicros: args.maxBudgetMicros,
    registry: args.registry,
  });

  // Nothing affordable — is a counter possible? Only if the cheapest
  // exists and beats the caller's tolerance ceiling.
  if (!discovery.provider) {
    const cheapest = (args.registry ?? discovery.considered > 0 ? args.registry : undefined);
    // Simplest path: send a counter with the cheapest known price OR
    // reject if we can't even name one.
    if (discovery.reason?.includes('cheapest available')) {
      const match = /cheapest available (\d+)/.exec(discovery.reason);
      const cheapestPrice = match?.[1] ?? '0';
      const counter: A2ACounterProposal = {
        id: randomUUID(),
        correlationId,
        from: args.responderDid,
        to: args.requesterDid,
        at: Date.now(),
        kind: 'counter-proposal',
        proposalId: proposal.id,
        provider: 'unknown',
        priceMicros: cheapestPrice,
        reason: discovery.reason,
      };
      await publish(counter);

      // 3a. Requester evaluates counter against tolerance.
      const tolerance = BigInt(args.counterToleranceMicros ?? '0');
      const proposedBudget = BigInt(args.maxBudgetMicros);
      const counterPrice = BigInt(cheapestPrice);
      const withinTolerance = counterPrice <= proposedBudget + tolerance;
      if (!withinTolerance) {
        const reject: A2ARejection = {
          id: randomUUID(),
          correlationId,
          from: args.requesterDid,
          to: args.responderDid,
          at: Date.now(),
          kind: 'rejection',
          proposalId: proposal.id,
          reason: `counter ${cheapestPrice} > budget ${args.maxBudgetMicros} + tolerance ${tolerance.toString()}`,
        };
        await publish(reject);
        const trace = (await getTrace(correlationId)) ?? undefined;
        return {
          ok: false, paid: false, correlationId, trace,
          reason: reject.reason,
        };
      }
      // Would-accept path — but without a concrete provider we still
      // can't execute. Reject cleanly.
      const reject: A2ARejection = {
        id: randomUUID(),
        correlationId,
        from: args.requesterDid,
        to: args.responderDid,
        at: Date.now(),
        kind: 'rejection',
        proposalId: proposal.id,
        reason: 'counter had no concrete provider — cannot execute',
      };
      await publish(reject);
      const trace = (await getTrace(correlationId)) ?? undefined;
      return { ok: false, paid: false, correlationId, trace, reason: reject.reason };
    }

    // No providers at all for this service — terminal reject.
    const reject: A2ARejection = {
      id: randomUUID(),
      correlationId,
      from: args.responderDid,
      to: args.requesterDid,
      at: Date.now(),
      kind: 'rejection',
      proposalId: proposal.id,
      reason: discovery.reason ?? 'no providers',
    };
    await publish(reject);
    const trace = (await getTrace(correlationId)) ?? undefined;
    // Silence unused warning until we wire retries against `cheapest`
    void cheapest;
    return { ok: false, paid: false, correlationId, trace, reason: reject.reason };
  }

  // 3. Responder sends Acceptance with concrete provider.
  const acceptance: A2AAcceptance = {
    id: randomUUID(),
    correlationId,
    from: args.responderDid,
    to: args.requesterDid,
    at: Date.now(),
    kind: 'acceptance',
    proposalId: proposal.id,
    provider: discovery.provider.url,
    priceMicros: discovery.provider.priceMicros,
  };
  await publish(acceptance);

  // 4. Responder makes the paid x402 call.
  const url = buildProviderUrl(discovery.provider, args.params);
  const paid = await callX402<T>(url, {
    agentId: extractAgentIdFromDid(args.responderDid),
    maxAmountMicros: args.maxBudgetMicros,
  });

  const resultDigest = paid.data
    ? sha256Hex(JSON.stringify(paid.data))
    : sha256Hex(paid.reason ?? 'no-data');

  // 5. Settlement.
  const settlement: A2ASettlement = {
    id: randomUUID(),
    correlationId,
    from: args.responderDid,
    to: args.requesterDid,
    at: Date.now(),
    kind: 'settlement',
    proposalId: proposal.id,
    provider: discovery.provider.url,
    priceMicros: paid.amountMicrosCharged ?? discovery.provider.priceMicros,
    paid: paid.paid,
    resultDigest,
  };
  await publish(settlement);

  const trace = (await getTrace(correlationId)) ?? undefined;

  if (!paid.ok) {
    logger.info('[a2a] paid call failed', {
      correlationId, provider: discovery.provider.id, reason: paid.reason,
    });
    return {
      ok: false, paid: paid.paid, correlationId, trace,
      provider: discovery.provider, priceMicros: settlement.priceMicros,
      reason: paid.reason,
    };
  }

  return {
    ok: true, paid: paid.paid, data: paid.data, correlationId, trace,
    provider: discovery.provider, priceMicros: settlement.priceMicros,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildProviderUrl(provider: Provider, params: Record<string, string>): string {
  const url = new URL(provider.url);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  return url.toString();
}

function extractAgentIdFromDid(did: string): string {
  // "did:hedera:testnet:0.0.1234567#executor" → "executor"
  const hash = did.lastIndexOf('#');
  return hash >= 0 ? did.slice(hash + 1) : did;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
