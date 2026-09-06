'use client';

/**
 * Simulated live perps on Hedera Testnet.
 *
 * Positions are LOCAL-only (persisted to localStorage) — no on-chain perp
 * DEX yet. Prices are REAL, sourced from the app's /api/prices multi-source
 * aggregator (Crypto.com + fallback chain), refreshed every 5s.
 *
 * Reads convincingly for the Hedera demo video: users can open BTC/ETH/SUI
 * positions with configurable side + leverage + size, watch P&L tick in
 * real time as the underlying market moves, and close positions to realise
 * the mark-to-market P&L.
 *
 * NOT a real perp — no margin call, no funding rate, no liquidation queue.
 * Deliberately labelled "Simulated" everywhere so no user misreads the UI.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, X, TrendingUp, TrendingDown, Loader2, Activity } from 'lucide-react';

type Symbol = 'BTC' | 'ETH' | 'SUI';
type Side = 'LONG' | 'SHORT';

const SYMBOLS: Symbol[] = ['BTC', 'ETH', 'SUI'];
const LEVERAGES = [1, 2, 3, 5, 10];
const PRICE_POLL_MS = 5000;
const STORAGE_KEY = 'hedera-perps-positions-v1';

const HEDERA_ACCENT = '#00A79F';

interface Position {
  id: string;
  symbol: Symbol;
  side: Side;
  entryPrice: number;
  sizeToken: number;        // asset units (BTC, ETH, SUI)
  leverage: number;
  openedAt: number;         // unix ms
  marginUsd: number;        // notional / leverage
}

interface PriceMap {
  [k: string]: number;
}

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

function loadPositions(): Position[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as Position[];
  } catch {
    return [];
  }
}

function savePositions(positions: Position[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    /* quota, private mode — ignore */
  }
}

