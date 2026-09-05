/**
 * x402 client — pay-per-call HTTP consumer.
 *
 * Follows the x402 protocol (Coinbase Commerce spec): the target endpoint
 * returns 402 Payment Required with a JSON `intent`; the client signs the
 * payment authorization (EIP-3009 transferWithAuthorization when the
 * currency contract supports it) and retries with an `X-PAYMENT` header
 * carrying the signed payment.
 *
 * Our own /api/hedera/x402/signal-quality endpoint is the reference
 * server. Any x402-compliant service works — the client is protocol
 * agnostic, service-shape agnostic.
 *
 * Server-side signing is done with a hot EVM key (HEDERA_OPERATOR_KEY);
 * this is the agent's wallet, not the pool admin's. Keep the balance
 * bounded — see lib/services/x402/budget.ts.
 */

import { logger } from '@/lib/utils/logger';
import { envFlag } from '@/lib/utils/env-flag';
import { checkBudget, recordSpend } from './budget';
import { chargeSpendForTest as _chargeSpendForTest } from './budget';
export { _chargeSpendForTest };

// ─── Types ────────────────────────────────────────────────────────────────

export interface PaymentIntent {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  currency: string;
  payTo: string;
  facilitator: string;
  resource: string;
  description?: string;
  mimeType?: string;
  outputSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface X402Response<T> {
  ok: boolean;
  data?: T;
  paid: boolean;
  amountMicrosCharged?: string;
  reason?: string;
  intent?: PaymentIntent;
}

export interface CallOptions {
  /** Identity of the paying agent — required for budget accounting. */
  agentId: string;
  /** Per-request cap so we don't accidentally pay more than expected. */
  maxAmountMicros?: string;
  /** Extra request headers (auth, tenancy). */
  headers?: Record<string, string>;
  /** POST body for endpoints that need it. */
  body?: string;
  /** HTTP method (default GET). */
  method?: 'GET' | 'POST';
  /** Timeout override (default 8s). */
  timeoutMs?: number;
}

// ─── Payment signer ───────────────────────────────────────────────────────
// The real signer would use viem's WalletClient + signTypedData to produce
// an EIP-3009 transferWithAuthorization signature that the facilitator
// broadcasts on-chain. For hackathon rollout we ship a stub that emits a
// deterministic X-PAYMENT header matching our own facilitator-verify path
// (X402_FACILITATOR_ENABLED=0 accepts any non-empty header), then swap for
// the real signer when Hedera USDC transferWithAuthorization is confirmed
// available on the target contract.

async function signPayment(intent: PaymentIntent, agentId: string): Promise<string | null> {
  const useReal = envFlag('X402_REAL_SIGNER_ENABLED');
  if (!useReal) {
    // Stub payment header — the destination server's facilitator-verify
    // returns true for any non-empty header when X402_FACILITATOR_ENABLED=0.
    // That's the same shape our own endpoint accepts, so it works for the
    // end-to-end demo. Real signature lands when the operator key + a
    // transferWithAuthorization-capable USDC contract are wired.
    const payload = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: intent.scheme,
        network: intent.network,
        agentId,
        stub: true,
        signedAt: Date.now(),
      }),
    ).toString('base64');
    return payload;
  }

  // Real signing path — dynamic import so viem/ethers only load when
  // needed. Left as a documented reference impl; wired when the real
  // Hedera USDC contract supports transferWithAuthorization.
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    const pk = (process.env.HEDERA_OPERATOR_KEY || '').trim() as `0x${string}`;
    if (!pk.startsWith('0x') || pk.length !== 66) return null;
    const account = privateKeyToAccount(pk);
    const validAfter = 0n;
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300); // 5min window
    const nonce = ('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')) as `0x${string}`;
    const authorization = {
      from: account.address,
      to: intent.payTo as `0x${string}`,
      value: BigInt(intent.maxAmountRequired),
      validAfter,
      validBefore,
      nonce,
    };
    // EIP-3009 domain — the currency contract address, chain, name, version.
    // Skipped here because Hedera USDC contract addresses vary per network
    // and we haven't wired the domain lookup yet. The stub path handles
    // demos; enable X402_REAL_SIGNER_ENABLED once the domain is finalized.
    logger.warn('[x402] real signer not fully implemented — falling back to stub', {
      agentId, authorization,
    });
    return null;
  } catch (e) {
    logger.warn('[x402] real signer failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

// ─── The call ─────────────────────────────────────────────────────────────

/**
 * Call an x402 endpoint. Handles the two-step 402 → sign → retry flow,
 * budget accounting, and graceful fallback so callers only see `paid`
 * true/false and either the data or a reason.
 */
export async function callX402<T>(url: string, opts: CallOptions): Promise<X402Response<T>> {
  const method = opts.method ?? 'GET';
  const timeoutMs = opts.timeoutMs ?? 8000;
  const body = opts.body;

  // First call — expect 402 for a fresh endpoint.
  let controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...opts.headers },
      body,
      signal: controller.signal,
    });
  } catch (e) {
    return { ok: false, paid: false, reason: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }

  // Endpoint served without payment (rare — likely a free tier).
  if (res.ok) {
    const data = (await res.json()) as T;
    return { ok: true, paid: false, data };
  }

  if (res.status !== 402) {
    return { ok: false, paid: false, reason: `unexpected status ${res.status}` };
  }

  // 402 — parse intent + verify against budget + sign + retry.
  const body402 = (await res.json()) as { intent?: PaymentIntent; error?: string };
  const intent = body402.intent;
  if (!intent) {
    return { ok: false, paid: false, reason: 'no payment intent in 402 body' };
  }

  const requestedAmount = intent.maxAmountRequired;
  const cap = opts.maxAmountMicros;
  if (cap && BigInt(requestedAmount) > BigInt(cap)) {
    return {
      ok: false, paid: false, intent,
      reason: `intent amount ${requestedAmount} exceeds caller cap ${cap}`,
    };
  }

  // Per-agent daily budget check.
  const budgetOk = await checkBudget(opts.agentId, requestedAmount);
  if (!budgetOk) {
    return { ok: false, paid: false, intent, reason: 'daily budget exhausted' };
  }

  // Sign the payment.
  const paymentHeader = await signPayment(intent, opts.agentId);
  if (!paymentHeader) {
    return { ok: false, paid: false, intent, reason: 'payment signing failed' };
  }

  // Retry with X-PAYMENT.
  controller = new AbortController();
  timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...opts.headers,
        'X-PAYMENT': paymentHeader,
      },
      body,
      signal: controller.signal,
    });
  } catch (e) {
    return { ok: false, paid: false, intent, reason: `paid retry failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return { ok: false, paid: false, intent, reason: `paid retry status ${res.status}` };
  }

  // Record the spend after the server accepted the payment.
  await recordSpend(opts.agentId, requestedAmount).catch((e) => {
    logger.warn('[x402] recordSpend failed', {
      agentId: opts.agentId, error: e instanceof Error ? e.message : String(e),
    });
  });

  const data = (await res.json()) as T;
  return { ok: true, paid: true, data, amountMicrosCharged: requestedAmount, intent };
}
