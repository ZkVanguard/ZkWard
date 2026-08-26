'use client';

import { memo, useEffect, useState } from 'react';
import nextDynamic from 'next/dynamic';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@/i18n/routing';
import {
  ArrowRight, ShieldCheck, Zap, BarChart3,
  Sparkles, Layers, Lock,
} from 'lucide-react';
import { InstallAppButton } from './InstallAppButton';
import { Reveal, LiveIndicator, StatusPill, TrustBadge } from './ui/landing';

// Chart is heavy (chart.js + react-chartjs-2). Dynamic-import so the landing
// paints instantly and the chart hydrates below-the-fold when the user reaches
// it. Prevents the hero LCP being blocked by chart bundle download.
const NavHistoryChart = nextDynamic(
  () => import('./dashboard/NavHistoryChart').then((m) => ({ default: m.NavHistoryChart })),
  { ssr: false, loading: () => <div className="h-64 sm:h-72 bg-system-bg-secondary rounded-ios-xl animate-pulse" /> },
);

// TVL cap enforced by the Move contract. Surfacing "room remaining" on the
// landing gives visitors a scale anchor without leading with the current
// (small) NAV. If the on-chain cap changes, bump this constant — the display
// is intentionally not fetched (it's a marketing rail, not a live gate).
const TVL_CAP_USD = 10_000;

// ───────────────────────────────────────────────────────────────────────────
// Live SUI Community Pool landing page — Apple-themed, single focus.
//
// Pulls real-time numbers from /api/sui/community-pool?network=mainnet
// (cached 30s server-side), so a fresh visitor sees actual NAV / share price /
// composition / ATH instead of stale marketing.
//
// Design tokens: tailwind.config.js `ios.*`, `system-bg.*`, `label.*`,
// typography `large-title`, `title-1`, `headline`, etc., shadows `ios-1/2/3`.
// No warm `claude-*` colors anywhere.
// ───────────────────────────────────────────────────────────────────────────

interface PoolSummary {
  totalNAV: number;        // USDC
  sharePrice: number;
  allTimeHighNav: number;  // ATH share price
  totalDeposited: number;
  totalWithdrawn: number;
  memberCount: number;
  totalShares: number;
  allocation: Record<string, number>; // live composition (BTC/ETH/SUI/USDC)
  paused: boolean;
}

const ASSET_ICONS: Record<string, string> = {
  BTC: '₿', ETH: 'Ξ', SUI: '💧', USDC: '$',
};
const ASSET_GRADIENTS: Record<string, string> = {
  BTC: 'from-[#F7931A] to-[#FBB040]',
  ETH: 'from-[#627EEA] to-[#8FA5F2]',
  SUI: 'from-[#4DA2FF] to-[#79C2FF]',
  USDC: 'from-[#2775CA] to-[#4A9CE8]',
};

function formatUsd(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '…';
  const abs = Math.abs(n);
  // Compact suffixes above 10k so the stat cards stay readable at scale.
  // ($3,214,857 in a card is a nightmare; $3.21M is fine.)
  if (abs >= 1_000_000_000) return `${n < 0 ? '-' : ''}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000)     return `${n < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000)        return `${n < 0 ? '-' : ''}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1_000)         return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return '$' + n.toFixed(decimals);
}

// Compact member/share formatter that also handles pluralisation.
function formatCount(n: number, singular: string, plural: string): string {
  if (!Number.isFinite(n) || n < 0) return `… ${plural}`;
  const rounded = Math.floor(n);
  if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1)}M ${plural}`;
  if (rounded >= 10_000)    return `${(rounded / 1_000).toFixed(1)}K ${plural}`;
  if (rounded >= 1_000)     return `${rounded.toLocaleString('en-US')} ${plural}`;
  return `${rounded} ${rounded === 1 ? singular : plural}`;
}