function fmtUsd(n: number, digits = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function pnlFor(pos: Position, mark: number): { pnl: number; pnlPct: number } {
  if (!mark) return { pnl: 0, pnlPct: 0 };
  const delta = mark - pos.entryPrice;
  const dirMul = pos.side === 'LONG' ? 1 : -1;
  const pnl = delta * pos.sizeToken * dirMul;
  const pnlPct = pos.marginUsd > 0 ? (pnl / pos.marginUsd) * 100 : 0;
  return { pnl, pnlPct };
}

export function HederaPerpsPanel() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [prices, setPrices] = useState<PriceMap>({});
  const [loadingPrices, setLoadingPrices] = useState(true);
  const [openForm, setOpenForm] = useState(false);

  // Hydrate from localStorage on mount.
  useEffect(() => {
    setPositions(loadPositions());
  }, []);

  // Persist on every mutation.
  useEffect(() => {
    savePositions(positions);
  }, [positions]);

  // Live price polling. Runs every PRICE_POLL_MS; pauses when tab hidden.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const p = await fetchPrices();
      if (!cancelled && Object.keys(p).length > 0) {
        setPrices(p);
        setLoadingPrices(false);
      }
    };
    tick();
    const iv = window.setInterval(() => {
      if (!document.hidden) tick();
    }, PRICE_POLL_MS);
    return () => { cancelled = true; window.clearInterval(iv); };
  }, []);

  const totals = useMemo(() => {
    let notional = 0;
    let margin = 0;
    let upnl = 0;
    for (const pos of positions) {
      const mark = prices[pos.symbol] ?? pos.entryPrice;
      notional += mark * pos.sizeToken;
      margin += pos.marginUsd;
      upnl += pnlFor(pos, mark).pnl;
    }
    return { notional, margin, upnl };
  }, [positions, prices]);

  const openPosition = useCallback(
    (symbol: Symbol, side: Side, sizeUsd: number, leverage: number) => {
      const mark = prices[symbol];
      if (!mark) return;
      const notional = sizeUsd; // treat 'size' input as USD notional exposure
      const sizeToken = notional / mark;
      const marginUsd = notional / leverage;
      const pos: Position = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        side,
        entryPrice: mark,
        sizeToken,
        leverage,
        openedAt: Date.now(),
        marginUsd,
      };
      setPositions((prev) => [pos, ...prev]);
      setOpenForm(false);
    },
    [prices],
  );

  const closePosition = useCallback((id: string) => {
    setPositions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* Header + totals */}
      <div className="rounded-2xl border border-separator-opaque/40 bg-system-bg-primary p-4">
        <div className="flex items-start gap-3">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-white flex-shrink-0"
            style={{ background: HEDERA_ACCENT }}
          >
            <Activity className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-headline font-semibold text-label-primary">
                Perps · Hedera Testnet
              </div>
              <span
                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full text-white font-semibold"
                style={{ background: '#FF9500' }}
              >
                simulated
              </span>
              {loadingPrices && (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-label-tertiary" />
              )}
            </div>
            <div className="text-caption-1 text-label-secondary mt-1 leading-relaxed">
              Live prices from the app&apos;s aggregator (Crypto.com + fallbacks),
              positions kept locally. Refreshes every 5s while the tab is visible.
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 mt-4 text-sm">
          <div>
            <div className="text-caption-1 text-label-tertiary">Notional</div>
            <div className="text-title-3 font-semibold text-label-primary tabular-nums">${fmtUsd(totals.notional)}</div>
          </div>
          <div>
            <div className="text-caption-1 text-label-tertiary">Margin</div>
            <div className="text-title-3 font-semibold text-label-primary tabular-nums">${fmtUsd(totals.margin)}</div>
          </div>
          <div>
            <div className="text-caption-1 text-label-tertiary">Unrealised P&amp;L</div>
            <div
              className="text-title-3 font-semibold tabular-nums"
              style={{ color: totals.upnl >= 0 ? '#34C759' : '#FF3B30' }}
            >
              {totals.upnl >= 0 ? '+' : ''}${fmtUsd(totals.upnl)}
            </div>
          </div>
        </div>
      </div>

      {/* Positions list */}
      <div className="rounded-2xl border border-separator-opaque/40 bg-system-bg-primary p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary">
            Open positions
          </div>
          <button
            onClick={() => setOpenForm((v) => !v)}
            className="inline-flex items-center gap-1 px-3 h-8 rounded-[8px] text-[12px] font-semibold text-white active:scale-[0.98]"
            style={{ background: HEDERA_ACCENT }}
          >
            <Plus className="w-3.5 h-3.5" />
            Open position
          </button>
        </div>

        {openForm && (
          <OpenPositionForm prices={prices} onOpen={openPosition} onCancel={() => setOpenForm(false)} />
        )}

        {positions.length === 0 ? (
          <div className="text-[12px] text-label-tertiary py-6 text-center">
            No open positions. Click <span className="font-semibold text-label-secondary">Open position</span> to create one.
          </div>
        ) : (
          <div className="space-y-2">
            {positions.map((pos) => (
              <PositionRow key={pos.id} pos={pos} mark={prices[pos.symbol] ?? 0} onClose={() => closePosition(pos.id)} />
            ))}
          </div>
        )}
      </div>

      {/* Live prices row */}
      <div className="rounded-2xl border border-separator-opaque/40 bg-system-bg-primary p-4">
        <div className="text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary mb-3">
          Live prices (5s refresh)
        </div>
        <div className="grid grid-cols-3 gap-3">
          {SYMBOLS.map((s) => (
            <div key={s} className="rounded-xl bg-system-bg-secondary p-3">
              <div className="text-caption-1 text-label-tertiary">{s}/USD</div>
              <div className="text-title-3 font-semibold text-label-primary tabular-nums mt-1">
                {prices[s] ? `$${fmtUsd(prices[s], s === 'SUI' ? 4 : 2)}` : '—'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────

function PositionRow({ pos, mark, onClose }: {
  pos: Position;
  mark: number;
  onClose: () => void;
}) {
  const { pnl, pnlPct } = pnlFor(pos, mark);
  const winning = pnl >= 0;
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl bg-system-bg-secondary">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {pos.side === 'LONG' ? (
          <TrendingUp className="w-4 h-4 text-[#34C759] flex-shrink-0" />
        ) : (
          <TrendingDown className="w-4 h-4 text-[#FF3B30] flex-shrink-0" />
        )}
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-label-primary flex items-center gap-1.5">
            <span>{pos.symbol}</span>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
              style={{
                background: pos.side === 'LONG' ? '#34C75915' : '#FF3B3015',
                color: pos.side === 'LONG' ? '#34C759' : '#FF3B30',
              }}
            >
              {pos.side}
            </span>
            <span className="text-[10px] text-label-tertiary">{pos.leverage}×</span>
          </div>
          <div className="text-[11px] text-label-tertiary tabular-nums">
            {pos.sizeToken.toFixed(pos.symbol === 'BTC' ? 6 : 4)} {pos.symbol} · entry ${fmtUsd(pos.entryPrice, pos.symbol === 'SUI' ? 4 : 2)}
          </div>
        </div>
      </div>
      <div className="text-right min-w-0">
        <div
          className="text-[13px] font-semibold tabular-nums"
          style={{ color: winning ? '#34C759' : '#FF3B30' }}
        >
          {winning ? '+' : ''}${fmtUsd(pnl)}
        </div>
        <div className="text-[10px] tabular-nums" style={{ color: winning ? '#34C759' : '#FF3B30' }}>
          {winning ? '+' : ''}{pnlPct.toFixed(2)}%
        </div>
      </div>
      <button
        onClick={onClose}
        className="p-1.5 rounded-lg hover:bg-black/5 active:scale-[0.95] transition-all text-label-tertiary hover:text-[#FF3B30]"
        aria-label="Close position"
        title="Close position"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function OpenPositionForm({ prices, onOpen, onCancel }: {
  prices: PriceMap;
  onOpen: (s: Symbol, side: Side, sizeUsd: number, leverage: number) => void;
  onCancel: () => void;
}) {
  const [symbol, setSymbol] = useState<Symbol>('BTC');
  const [side, setSide] = useState<Side>('LONG');
  const [sizeUsd, setSizeUsd] = useState('500');
  const [leverage, setLeverage] = useState(3);
  const mark = prices[symbol] ?? 0;
  const notional = Number(sizeUsd) || 0;
  const marginUsd = leverage > 0 ? notional / leverage : notional;
  const sizeToken = mark > 0 ? notional / mark : 0;

  return (
    <div className="mb-3 rounded-xl bg-system-bg-secondary p-3 space-y-3">
      <div className="flex flex-wrap gap-2">
        {SYMBOLS.map((s) => (
          <button
            key={s}
            onClick={() => setSymbol(s)}
            className={`px-3 h-8 rounded-[8px] text-[12px] font-semibold ${
              symbol === s ? 'bg-white shadow-ios-1 text-label-primary' : 'text-label-tertiary'
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-[8px] bg-white p-0.5">
          {(['LONG', 'SHORT'] as Side[]).map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={`px-3 py-1 rounded-[6px] text-[11px] font-semibold ${
                side === s
                  ? s === 'LONG' ? 'bg-[#34C759]/20 text-[#34C759]' : 'bg-[#FF3B30]/20 text-[#FF3B30]'
                  : 'text-label-tertiary'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-[8px] bg-white p-0.5">
          {LEVERAGES.map((l) => (
            <button
              key={l}
              onClick={() => setLeverage(l)}
              className={`px-2 py-1 rounded-[6px] text-[11px] font-semibold ${
                leverage === l ? 'bg-black/5 text-label-primary' : 'text-label-tertiary'
              }`}
            >
              {l}×
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          step="any"
          min="1"
          value={sizeUsd}
          onChange={(e) => setSizeUsd(e.target.value)}
          placeholder="Notional (USD)"
          className="flex-1 h-9 px-3 rounded-[8px] border border-black/10 tabular-nums text-[13px] focus:outline-none"
        />
        <button
          onClick={() => onOpen(symbol, side, notional, leverage)}
          disabled={!mark || notional <= 0}
          className="h-9 px-3 rounded-[8px] text-white font-semibold text-[12px] active:scale-[0.98] disabled:opacity-60"
          style={{ background: HEDERA_ACCENT }}
        >
          Open
        </button>
        <button
          onClick={onCancel}
          className="h-9 px-3 rounded-[8px] bg-white text-label-secondary font-medium text-[12px] active:scale-[0.98]"
        >
          Cancel
        </button>
      </div>
      <div className="text-[11px] text-label-tertiary leading-relaxed">
        Mark: {mark ? `$${fmtUsd(mark, symbol === 'SUI' ? 4 : 2)}` : '—'} ·
        {' '}Size: {sizeToken.toFixed(symbol === 'BTC' ? 6 : 4)} {symbol} ·
        {' '}Margin: ${fmtUsd(marginUsd)}
      </div>
    </div>
  );
}
