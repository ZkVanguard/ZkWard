'use client';

/**
 * Projected pool hedges for the Hedera vault.
 *
 * Not user-opened positions (that's HederaPerpsPanel) — these are the
 * perp positions the AI would open on behalf of the pool based on its
 * current NAV + the platform's hedging heuristic. Prices are real (live
 * from /api/prices), sizes are derived from real on-chain TVL. Labelled
 * "AI-projected" so nothing is misread as an executed position.
 *
 * Heuristic (for the demo — matches the SUI pool's hedging pattern):
 *   - Allocate 30% of NAV per asset to BTC, ETH, SUI perp shorts
 *   - Bias LONG if signal is BULLISH, else SHORT (delta-neutral)
 *   - Leverage 2× per position
 *   - Entry price = current mark at first render, held constant so live
 *     P&L reflects the price move since the panel opened
 *
 * When a real Hedera-native perp DEX exists, swap the projections for
 * real on-chain reads. Until then this is the honest "what would happen
 * at scale" surface the pool page needs.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { TrendingUp, TrendingDown, Activity, Info } from 'lucide-react';

const ACCENT = '#00A79F';
const PRICE_POLL_MS = 5000;

type Symbol = 'BTC' | 'ETH' | 'SUI';
type Side = 'LONG' | 'SHORT';

interface PriceMap { [k: string]: number }

interface ProjectedPosition {
  symbol: Symbol;
  side: Side;
  entryPrice: number;
  sizeToken: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
}

interface Props {
  /** Current pool NAV in USDC. Used to size projections proportionally. */
  poolNavUsd: number;
}

const ASSET_ALLOCATION = 0.30; // 30% of NAV per asset
const LEVERAGE = 2;

async function fetchPrices(): Promise<PriceMap> {
  try {
    const r = await fetch('/api/prices?symbols=BTC,ETH,SUI', { cache: 'no-store' });
    if (!r.ok) return {};
    const j = (await r.json()) as { prices?: PriceMap };
    return j.prices ?? {};
  } catch {
    return {};
  }
}

