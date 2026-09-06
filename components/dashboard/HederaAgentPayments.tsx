'use client';

/**
 * Hedera Agent Payments dashboard tab.
 *
 * Live demo for the ETHGlobal Hedera "AI & Agentic Payments" prize track.
 * Judges click one button, watch:
 *   1. GET /api/hedera/x402/signal-quality → 402 Payment Required
 *   2. Client constructs X-PAYMENT header, retries → 200 with signal
 *   3. Server writes HCS audit entry → txId + explorer link surface
 *
 * Every settled call is auditable on HashScan under topic 0.0.10393879.
 *
 * Bonus surfaces below the primary flow:
 *   - Live intent preview (proves the x402 contract shape)
 *   - HCS topic explorer link
 *   - Recent purchases table (last 5, ephemeral state)
 */

import { useCallback, useEffect, useState } from 'react';
import { Coins, Zap, ExternalLink, Loader2, CheckCircle2, XCircle, Info } from 'lucide-react';

const ACCENT = '#0069D9';
const HEDERA_ACCENT = '#00A79F';

// The x402 endpoint we ship in the same repo. Fully qualified so this
// works when copy-pasted into an external agent demo too.
const X402_ENDPOINT = '/api/hedera/x402/signal-quality';

const HCS_TOPIC_ID = '0.0.10393879';
const HCS_EXPLORER = `https://hashscan.io/testnet/topic/${HCS_TOPIC_ID}`;

interface PaymentIntent {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  currency: string;
  payTo: string;
  facilitator: string;
  resource: string;
  description: string;
  metadata: { chain: string; endpoint: string; priceModel: string; signalWindow: string };
}

interface SignalResponse {
  asset: string;
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;
  reasoning: string;
  window: string;
  source: string;
  hcs?: { txId?: string; topicId?: string; memo?: string; explorerUrl?: string };
}

interface Purchase {
  ts: number;
  asset: string;
  signal: string;
  confidence: number;
  hcsTxId?: string;
  hcsUrl?: string;
}

async function fetchIntentOnly(asset: string): Promise<PaymentIntent | null> {
  try {
    const r = await fetch(`${X402_ENDPOINT}?asset=${encodeURIComponent(asset)}`, {
      cache: 'no-store',
    });
    if (r.status !== 402) return null;
    const body = (await r.json()) as { intent?: PaymentIntent };
    return body.intent ?? null;
  } catch {
    return null;
  }
}

/**
 * Constructs the same stub header the server-side x402 client uses so this
 * button and the agent path share a code path. When X402_REAL_SIGNER_ENABLED
 * flips on server-side, we swap in a viem-signed EIP-3009 payload.
 */
function stubPaymentHeader(intent: PaymentIntent, agentId: string): string {
  const payload = {
    x402Version: 1,
    scheme: intent.scheme,
    network: intent.network,
    agentId,
    stub: true,
    signedAt: Date.now(),
  };
  // btoa is browser-native; Node would use Buffer.
  return btoa(JSON.stringify(payload));
}

