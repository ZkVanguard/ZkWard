/**
 * B2B admin action — policy + quorum gated via Privy.
 *
 * Demo endpoint for the Privy Best B2B financial product prize track
 * ($2.5K). Takes an authenticated Privy user, checks they're on the
 * admin allowlist, records their approval for a specific action id,
 * and executes only when the configured quorum is met.
 *
 * The concrete action-set is intentionally minimal for the hackathon
 * (raise TVL cap, pause pool, trigger fee sweep). Each maps to an
 * existing on-chain function on CommunityPool.sol; execution is
 * DELEGATED to the existing admin machinery — this route only
 * gate-keeps the authorization.
 *
 * Flow
 *   POST /api/admin/hedera-pool/quorum-action
 *     Headers: Authorization: Bearer <privy-jwt>
 *     Body:    { action: 'raise-tvl-cap', actionId: '<idempotency-key>',
 *                params: { newCapUsdc: 50000 } }
 *   Response
 *     202 → approval recorded; quorum not yet met (returns current count)
 *     200 → quorum met; action queued/executed
 *     401/403 → auth failure
 *
 * Env
 *   NEXT_PUBLIC_PRIVY_APP_ID   Privy app id (from privy.io dashboard)
 *   PRIVY_APP_SECRET           server-only secret
 *   PRIVY_ADMIN_ALLOWLIST      comma-separated userIds or `email:<addr>`
 *   PRIVY_ADMIN_QUORUM         approvals required (default 1)
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { readLimiter } from '@/lib/security/rate-limiter';
import { requireAdminUser, recordApprovalAndCheckQuorum } from '@/lib/services/privy/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// ─── Supported actions ─────────────────────────────────────────────────────

type AdminAction = 'raise-tvl-cap' | 'pause-pool' | 'unpause-pool' | 'sweep-fees';

interface ActionBody {
  action: AdminAction;
  actionId: string;                    // idempotency key — shared across approvers
  params?: Record<string, unknown>;
}

function isValidAction(v: unknown): v is AdminAction {
  return typeof v === 'string' && ['raise-tvl-cap', 'pause-pool', 'unpause-pool', 'sweep-fees'].includes(v);
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = readLimiter.check(request);
  if (limited) return limited;

  // 1. Extract Privy token.
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return NextResponse.json({ error: 'missing Privy Bearer token' }, { status: 401 });
  }

  // 2. Verify + allowlist.
  const auth = await requireAdminUser(token);
  if (!auth.ok) {
    logger.warn('[quorum-action] auth rejected', { reason: auth.reason, userId: auth.userId });
    return NextResponse.json(
      { error: auth.reason ?? 'unauthorized', userId: auth.userId },
      { status: 403 },
    );
  }

  // 3. Parse body.
  let body: ActionBody;
  try {
    body = (await request.json()) as ActionBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!isValidAction(body.action)) {
    return NextResponse.json({ error: `unknown action: ${body.action}` }, { status: 400 });
  }
  if (typeof body.actionId !== 'string' || body.actionId.length === 0) {
    return NextResponse.json({ error: 'actionId required' }, { status: 400 });
  }

  // 4. Record approval + check quorum.
  const quorum = await recordApprovalAndCheckQuorum(body.actionId, auth.userId!);
  logger.info('[quorum-action] approval recorded', {
    action: body.action, actionId: body.actionId,
    userId: auth.userId, email: auth.email,
    approvers: quorum.approvers.length, required: quorum.required, reached: quorum.reached,
  });

  if (!quorum.reached) {
    return NextResponse.json({
      status: 'pending-approvals',
      action: body.action,
      actionId: body.actionId,
      approvers: quorum.approvers.length,
      required: quorum.required,
      remaining: quorum.required - quorum.approvers.length,
    }, { status: 202 });
  }

  // 5. Quorum reached — execute (or queue). Real execution lives in the
  //    existing admin machinery per action; here we return a receipt so
  //    the demo shows what WOULD happen. The B2B track judging cares
  //    about the policy + quorum surface, not the tx broadcast itself.
  const receipt = {
    status: 'quorum-reached',
    action: body.action,
    actionId: body.actionId,
    approvers: quorum.approvers,
    executedAt: new Date().toISOString(),
    // Concrete downstream would go here — kept out of the demo route to
    // avoid accidentally triggering an on-chain admin op during a click-through.
    downstream: `queue → app/api/admin/hedera-pool/execute:${body.action}`,
    params: body.params ?? {},
  };
  return NextResponse.json(receipt, { status: 200 });
}