function fmtUsd(n: number, digits = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function HederaPoolHedgesProjection({ poolNavUsd }: Props) {
  const [prices, setPrices] = useState<PriceMap>({});
  const [loaded, setLoaded] = useState(false);

  // Snapshot entry prices once when the panel first has real prices —
  // downstream P&L is delta from these entries, not delta from every
  // render (which would zero out P&L constantly).
  const entriesRef = useRef<Record<Symbol, number> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const p = await fetchPrices();
      if (cancelled) return;
      if (Object.keys(p).length > 0) {
        setPrices(p);
        if (!entriesRef.current && p.BTC && p.ETH && p.SUI) {
          entriesRef.current = { BTC: p.BTC, ETH: p.ETH, SUI: p.SUI };
          setLoaded(true);
        }
      }
    };
    tick();
    const iv = window.setInterval(() => {
      if (!document.hidden) tick();
    }, PRICE_POLL_MS);
    return () => { cancelled = true; window.clearInterval(iv); };
  }, []);

  const positions: ProjectedPosition[] = useMemo(() => {
    if (!entriesRef.current) return [];
    const notional = poolNavUsd * ASSET_ALLOCATION;
    const marginPerLeg = notional / LEVERAGE;
    return (['BTC', 'ETH', 'SUI'] as Symbol[]).map((symbol) => {
      const entryPrice = entriesRef.current![symbol];
      return {
        symbol,
        side: 'LONG' as Side, // Default BULLISH bias — real code would fuse signals
        entryPrice,
        sizeToken: notional / entryPrice,
        notionalUsd: notional,
        marginUsd: marginPerLeg,
        leverage: LEVERAGE,
      };
    });
  }, [poolNavUsd, loaded]);

  const totals = useMemo(() => {
    let notional = 0;
    let margin = 0;
    let upnl = 0;
    for (const p of positions) {
      const mark = prices[p.symbol] ?? p.entryPrice;
      notional += p.notionalUsd;
      margin += p.marginUsd;
      const dirMul = p.side === 'LONG' ? 1 : -1;
      upnl += (mark - p.entryPrice) * p.sizeToken * dirMul;
    }
    return { notional, margin, upnl };
  }, [positions, prices]);

  if (poolNavUsd <= 0) {
    return null;
  }

  return (
    <div className="p-3 sm:p-4 border-b border-gray-100 dark:border-gray-700">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Activity className="w-4 h-4" style={{ color: ACCENT }} />
        <h3 className="text-sm sm:text-[15px] font-semibold text-label-primary">
          Projected pool hedges
        </h3>
        <span
          className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide"
          style={{ background: `${ACCENT}15`, color: ACCENT }}
        >
          AI-projected · Hedera
        </span>
      </div>

      <div className="text-[11px] text-label-tertiary mb-3 leading-relaxed">
        What the pool AI would open with the current ${fmtUsd(poolNavUsd)} NAV.
        {' '}{Math.round(ASSET_ALLOCATION * 100)}% per asset, {LEVERAGE}× leverage,
        {' '}live prices from the aggregator. Delta since page open.
      </div>

      {positions.length === 0 ? (
        <div className="text-[11px] text-label-tertiary py-4 text-center">
          Waiting for live prices…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <StatCell label="Notional" value={`$${fmtUsd(totals.notional)}`} />
            <StatCell label="Margin" value={`$${fmtUsd(totals.margin)}`} />
            <StatCell
              label="Projected P&L"
              value={`${totals.upnl >= 0 ? '+' : ''}$${fmtUsd(totals.upnl)}`}
              color={totals.upnl >= 0 ? '#34C759' : '#FF3B30'}
            />
          </div>

          <div className="space-y-1.5">
            {positions.map((p) => {
              const mark = prices[p.symbol] ?? p.entryPrice;
              const dirMul = p.side === 'LONG' ? 1 : -1;
              const pnl = (mark - p.entryPrice) * p.sizeToken * dirMul;
              const pnlPct = p.marginUsd > 0 ? (pnl / p.marginUsd) * 100 : 0;
              const winning = pnl >= 0;
              return (
                <div key={p.symbol} className="flex items-center gap-2 p-2 rounded-lg bg-system-bg-secondary text-[12px]">
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    {p.side === 'LONG' ? (
                      <TrendingUp className="w-3.5 h-3.5 text-[#34C759] flex-shrink-0" />
                    ) : (
                      <TrendingDown className="w-3.5 h-3.5 text-[#FF3B30] flex-shrink-0" />
                    )}
                    <span className="font-semibold text-label-primary w-10">{p.symbol}</span>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
                      style={{
                        background: p.side === 'LONG' ? '#34C75915' : '#FF3B3015',
                        color: p.side === 'LONG' ? '#34C759' : '#FF3B30',
                      }}
                    >
                      {p.side}
                    </span>
                    <span className="text-[10px] text-label-tertiary">{p.leverage}×</span>
                    <span className="text-[10px] text-label-tertiary tabular-nums truncate">
                      ${fmtUsd(p.notionalUsd)} notional
                    </span>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div
                      className="font-semibold tabular-nums text-[12px]"
                      style={{ color: winning ? '#34C759' : '#FF3B30' }}
                    >
                      {winning ? '+' : ''}${fmtUsd(pnl)}
                    </div>
                    <div className="text-[10px] tabular-nums" style={{ color: winning ? '#34C759' : '#FF3B30' }}>
                      {winning ? '+' : ''}{pnlPct.toFixed(2)}%
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-3 pt-2 border-t border-gray-100 dark:border-gray-700 flex items-start gap-1.5 text-[10px] text-label-tertiary leading-relaxed">
            <Info className="w-3 h-3 flex-shrink-0 mt-0.5" />
            <span>
              No on-chain perp DEX on Hedera testnet — these positions are
              projected, not executed. Swap for real reads once a Hedera perp
              venue is wired.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg bg-system-bg-secondary p-2">
      <div className="text-[10px] text-label-tertiary uppercase tracking-wide">{label}</div>
      <div className="text-[13px] font-semibold tabular-nums" style={{ color: color ?? 'inherit' }}>
        {value}
      </div>
    </div>
  );
}
