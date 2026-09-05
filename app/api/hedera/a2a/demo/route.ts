/**
 * A2A demo endpoint — one full negotiation round-trip, returns the trace.
 *
 * Used for the ETHGlobal Hedera demo video: hit this endpoint, get back
 * a JSON trace showing analyst-agent → executor-agent → paid x402
 * settlement with every message on-chain-visible via the HCS audit
 * hook (when enabled).
 *
 * NB: this is a DEMO endpoint (public, rate-limited, no auth). It runs
 * the same code path as the trader's per-tick negotiation but with
 * explicit args from the query string so a curl call from a live demo
 * produces a deterministic trace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readLimiter } from '@/lib/security/rate-limiter';
import { negotiateAndFetch } from '@/lib/services/a2a/negotiate';
import { logger } from '@/lib/utils/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const ANALYST_DID = 'did:hedera:testnet:demo#risk-analyst';
const EXECUTOR_DID = 'did:hedera:testnet:demo#trade-executor';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = readLimiter.check(request);
  if (limited) return limited;

  const url = new URL(request.url);
  const asset = (url.searchParams.get('asset') || 'BTC').toUpperCase();
  const budget = (url.searchParams.get('budget') || '500').trim();

  try {
    const result = await negotiateAndFetch<{
      signal: string; confidence: number; reasoning: string;
    }>({
      requesterDid: ANALYST_DID,
      responderDid: EXECUTOR_DID,
      service: 'signal-quality',
      params: { asset },
      maxBudgetMicros: budget,
      counterToleranceMicros: '250', // will accept up to 250 micros over budget
    });

    return NextResponse.json({
      demo: 'a2a-round-trip',
      asset,
      budgetMicros: budget,
      correlationId: result.correlationId,
      ok: result.ok,
      paid: result.paid,
      provider: result.provider
        ? { id: result.provider.id, url: result.provider.url, priceMicros: result.provider.priceMicros }
        : null,
      priceMicros: result.priceMicros,
      reason: result.reason,
      data: result.data,
      trace: result.trace
        ? {
            state: result.trace.state,
            startedAt: result.trace.startedAt,
            finishedAt: result.trace.finishedAt,
            messageCount: result.trace.messages.length,
            messages: result.trace.messages.map((m) => ({
              kind: m.kind,
              from: m.from,
              to: m.to,
              at: m.at,
              id: m.id,
            })),
          }
        : null,
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    logger.error('[a2a-demo] failed', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