async function fetchPoolSummary(): Promise<PoolSummary | null> {
  // Fire both in parallel — the volatility fetch's URL doesn't depend on
  // the main fetch's data, only its result gates the final honestAth
  // decision below. Sequential await would double the load-time round-trip.
  const [mainRes, volRes] = await Promise.all([
    fetch('/api/sui/community-pool?network=mainnet'),
    fetch('/api/sui/community-pool?action=volatility&network=mainnet').catch(() => null),
  ]);
  const j = await mainRes.json();
  if (!j?.success || !j?.data) return null;
  const d = j.data;
  // Overlay DB-verified ATH on top of the on-chain phantom.
  // See useCommunityPool.ts for the full rationale: Move's ATH is a
  // monotonic ratchet, so a single pre-stabilizer jitter spike locked
  // in a peak that never actually persisted. The volatility endpoint
  // returns the honest ATH computed from non-clamped DB snapshots. If
  // it's higher-than-zero AND lower-than-on-chain (i.e. on-chain is
  // inflated), use it. Otherwise trust the on-chain value.
  const onChainAth = Number(d.allTimeHighNav ?? 1);
  let honestAth = onChainAth;
  try {
    if (volRes) {
      const vj = await volRes.json();
      const verifiedAth = Number(vj?.data?.verifiedAth?.sharePrice ?? 0);
      if (verifiedAth > 0 && verifiedAth < onChainAth) honestAth = verifiedAth;
    }
  } catch {
    /* non-critical — fall back to on-chain value */
  }
  return {
    totalNAV: Number(d.totalNAV ?? 0),
    sharePrice: Number(d.sharePrice ?? 1),
    allTimeHighNav: honestAth,
    totalDeposited: Number(d.totalDeposited ?? 0),
    totalWithdrawn: Number(d.totalWithdrawn ?? 0),
    memberCount: Number(d.memberCount ?? 0),
    totalShares: Number(d.totalShares ?? 0),
    allocation: d.allocation ?? {},
    paused: !!d.paused,
  };
}