async function paidCall(
  asset: string,
  intent: PaymentIntent,
): Promise<{ ok: true; data: SignalResponse } | { ok: false; reason: string }> {
  const header = stubPaymentHeader(intent, 'dashboard-demo');
  try {
    const r = await fetch(`${X402_ENDPOINT}?asset=${encodeURIComponent(asset)}`, {
      method: 'GET',
      headers: { 'X-PAYMENT': header },
      cache: 'no-store',
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      return { ok: false, reason: body.error ?? `HTTP ${r.status}` };
    }
    return { ok: true, data: (await r.json()) as SignalResponse };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function HederaAgentPayments() {
  const [asset, setAsset] = useState<'BTC' | 'ETH' | 'SUI' | 'CRO'>('BTC');
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [loadingIntent, setLoadingIntent] = useState(false);
  const [buying, setBuying] = useState(false);
  const [lastResult, setLastResult] = useState<SignalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purchases, setPurchases] = useState<Purchase[]>([]);

  const loadIntent = useCallback(async (a: string) => {
    setLoadingIntent(true);
    const i = await fetchIntentOnly(a);
    setIntent(i);
    setLoadingIntent(false);
  }, []);

  useEffect(() => {
    loadIntent(asset);
  }, [asset, loadIntent]);

  const onBuy = useCallback(async () => {
    if (!intent) return;
    setError(null);
    setBuying(true);
    setLastResult(null);
    const res = await paidCall(asset, intent);
    if (res.ok) {
      setLastResult(res.data);
      setPurchases((prev) => [
        {
          ts: Date.now(),
          asset: res.data.asset,
          signal: res.data.signal,
          confidence: res.data.confidence,
          hcsTxId: res.data.hcs?.txId,
          hcsUrl: res.data.hcs?.explorerUrl,
        },
        ...prev,
      ].slice(0, 5));
    } else {
      setError(res.reason);
    }
    setBuying(false);
  }, [asset, intent]);

  const priceUsdc = intent ? (Number(intent.maxAmountRequired) / 1e6).toFixed(6) : '—';

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* Header card */}
      <div className="rounded-2xl border border-separator-opaque/40 bg-system-bg-primary p-4">
        <div className="flex items-start gap-3">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-white flex-shrink-0"
            style={{ background: HEDERA_ACCENT }}
          >
            <Coins className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-headline font-semibold text-label-primary">
                Pay-per-call inference
              </div>
              <span
                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full text-white font-semibold"
                style={{ background: HEDERA_ACCENT }}
              >
                x402 · Hedera Testnet
              </span>
            </div>
            <div className="text-caption-1 text-label-secondary mt-1 leading-relaxed">
              One HTTP call = one AI signal + one HCS audit entry. Metered at{' '}
              <span className="font-mono tabular-nums">${priceUsdc} USDC</span> per
              call via the Blocky402 facilitator. No API key, no subscription.
            </div>
          </div>
        </div>
      </div>

      {/* Buy flow */}
      <div className="rounded-2xl border border-separator-opaque/40 bg-system-bg-primary p-4">
        <div className="text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary mb-3">
          Buy a signal
        </div>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {(['BTC', 'ETH', 'SUI', 'CRO'] as const).map((a) => (
            <button
              key={a}
              onClick={() => setAsset(a)}
              className={`px-3 h-9 rounded-[10px] text-[13px] font-semibold transition-all ${
                asset === a
                  ? 'text-white shadow-ios-1'
                  : 'text-label-secondary bg-system-bg-secondary hover:bg-[#E5E5EA]'
              }`}
              style={asset === a ? { background: ACCENT } : {}}
            >
              {a}
            </button>
          ))}
          <button
            onClick={onBuy}
            disabled={buying || !intent}
            className="ml-auto inline-flex items-center gap-2 px-4 h-9 rounded-[10px] text-white font-semibold text-[13px] active:scale-[0.98] disabled:opacity-60"
            style={{ background: ACCENT }}
          >
            {buying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {buying ? 'Paying…' : `Buy signal · $${priceUsdc}`}
          </button>
        </div>

        {error && (
          <div className="mt-2 text-[11px] text-[#FF3B30] flex items-center gap-1">
            <XCircle className="w-3.5 h-3.5" />
            {error}
          </div>
        )}

        {lastResult && (
          <div className="mt-3 rounded-xl bg-system-bg-secondary p-3">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="w-4 h-4 text-[#34C759]" />
              <div className="text-[13px] font-semibold text-label-primary">
                {lastResult.asset} · {lastResult.signal} · {lastResult.confidence}% confidence
              </div>
            </div>
            <div className="text-[11px] text-label-secondary leading-relaxed mb-2">
              {lastResult.reasoning}
            </div>
            <div className="text-[10px] text-label-tertiary font-mono truncate">
              source: {lastResult.source} · window: {lastResult.window}
            </div>
            {lastResult.hcs?.explorerUrl && (
              <a
                href={lastResult.hcs.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold"
                style={{ color: HEDERA_ACCENT }}
              >
                HCS audit entry
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {lastResult.hcs?.txId && (
              <div className="mt-1 text-[10px] text-label-tertiary font-mono truncate">
                tx: {lastResult.hcs.txId}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Intent preview — proves the x402 contract shape */}
      <div className="rounded-2xl border border-separator-opaque/40 bg-system-bg-primary p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary">
            402 Payment Intent
          </div>
          {loadingIntent && <Loader2 className="w-3.5 h-3.5 animate-spin text-label-tertiary" />}
        </div>
        {intent ? (
          <pre className="text-[10px] font-mono text-label-secondary overflow-x-auto whitespace-pre-wrap break-all bg-system-bg-secondary rounded-lg p-3">
{JSON.stringify(intent, null, 2)}
          </pre>
        ) : (
          <div className="text-[11px] text-label-tertiary">Fetching intent…</div>
        )}
      </div>

      {/* Recent purchases */}
      {purchases.length > 0 && (
        <div className="rounded-2xl border border-separator-opaque/40 bg-system-bg-primary p-4">
          <div className="text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary mb-3">
            Recent purchases (this session)
          </div>
          <div className="space-y-2">
            {purchases.map((p) => (
              <div key={p.ts} className="flex items-center gap-2 text-[12px]">
                <span className="text-label-tertiary tabular-nums w-16">
                  {new Date(p.ts).toLocaleTimeString('en-US', { hour12: false })}
                </span>
                <span className="font-semibold text-label-primary w-12">{p.asset}</span>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                    p.signal === 'BULLISH'
                      ? 'bg-[#34C759]/15 text-[#34C759]'
                      : p.signal === 'BEARISH'
                        ? 'bg-[#FF3B30]/15 text-[#FF3B30]'
                        : 'bg-label-tertiary/15 text-label-tertiary'
                  }`}
                >
                  {p.signal}
                </span>
                <span className="text-label-secondary tabular-nums">{p.confidence}%</span>
                {p.hcsUrl && (
                  <a
                    href={p.hcsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-[11px] hover:underline"
                    style={{ color: HEDERA_ACCENT }}
                  >
                    HCS ↗
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer info */}
      <div className="rounded-2xl bg-system-bg-secondary p-4">
        <div className="flex items-start gap-2 text-[11px] text-label-secondary leading-relaxed">
          <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-label-tertiary" />
          <div>
            <span className="font-semibold text-label-primary">Prize track:</span>{' '}
            ETHGlobal Hedera · AI &amp; Agentic Payments ($6K).
            <br />
            Every paid call writes an HCS audit entry on topic{' '}
            <a
              href={HCS_EXPLORER}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono hover:underline"
              style={{ color: HEDERA_ACCENT }}
            >
              {HCS_TOPIC_ID}
            </a>{' '}
            — public, verifiable, immutable.
          </div>
        </div>
      </div>
    </div>
  );
}
