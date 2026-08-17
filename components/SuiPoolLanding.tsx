'use client';

import { memo } from 'react';
import nextDynamic from 'next/dynamic';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@/i18n/routing';
import {
  ArrowRightIcon, ShieldCheckIcon, BoltIcon, ChartBarIcon,
  SparklesIcon, CubeTransparentIcon, LockClosedIcon,
} from '@heroicons/react/24/outline';
import { InstallAppButton } from './InstallAppButton';

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
  if (!Number.isFinite(n)) return '—';
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
  if (!Number.isFinite(n) || n < 0) return `— ${plural}`;
  const rounded = Math.floor(n);
  if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1)}M ${plural}`;
  if (rounded >= 10_000)    return `${(rounded / 1_000).toFixed(1)}K ${plural}`;
  if (rounded >= 1_000)     return `${rounded.toLocaleString('en-US')} ${plural}`;
  return `${rounded} ${rounded === 1 ? singular : plural}`;
}

async function fetchPoolSummary(): Promise<PoolSummary | null> {
  const r = await fetch('/api/sui/community-pool?network=mainnet');
  const j = await r.json();
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
    const vr = await fetch('/api/sui/community-pool?action=volatility&network=mainnet');
    const vj = await vr.json();
    const verifiedAth = Number(vj?.data?.verifiedAth?.sharePrice ?? 0);
    if (verifiedAth > 0 && verifiedAth < onChainAth) {
      honestAth = verifiedAth;
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
  const { data: pool, isPending: loading } = useQuery({
    queryKey: ['sui-pool-landing'],
    queryFn: fetchPoolSummary,
    refetchInterval: 30_000,
    staleTime: 30_000,
  });

  // Return / ATH-drawdown deliberately not surfaced on landing — those live
  // on the dashboard where members expect P&L detail. The landing sells the
  // product (AI + ZK + on-chain execution), not the current tick of a small
  // pool that's been running through a crypto drawdown. See NavHistoryChart
  // below for the honest time-series (7D default keeps context tight).
  const capacityRemainingUsd = pool
    ? Math.max(0, TVL_CAP_USD - pool.totalNAV)
    : TVL_CAP_USD;

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
            <div className="inline-flex items-center gap-2.5 px-3.5 py-1.5 rounded-full bg-system-bg-grouped border border-separator-opaque/40">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-ios-green opacity-75 animate-ping" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-ios-green" />
              </span>
              <span className="text-footnote font-medium text-label-secondary">
                Live on SUI Mainnet
              </span>
              <span className="w-px h-3 bg-separator-opaque/40" />
              <span className="text-footnote font-semibold text-label-primary tabular-nums">
                {formatCount(pool?.memberCount ?? 0, 'member', 'members')}
              </span>
            </div>
          </div>

          {/* Headline — scales down on tiny screens so it doesn't overflow */}
          <h1 className="text-center text-[32px] xs:text-[36px] sm:text-[52px] md:text-[64px] lg:text-[80px] font-bold tracking-[-0.03em] leading-[1.05] text-label-primary mb-5 sm:mb-8 break-words">
            AI-managed USDC vault.
            <br />
            <span className="bg-gradient-to-r from-ios-blue to-[#5AC8FA] bg-clip-text text-transparent">
              Real returns. On chain.
            </span>
          </h1>

          {/* Subtitle */}
          <p className="text-center text-base sm:text-callout md:text-[20px] text-label-secondary max-w-[640px] mx-auto leading-relaxed sm:leading-[1.5] mb-8 sm:mb-12 px-1">
            Deposit USDC. A 7-agent system allocates across BTC, ETH, and SUI
            with auto-hedged perp protection on BlueFin. Verified by ZK-STARK
            proofs.
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 mb-6 sm:mb-8">
            <Link
              href="/dashboard"
              className="group inline-flex items-center justify-center gap-2 px-8 h-[52px] sm:h-[56px] bg-ios-blue text-white text-headline font-semibold rounded-ios-xl hover:bg-[#0062CC] active:scale-[0.97] transition-all duration-200 shadow-ios-2 w-full sm:w-auto"
            >
              Deposit USDC
              <ArrowRightIcon className="w-5 h-5 group-hover:translate-x-1 transition-transform" strokeWidth={2.5} />
            </Link>
            <a
              href="#how-it-works"
              className="inline-flex items-center gap-1 h-[52px] sm:h-[56px] px-2 text-headline font-medium text-label-secondary hover:text-ios-blue transition-colors"
            >
              How it works
              <ArrowRightIcon className="w-4 h-4" strokeWidth={2.25} />
            </a>
          </div>

          {/* Install-as-app row — renders nothing when already installed or the
              browser hasn't emitted beforeinstallprompt yet. Sits below the
              primary CTA so it doesn't compete with "Deposit USDC". */}
          <div className="flex justify-center mb-14 sm:mb-16">
            <InstallAppButton className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-white/80 backdrop-blur border border-separator-opaque/40 text-label-secondary text-sm font-medium hover:text-ios-blue hover:border-ios-blue/40 active:scale-[0.98] transition-all" />
          </div>

          {/* ─── LIVE STATS BAR ─── */}
          {/* Reframed 2026-08-17: hero used to lead with Total Return (in red
              while the pool is drawn down) and "Off ATH %" hint — read as a
              scary flag on a small pool. Replaced with capability/scale
              signals that answer "is this real and can I get in?" — leaving
              return context to the chart below and the /dashboard tab. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-4 max-w-[920px] mx-auto min-w-0">
            <StatCard
              label="Pool NAV"
              value={loading ? '—' : formatUsd(pool?.totalNAV ?? 0)}
              hint="Live on-chain"
              loading={loading}
            />
            <StatCard
              label="Capacity"
              value={loading ? '—' : formatUsd(capacityRemainingUsd)}
              hint={`of ${formatUsd(TVL_CAP_USD)} cap`}
              loading={loading}
            />
            <StatCard
              label="Members"
              value={loading ? '—' : formatCount(pool?.memberCount ?? 0, 'member', 'members').split(' ')[0]}
              hint="Depositing today"
              loading={loading}
            />
            <StatCard
              label="Share Price"
              value={loading ? '—' : `$${(pool?.sharePrice ?? 1).toFixed(4)}`}
              hint="Inception $1.0000"
              loading={loading}
            />
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
        <div className="max-w-[1100px] mx-auto">
          <div className="flex flex-col lg:flex-row gap-8 sm:gap-12 lg:gap-16 items-start min-w-0">
            {/* Left: heading */}
            <div className="lg:max-w-[420px] lg:sticky lg:top-24 min-w-0">
              <p className="text-[11px] sm:text-caption-1 font-semibold uppercase tracking-wide text-ios-blue mb-2 sm:mb-3">
                Live composition
              </p>
              <h2 className="text-[26px] sm:text-[34px] md:text-[40px] lg:text-[48px] font-bold tracking-[-0.02em] leading-[1.1] text-label-primary mb-3 sm:mb-5 break-words">
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
                              {pool ? formatUsd((pool.totalNAV * Number(pct)) / 100, 2) : '—'}
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
        </div>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* HOW IT WORKS                                                    */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section id="how-it-works" className="py-14 sm:py-20 md:py-28 px-4 sm:px-5 lg:px-8 bg-system-bg-primary min-w-0">
        <div className="max-w-[1100px] mx-auto">
          <div className="text-center mb-10 sm:mb-14 md:mb-16">
            <p className="text-[11px] sm:text-caption-1 font-semibold uppercase tracking-wide text-ios-blue mb-2 sm:mb-3">
              How it works
            </p>
            <h2 className="text-[26px] sm:text-[34px] md:text-[44px] lg:text-[52px] font-bold tracking-[-0.02em] leading-[1.1] text-label-primary mb-3 sm:mb-4 break-words">
              Three things working together.
            </h2>
            <p className="text-sm sm:text-callout text-label-secondary max-w-[560px] mx-auto leading-relaxed sm:leading-[1.55] px-1">
              A continuous loop runs every 30 minutes. You just deposit and watch.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4 md:gap-6 min-w-0">
            <FeatureCard
              icon={<SparklesIcon className="w-6 h-6" />}
              accent="from-[#007AFF] to-[#5AC8FA]"
              eyebrow="Step 1"
              title="AI decides"
              body="Seven specialised agents fuse Polymarket prediction signals, Crypto.com price feeds and funding rates into one allocation target."
            />
            <FeatureCard
              icon={<BoltIcon className="w-6 h-6" />}
              accent="from-[#34C759] to-[#30D158]"
              eyebrow="Step 2"
              title="Pool rebalances"
              body="USDC is swapped on-chain across BTC, ETH and SUI via the 7k aggregator. Drift-based — only trades when allocation actually shifts."
            />
            <FeatureCard
              icon={<ShieldCheckIcon className="w-6 h-6" />}
              accent="from-[#AF52DE] to-[#BF5AF2]"
              eyebrow="Step 3"
              title="Hedges open"
              body="A matching BlueFin perp position is opened or adjusted to delta-neutralise downside while keeping upside exposure."
            />
          </div>
        </div>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* TRUST STRIP — safety guarantees on chain                        */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section className="py-12 sm:py-20 md:py-24 px-4 sm:px-5 lg:px-8 bg-system-bg-secondary min-w-0">
        <div className="max-w-[1100px] mx-auto">
          <div className="text-center mb-8 sm:mb-12">
            <p className="text-[11px] sm:text-caption-1 font-semibold uppercase tracking-wide text-ios-blue mb-2 sm:mb-3">
              Built for trust
            </p>
            <h2 className="text-[24px] sm:text-[28px] md:text-[36px] lg:text-[42px] font-bold tracking-[-0.02em] leading-[1.15] text-label-primary mb-3 break-words">
              Every safety guard is on chain.
            </h2>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-4 min-w-0">
            <TrustCard
              icon={<LockClosedIcon className="w-5 h-5" />}
              title="TVL cap"
              value="$10,000"
              hint="Hard ceiling enforced in Move"
            />
            <TrustCard
              icon={<CubeTransparentIcon className="w-5 h-5" />}
              title="NAV oracle"
              value="Strict mode"
              hint="Deposits revert if attestation is > 2 h stale"
            />
            <TrustCard
              icon={<ShieldCheckIcon className="w-5 h-5" />}
              title="Withdraw cap"
              value="25% / day"
              hint="Per-tx safety throttle"
            />
            <TrustCard
              icon={<ChartBarIcon className="w-5 h-5" />}
              title="ZK-STARK proofs"
              value="Post-quantum"
              hint="Risk attestations published"
            />
          </div>
        </div>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* PLATFORM SURFACES — discoverability for the BlackRock-shaped views */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section className="py-14 sm:py-20 md:py-24 px-4 sm:px-5 lg:px-8 bg-system-bg-secondary border-y border-separator-opaque/20 min-w-0">
        <div className="max-w-[1100px] mx-auto">
          <div className="text-center mb-8 sm:mb-10 md:mb-12">
            <div className="inline-block text-[11px] sm:text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary mb-2 sm:mb-3">
              How it works
            </div>
            <h2 className="text-[24px] sm:text-[28px] md:text-[36px] lg:text-[44px] font-bold tracking-[-0.02em] leading-[1.1] text-label-primary mb-3 sm:mb-4 break-words">
              An asset manager you can audit line by line.
            </h2>
            <p className="text-sm sm:text-callout md:text-[18px] text-label-secondary max-w-[640px] mx-auto leading-relaxed sm:leading-[1.5] px-1">
              A 7-agent orchestration fuses prediction-market signals, executes
              hedges on BlueFin, and ZK-attests every meaningful decision — all
              live on Sui mainnet.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 min-w-0">
            <SurfaceCard
              href="/dashboard/portfolio"
              eyebrow="Your position"
              title="Pool shares + attributed hedges."
              body="See what you own in the vault and which hedges are covering your risk."
            />
            <SurfaceCard
              href="/dashboard/risk"
              eyebrow="Platform risk"
              title="Live vault dashboard."
              body="Real-time TVL, drawdown, hedge coverage, cron health, ZK attestation feed. Auto-refresh 60s."
            />
            <SurfaceCard
              href="/rwa"
              eyebrow="RWA custody"
              title="Real-world assets, provably backed."
              body="Custodian-signed attestations bind portfolios to off-chain assets — without revealing the list. For issuers, custodians, institutions."
            />
            <SurfaceCard
              href="/agents"
              eyebrow="7-agent system"
              title="Autonomous orchestration."
              body="Lead, Risk, Hedging, Settlement, Reporting, PriceMonitor, SuiPool — running 24/7 with 2-of-3 consensus on trades &gt; $100k."
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
        </div>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* FOOTER CTA                                                      */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section className="py-14 sm:py-20 md:py-28 px-4 sm:px-5 lg:px-8 bg-system-bg-primary min-w-0">
        <div className="max-w-[800px] mx-auto text-center min-w-0">
          <h2 className="text-[26px] sm:text-[34px] md:text-[44px] lg:text-[52px] font-bold tracking-[-0.02em] leading-[1.1] text-label-primary mb-4 sm:mb-5 break-words">
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
          <Link
            href="/dashboard"
            className="group inline-flex items-center justify-center gap-2 w-full sm:w-auto px-8 sm:px-10 h-[52px] sm:h-[56px] bg-ios-blue text-white text-base sm:text-headline font-semibold rounded-ios-xl hover:bg-[#0062CC] active:scale-[0.97] transition-all duration-200 shadow-ios-2"
          >
            Open Dashboard
            <ArrowRightIcon className="w-5 h-5 group-hover:translate-x-1 transition-transform" strokeWidth={2.5} />
          </Link>
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
// Subcomponents
// ───────────────────────────────────────────────────────────────────────────

function StatCard({
  label, value, hint, valueClass = 'text-label-primary', loading = false,
}: {
  label: string; value: string; hint?: string; valueClass?: string; loading?: boolean;
}) {
  return (
    <div className="bg-system-bg-primary rounded-ios-xl p-3 sm:p-5 md:p-6 shadow-ios-1 border border-separator-opaque/30 min-w-0">
      <div className="text-[10px] sm:text-caption-1 font-medium uppercase tracking-wide text-label-tertiary mb-1.5 sm:mb-2 truncate">
        {label}
      </div>
      <div className={`text-lg sm:text-title-2 md:text-title-1 font-bold tabular-nums break-all ${valueClass} ${loading ? 'animate-pulse' : ''}`}>
        {value}
      </div>
      {hint && (
        <div className="text-[10px] sm:text-caption-1 text-label-tertiary mt-1 sm:mt-1.5 tabular-nums truncate">{hint}</div>
      )}
    </div>
  );
}

function FeatureCard({
  icon, accent, eyebrow, title, body,
}: {
  icon: React.ReactNode; accent: string; eyebrow: string; title: string; body: string;
}) {
  return (
    <div className="bg-system-bg-secondary rounded-ios-xl p-4 sm:p-6 md:p-7 border border-separator-opaque/30 hover:shadow-ios-2 transition-shadow duration-300 min-w-0">
      <div
        className={`inline-flex items-center justify-center w-10 h-10 sm:w-11 sm:h-11 rounded-ios bg-gradient-to-br ${accent} text-white mb-3 sm:mb-5 shadow-ios-1 flex-shrink-0`}
      >
        {icon}
      </div>
      <div className="text-[10px] sm:text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary mb-1 sm:mb-1.5">
        {eyebrow}
      </div>
      <h3 className="text-base sm:text-title-3 font-semibold text-label-primary mb-1.5 sm:mb-2 break-words">{title}</h3>
      <p className="text-sm sm:text-subheadline text-label-secondary leading-relaxed sm:leading-[1.55] break-words">{body}</p>
    </div>
  );
}

function TrustCard({
  icon, title, value, hint,
}: {
  icon: React.ReactNode; title: string; value: string; hint: string;
}) {
  return (
    <div className="bg-system-bg-primary rounded-ios-xl p-3 sm:p-5 md:p-6 border border-separator-opaque/30 shadow-ios-1 min-w-0">
      <div className="flex items-center gap-1.5 sm:gap-2 mb-2 sm:mb-3 min-w-0">
        <div className="text-ios-blue flex-shrink-0">{icon}</div>
        <div className="text-[10px] sm:text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary truncate">
          {title}
        </div>
      </div>
      <div className="text-base sm:text-title-3 md:text-title-2 font-bold text-label-primary mb-1 break-words tabular-nums">{value}</div>
      <div className="text-[10px] sm:text-caption-1 text-label-tertiary leading-[1.4] break-words">{hint}</div>
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
        <ArrowRightIcon
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