export const SuiPoolLanding = memo(function SuiPoolLanding() {
  const { data: pool, isPending: loading, dataUpdatedAt } = useQuery({
    queryKey: ['sui-pool-landing'],
    queryFn: fetchPoolSummary,
    refetchInterval: 30_000,
    staleTime: 30_000,
  });

  // Build allocation legend (positive entries only)
  const allocationEntries = pool
    ? Object.entries(pool.allocation || {})
        .filter(([, v]) => Number(v) > 0)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
    : [];

  return (
    <div className="bg-system-bg-primary text-label-primary">
      {/* ─────────────────────────────────────────────────────────────── */}
      {/* HERO                                                            */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section className="relative pt-20 pb-12 sm:pt-32 sm:pb-24 lg:pt-40 lg:pb-32 px-4 sm:px-5 lg:px-8 overflow-hidden min-w-0">
        {/* Apple-style soft gradient backdrop */}
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-system-bg-tertiary via-system-bg-primary to-system-bg-primary" />
        <div
          className="absolute -z-10 top-0 left-1/2 -translate-x-1/2 w-[120%] h-[600px] opacity-30"
          style={{
            background:
              'radial-gradient(ellipse at center, rgba(0,122,255,0.15) 0%, rgba(0,122,255,0) 60%)',
          }}
        />

        <div className="max-w-[1100px] mx-auto">
          {/* Status pill */}
          <div className="flex items-center justify-center mb-8 sm:mb-10">
            <StatusPill
              left={<LiveIndicator label="Live on SUI Mainnet" />}
              right={
                <span className="text-footnote font-semibold text-label-primary tabular-nums">
                  {formatCount(pool?.memberCount ?? 0, 'member', 'members')}
                </span>
              }
            />
          </div>

          {/* Headline — tightened to 2 short lines, no gradient text (the
              Vault Meter below is the visual signature). Space Grotesk
              display face gives numbers + short phrases distinctive shape. */}
          <h1 className="font-display text-center text-[38px] xs:text-[44px] sm:text-[60px] md:text-[72px] lg:text-[84px] font-semibold tracking-[-0.04em] leading-[0.96] text-label-primary mb-4 sm:mb-6 break-words">
            Your USDC.
            <br />
            Actively managed on-chain.
          </h1>

          {/* Subtitle — 15 words, one line's worth on desktop */}
          <p className="text-center text-base sm:text-[19px] text-label-secondary max-w-[580px] mx-auto leading-relaxed mb-10 sm:mb-14 px-1">
            A 7-agent AI vault. BTC, ETH, SUI with auto-hedged perps on BlueFin.
            Verified by ZK-STARK.
          </p>

          {/* ─── VAULT METER (signature element) ─── */}
          {/* Shows the vault's live state as the hero's real visual, instead
              of a text hero + stat cards. NAV + composition + capacity in one
              card. This is "the product IS the pitch". */}
          <div className="max-w-[720px] mx-auto mb-3 sm:mb-4">
            <VaultMeter pool={pool} loading={loading} cap={TVL_CAP_USD} />
          </div>
          {/* Live-refresh ticker — proves the auto-refresh cadence is real,
              not marketing copy. Uses useQuery's dataUpdatedAt (client truth). */}
          <div className="max-w-[720px] mx-auto mb-8 sm:mb-10">
            <RefreshTicker updatedAt={dataUpdatedAt} intervalMs={30_000} loading={loading} />
          </div>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 mb-6">
            <Link
              href="/dashboard"
              className="group inline-flex items-center justify-center gap-2 px-8 h-[52px] sm:h-[56px] bg-ios-blue text-white text-headline font-semibold rounded-ios-xl hover:bg-[#0062CC] active:scale-[0.97] transition-all duration-200 shadow-ios-2 w-full sm:w-auto"
            >
              Deposit USDC
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" strokeWidth={2.5} />
            </Link>
            <a
              href="#how-it-works"
              className="inline-flex items-center gap-1 h-[52px] sm:h-[56px] px-2 text-headline font-medium text-label-secondary hover:text-ios-blue transition-colors"
            >
              How it works
              <ArrowRight className="w-4 h-4" strokeWidth={2.25} />
            </a>
          </div>

          {/* Install-as-app row — renders nothing when already installed or the
              browser hasn't emitted beforeinstallprompt yet. */}
          <div className="flex justify-center">
            <InstallAppButton className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-white/80 backdrop-blur border border-separator-opaque/40 text-label-secondary text-sm font-medium hover:text-ios-blue hover:border-ios-blue/40 active:scale-[0.98] transition-all" />
          </div>
        </div>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* SHARE-PRICE HISTORY — honest time-series context                */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section className="py-8 sm:py-14 md:py-16 px-4 sm:px-5 lg:px-8 bg-system-bg-primary min-w-0">
        <div className="max-w-[920px] mx-auto">
          <NavHistoryChart />
          <p className="text-center text-xs sm:text-footnote text-label-tertiary mt-4 leading-relaxed">
            Every point is a real on-chain snapshot. Toggle the window to see recent behaviour or the full history.
          </p>
        </div>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* LIVE COMPOSITION                                                */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section className="py-12 sm:py-20 md:py-24 px-4 sm:px-5 lg:px-8 bg-system-bg-secondary min-w-0">
        <Reveal className="max-w-[1100px] mx-auto">
          <div className="flex flex-col lg:flex-row gap-8 sm:gap-12 lg:gap-16 items-start min-w-0">
            {/* Left: heading */}
            <div className="lg:max-w-[420px] lg:sticky lg:top-24 min-w-0">
              <p className="text-[11px] sm:text-caption-1 font-semibold uppercase tracking-wide text-ios-blue mb-2 sm:mb-3">
                Live composition
              </p>
              <h2 className="text-[26px] sm:text-[34px] md:text-[40px] lg:text-[48px] font-display font-semibold tracking-[-0.03em] leading-[1.05] text-label-primary mb-3 sm:mb-5 break-words">
                Where your USDC is right now.
              </h2>
              <p className="text-sm sm:text-callout text-label-secondary leading-relaxed sm:leading-[1.55]">
                The AI rebalances every 30 minutes across BTC, ETH and SUI based
                on live market signals. Idle USDC counts as a defensive bucket.
                Refreshes every 30s.
              </p>
            </div>

            {/* Right: allocation visualization */}
            <div className="flex-1 w-full">
              {!loading && allocationEntries.length > 0 ? (
                <div className="bg-system-bg-primary rounded-ios-xl p-6 sm:p-8 shadow-ios-1 border border-separator-opaque/30">
                  {/* Stack bar */}
                  <div className="h-3 rounded-full overflow-hidden flex mb-6 bg-system-bg-grouped">
                    {allocationEntries.map(([asset, pct]) => (
                      <div
                        key={asset}
                        className={`bg-gradient-to-r ${ASSET_GRADIENTS[asset] || 'from-gray-300 to-gray-400'}`}
                        style={{ width: `${pct}%` }}
                        title={`${asset} ${pct}%`}
                      />
                    ))}
                  </div>

                  {/* Legend */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
                    {allocationEntries.map(([asset, pct]) => (
                      <div key={asset} className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-9 h-9 rounded-ios bg-gradient-to-br ${
                              ASSET_GRADIENTS[asset] || 'from-gray-300 to-gray-400'
                            } flex items-center justify-center text-white text-base font-semibold shadow-ios-1`}
                          >
                            {ASSET_ICONS[asset] || '?'}
                          </div>
                          <div>
                            <div className="text-headline font-semibold text-label-primary">{asset}</div>
                            <div className="text-caption-1 text-label-tertiary">
                              {pool ? formatUsd((pool.totalNAV * Number(pct)) / 100, 2) : '…'}
                            </div>
                          </div>
                        </div>
                        <div className="text-title-3 font-semibold text-label-primary tabular-nums">
                          {Number(pct).toFixed(1)}%
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="bg-system-bg-primary rounded-ios-xl p-8 shadow-ios-1 border border-separator-opaque/30 animate-pulse">
                  <div className="h-3 bg-system-bg-grouped rounded-full mb-6" />
                  <div className="space-y-4">
                    {[1, 2, 3, 4].map(i => (
                      <div key={i} className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-ios bg-system-bg-grouped" />
                          <div className="w-16 h-4 bg-system-bg-grouped rounded" />
                        </div>
                        <div className="w-12 h-4 bg-system-bg-grouped rounded" />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </Reveal>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* HOW IT WORKS                                                    */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section id="how-it-works" className="py-14 sm:py-20 md:py-28 px-4 sm:px-5 lg:px-8 bg-system-bg-primary min-w-0">
        <Reveal className="max-w-[1100px] mx-auto">
          <div className="text-center mb-10 sm:mb-14 md:mb-16">
            <p className="text-[11px] sm:text-caption-1 font-semibold uppercase tracking-wide text-ios-blue mb-2 sm:mb-3">
              How it works
            </p>
            <h2 className="text-[26px] sm:text-[34px] md:text-[44px] lg:text-[52px] font-display font-semibold tracking-[-0.03em] leading-[1.05] text-label-primary mb-3 sm:mb-4 break-words">
              Three things working together.
            </h2>
            <p className="text-sm sm:text-callout text-label-secondary max-w-[560px] mx-auto leading-relaxed sm:leading-[1.55] px-1">
              A continuous loop runs every 30 minutes. You just deposit and watch.
            </p>
          </div>

          <div className="max-w-[760px] mx-auto min-w-0">
            <TimelineStep
              step={1}
              icon={<Sparkles className="w-5 h-5" />}
              accent="from-[#007AFF] to-[#5AC8FA]"
              title="AI decides"
              body="Seven specialised agents fuse Polymarket prediction signals, Crypto.com price feeds and funding rates into one allocation target."
            />
            <TimelineStep
              step={2}
              icon={<Zap className="w-5 h-5" />}
              accent="from-[#34C759] to-[#30D158]"
              title="Pool rebalances"
              body="USDC is swapped on-chain across BTC, ETH and SUI via the 7k aggregator. Drift-based: only trades when allocation actually shifts."
            />
            <TimelineStep
              step={3}
              icon={<ShieldCheck className="w-5 h-5" />}
              accent="from-[#AF52DE] to-[#BF5AF2]"
              title="Hedges open"
              body="A matching BlueFin perp position is opened or adjusted to delta-neutralise downside while keeping upside exposure."
              last
            />
          </div>
        </Reveal>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* TRUST STRIP — safety guarantees on chain                        */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section className="py-12 sm:py-20 md:py-24 px-4 sm:px-5 lg:px-8 bg-system-bg-secondary min-w-0">
        <Reveal className="max-w-[1100px] mx-auto">
          <div className="text-center mb-8 sm:mb-12">
            <h2 className="text-[24px] sm:text-[28px] md:text-[36px] lg:text-[42px] font-display font-semibold tracking-[-0.03em] leading-[1.05] text-label-primary mb-3 break-words">
              Every safety guard is on chain.
            </h2>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-4 min-w-0">
            <TrustBadge
              icon={<Lock className="w-5 h-5" />}
              title="TVL cap"
              value="$10,000"
              hint="Hard ceiling enforced in Move"
            />
            <TrustBadge
              icon={<Layers className="w-5 h-5" />}
              title="NAV oracle"
              value="Strict mode"
              hint="Deposits revert if attestation is > 2 h stale"
            />
            <TrustBadge
              icon={<ShieldCheck className="w-5 h-5" />}
              title="Withdraw cap"
              value="25% / day"
              hint="Per-tx safety throttle"
            />
            <TrustBadge
              icon={<BarChart3 className="w-5 h-5" />}
              title="ZK-STARK proofs"
              value="Post-quantum"
              hint="Risk attestations published"
            />
          </div>
        </Reveal>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* PLATFORM SURFACES — discoverability for the BlackRock-shaped views */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section className="py-14 sm:py-20 md:py-24 px-4 sm:px-5 lg:px-8 bg-system-bg-secondary border-y border-separator-opaque/20 min-w-0">
        <Reveal className="max-w-[1100px] mx-auto">
          <div className="text-center mb-8 sm:mb-10 md:mb-12">
            <div className="inline-block text-[11px] sm:text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary mb-2 sm:mb-3">
              Explore the platform
            </div>
            <h2 className="text-[24px] sm:text-[28px] md:text-[36px] lg:text-[44px] font-display font-semibold tracking-[-0.03em] leading-[1.05] text-label-primary mb-3 sm:mb-4 break-words">
              An asset manager you can audit line by line.
            </h2>
            <p className="text-sm sm:text-callout md:text-[18px] text-label-secondary max-w-[640px] mx-auto leading-relaxed sm:leading-[1.5] px-1">
              A 7-agent orchestration fuses prediction-market signals, executes
              hedges on BlueFin, and ZK-attests every meaningful decision. All
              live on Sui mainnet.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 min-w-0">
            <SurfaceCard
              href="/dashboard"
              eyebrow="Your dashboard"
              title="Position, risk, and hedges in one place."
              body="Pool shares, attributed hedges, live TVL, drawdown, cron health, and the ZK attestation feed. Auto-refresh 60s."
            />
            <SurfaceCard
              href="/rwa"
              eyebrow="RWA custody"
              title="Real-world assets, provably backed."
              body="Custodian-signed attestations bind portfolios to off-chain assets. The list itself stays private. For issuers, custodians, institutions."
            />
            <SurfaceCard
              href="/agents"
              eyebrow="7-agent system"
              title="Autonomous orchestration."
              body="Lead, Risk, Hedging, Settlement, Reporting, PriceMonitor, SuiPool. Running 24/7 with 2-of-3 consensus on trades over $100k."
            />
            <SurfaceCard
              href="/zk"
              eyebrow="ZK-STARK system"
              title="Post-quantum verifiable AI."
              body="CUDA-accelerated STARK prover. ~180-bit soundness, no trusted setup, verifiable in the browser."
            />
            <SurfaceCard
              href="/whitepaper"
              eyebrow="Whitepaper"
              title="Read the full thesis."
              body="Prediction-market alpha, 7-agent architecture, STARK-attested execution, tokenomics, roadmap."
            />
          </div>
        </Reveal>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* FOOTER CTA                                                      */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section className="py-14 sm:py-20 md:py-28 px-4 sm:px-5 lg:px-8 bg-system-bg-primary min-w-0">
        <div className="max-w-[800px] mx-auto text-center min-w-0">
          <h2 className="text-[26px] sm:text-[34px] md:text-[44px] lg:text-[52px] font-display font-semibold tracking-[-0.03em] leading-[1.05] text-label-primary mb-4 sm:mb-5 break-words">
            Join in seconds.
          </h2>
          <p className="text-sm sm:text-callout md:text-[20px] text-label-secondary mb-6 sm:mb-8 leading-relaxed sm:leading-[1.5] px-1">
            Connect a SUI wallet, deposit any amount of USDC, and let the
            AI work.{' '}
            {pool ? (
              <>Currently {formatCount(pool.memberCount, 'member', 'members')} · live on SUI Mainnet.</>
            ) : (
              <>Live on SUI Mainnet.</>
            )}
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4">
            <Link
              href="/dashboard"
              className="group inline-flex items-center justify-center gap-2 w-full sm:w-auto px-8 sm:px-10 h-[52px] sm:h-[56px] bg-ios-blue text-white text-base sm:text-headline font-semibold rounded-ios-xl hover:bg-[#0062CC] active:scale-[0.97] transition-all duration-200 shadow-ios-2"
            >
              Deposit USDC
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" strokeWidth={2.5} />
            </Link>
            <a
              href="https://github.com/ZkVanguard/ZkWard"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 h-[52px] sm:h-[56px] px-2 text-headline font-medium text-label-secondary hover:text-ios-blue transition-colors"
            >
              View source
              <ArrowRight className="w-4 h-4" strokeWidth={2.25} />
            </a>
          </div>
          {pool?.paused && (
            <p className="mt-4 sm:mt-6 text-xs sm:text-footnote text-ios-orange font-medium">
              Note: deposits are currently paused for maintenance.
            </p>
          )}
        </div>
      </section>
    </div>
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Subcomponents (page-specific — shared primitives live in ./ui/landing)
// ───────────────────────────────────────────────────────────────────────────

// RefreshTicker — small "Live · updated Ns ago · next in Ns" strip that ticks
// every second. Uses useQuery's dataUpdatedAt as ground truth (real client
// timestamp when the fetch resolved) so it can't lie about staleness.
function RefreshTicker({
  updatedAt, intervalMs, loading,
}: {
  updatedAt: number; intervalMs: number; loading: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (loading || !updatedAt) return null;
  const ageMs = Math.max(0, now - updatedAt);
  const ageS = Math.floor(ageMs / 1000);
  const nextS = Math.max(0, Math.ceil((intervalMs - ageMs) / 1000));
  return (
    <div className="flex items-center justify-center gap-2 text-[11px] sm:text-caption-1 text-label-tertiary tabular-nums">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full rounded-full bg-ios-green opacity-75 animate-ping" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-ios-green" />
      </span>
      <span>Live</span>
      <span className="w-px h-3 bg-separator-opaque/40" />
      <span>Updated {ageS}s ago</span>
      <span className="w-px h-3 bg-separator-opaque/40 hidden sm:inline-block" />
      <span className="hidden sm:inline">Next refresh in {nextS}s</span>
    </div>
  );
}

// VaultMeter — the hero's signature element. A single card that IS the
// vault's live state: NAV, allocation, capacity. Replaces the generic
// text-hero + 4-stat-card pattern. Every landing sells; this one shows.
function VaultMeter({
  pool, loading, cap,
}: {
  pool: PoolSummary | null | undefined;
  loading: boolean;
  cap: number;
}) {
  const entries = pool
    ? Object.entries(pool.allocation || {})
        .filter(([, v]) => Number(v) > 0)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
    : [];
  const capacityPct = pool ? Math.min(100, (pool.totalNAV / cap) * 100) : 0;

  return (
    <div className="relative bg-system-bg-primary rounded-[24px] p-5 sm:p-7 border border-separator-opaque/40 shadow-ios-2 overflow-hidden">
      {/* Brand accent bar — the one signature flourish */}
      <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-ios-blue via-[#5AC8FA] to-ios-blue" />

      {/* NAV + Share price */}
      <div className="flex items-end justify-between gap-4 mb-5 sm:mb-6 pt-1">
        <div className="min-w-0">
          <div className="text-[10px] sm:text-caption-1 uppercase tracking-wide font-semibold text-label-tertiary mb-1.5">
            Pool NAV
          </div>
          <div className={`text-[36px] sm:text-[52px] md:text-[60px] font-bold tabular-nums leading-none text-label-primary break-all ${loading ? 'animate-pulse' : ''}`}>
            {loading ? '…' : formatUsd(pool?.totalNAV ?? 0)}
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-[10px] sm:text-caption-1 uppercase tracking-wide font-semibold text-label-tertiary mb-1.5">
            Share price
          </div>
          <div className="text-[20px] sm:text-[26px] font-semibold tabular-nums text-label-primary">
            {loading ? '…' : `$${(pool?.sharePrice ?? 1).toFixed(4)}`}
          </div>
        </div>
      </div>

      {/* Composition bar + legend */}
      <div className="mb-5 sm:mb-6">
        <div className="h-2.5 rounded-full overflow-hidden flex bg-system-bg-grouped">
          {entries.length > 0 ? entries.map(([asset, pct]) => (
            <div
              key={asset}
              className={`bg-gradient-to-r ${ASSET_GRADIENTS[asset] || 'from-gray-300 to-gray-400'} transition-all duration-500`}
              style={{ width: `${pct}%` }}
              title={`${asset} ${pct}%`}
            />
          )) : (
            <div className="w-full bg-system-bg-grouped animate-pulse" />
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-xs sm:text-caption-1">
          {entries.map(([asset, pct]) => (
            <div key={asset} className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full bg-gradient-to-br ${ASSET_GRADIENTS[asset]}`} />
              <span className="font-semibold text-label-primary">{asset}</span>
              <span className="tabular-nums text-label-secondary">{Number(pct).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </div>

      {/* Capacity */}
      <div className="pt-5 sm:pt-6 border-t border-separator-opaque/30">
        <div className="flex items-center justify-between text-xs sm:text-caption-1 mb-2">
          <span className="text-label-tertiary uppercase tracking-wide font-semibold">Capacity</span>
          <span className="tabular-nums text-label-secondary">
            {loading ? '…' : `${formatUsd(pool?.totalNAV ?? 0)} of ${formatUsd(cap)}`}
          </span>
        </div>
        <div className="h-1 rounded-full bg-system-bg-grouped overflow-hidden">
          <div
            className="h-full bg-ios-blue rounded-full transition-all duration-700 ease-out"
            style={{ width: `${capacityPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// TimelineStep — vertical connected step. Replaces the banned "3 equal
// feature cards" pattern. Content genuinely is a sequence, so numbers help.
function TimelineStep({
  step, icon, accent, title, body, last = false,
}: {
  step: number;
  icon: React.ReactNode;
  accent: string;
  title: string;
  body: string;
  last?: boolean;
}) {
  return (
    <div className="relative flex gap-4 sm:gap-6 pb-8 sm:pb-10 last:pb-0">
      {!last && (
        <div className="absolute left-[19px] sm:left-[23px] top-11 sm:top-13 bottom-2 w-px bg-gradient-to-b from-separator-opaque/60 to-separator-opaque/10" />
      )}
      <div className="relative flex-shrink-0">
        <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-gradient-to-br ${accent} text-white flex items-center justify-center shadow-ios-1`}>
          {icon}
        </div>
        <div className="absolute -top-1.5 -right-1.5 w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-white border border-separator-opaque/40 text-[10px] sm:text-caption-1 font-bold text-label-primary flex items-center justify-center tabular-nums">
          {step}
        </div>
      </div>
      <div className="flex-1 min-w-0 pt-1">
        <h3 className="text-lg sm:text-title-3 font-semibold text-label-primary mb-1.5 break-words">
          {title}
        </h3>
        <p className="text-sm sm:text-callout text-label-secondary leading-relaxed break-words">
          {body}
        </p>
      </div>
    </div>
  );
}

function SurfaceCard({
  href, eyebrow, title, body,
}: {
  href: string; eyebrow: string; title: string; body: string;
}) {
  return (
    <Link
      href={href}
      className="group block bg-system-bg-primary rounded-ios-xl p-4 sm:p-5 md:p-6 border border-separator-opaque/30 hover:shadow-ios-2 hover:border-ios-blue/30 active:scale-[0.99] transition-all duration-300 min-w-0"
    >
      <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
        <div className="text-[10px] sm:text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary truncate">
          {eyebrow}
        </div>
        <ArrowRight
          className="w-4 h-4 text-label-tertiary group-hover:text-ios-blue group-hover:translate-x-1 transition-all flex-shrink-0"
          strokeWidth={2}
        />
      </div>
      <h3 className="text-sm sm:text-headline font-semibold text-label-primary mb-1 sm:mb-1.5 leading-tight break-words">
        {title}
      </h3>
      <p className="text-xs sm:text-subheadline text-label-secondary leading-relaxed sm:leading-[1.5] break-words">{body}</p>
    </Link>
  );
}
