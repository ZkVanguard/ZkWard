'use client';

import { useState, useEffect, Suspense } from 'react';
import nextDynamic from 'next/dynamic';
import { useAccount, useBalance } from '@/lib/wdk/wdk-hooks';
import {
  Bot,
  Shield,
  Briefcase,
  TrendingUp,
  BarChart3,
  MessageSquare,
  ChevronRight,
  X,
  Settings,
  Users,
  Activity,
  ShieldCheck,
  Layers,
  MoreHorizontal,
} from 'lucide-react';
import { MobileTabBar } from '@/components/dashboard/MobileTabBar';
import { PortfolioOverview } from '@/components/dashboard/PortfolioOverview';
import { useContractAddresses } from '@/lib/contracts/hooks';
import { usePositions } from '@/contexts/PositionsContext';
import { usePortfolioAction, type CustomActionPayload } from '@/contexts/AIDecisionsContext';
import { logger } from '@/lib/utils/logger';
import { useSui } from '@/app/sui-providers';
import type { PredictionMarket } from '@/lib/services/market-data/DelphiMarketService';

// Dynamic imports for code splitting
const AgentActivity = nextDynamic(
  () =>
    import('@/components/dashboard/AgentActivity').then((mod) => ({ default: mod.AgentActivity })),
  {
    loading: () => <LoadingSkeleton />,
    ssr: false,
  }
);

const RiskMetrics = nextDynamic(
  () => import('@/components/dashboard/RiskMetrics').then((mod) => ({ default: mod.RiskMetrics })),
  {
    loading: () => <LoadingSkeleton height="h-32" />,
    ssr: false,
  }
);

const PositionsList = nextDynamic(
  () =>
    import('@/components/dashboard/PositionsList').then((mod) => ({ default: mod.PositionsList })),
  {
    loading: () => <LoadingSkeleton height="h-60" />,
    ssr: false,
  }
);

const ActiveHedges = nextDynamic(
  () =>
    import('@/components/dashboard/ActiveHedges').then((mod) => ({ default: mod.ActiveHedges })),
  {
    loading: () => <LoadingSkeleton />,
    ssr: false,
  }
);

// SUI-only mode: EVM/Cronos-bound widgets were removed with the dead-code
// cleanup. Hedging is driven by the SUI Community Pool + BlueFin auto-hedge
// cron instead of manual modals. Re-add here when other chains re-enable.

const PredictionInsights = nextDynamic(
  () =>
    import('@/components/dashboard/PredictionInsights').then((mod) => ({
      default: mod.PredictionInsights,
    })),
  {
    loading: () => <LoadingSkeleton />,
    ssr: false,
  }
);

const EnhancedChat = nextDynamic(
  () =>
    import('@/components/dashboard/EnhancedChat').then((mod) => ({ default: mod.EnhancedChat })),
  {
    loading: () => null,
    ssr: false,
  }
);

const SettingsModal = nextDynamic(
  () =>
    import('@/components/dashboard/SettingsModal').then((mod) => ({ default: mod.SettingsModal })),
  {
    ssr: false,
  }
);

const TestnetUSDCFaucet = nextDynamic(
  () =>
    import('@/components/dashboard/MockUSDCFaucet').then((mod) => ({
      default: mod.MockUSDCFaucet,
    })),
  {
    ssr: false,
  }
);

const FiveMinSignalWidget = nextDynamic(
  () =>
    import('@/components/dashboard/FiveMinSignalWidget').then((mod) => ({
      default: mod.FiveMinSignalWidget,
    })),
  {
    loading: () => <LoadingSkeleton height="h-28" />,
    ssr: false,
  }
);

const CommunityPool = nextDynamic(
  () =>
    import('@/components/dashboard/CommunityPool').then((mod) => ({ default: mod.CommunityPool })),
  {
    loading: () => <LoadingSkeleton />,
    ssr: false,
  }
);

// Platform sub-tabs — extracted from former /dashboard/{portfolio,risk,custody}
// pages so they render as tabs inside this dashboard instead of separate routes.
const PortfolioTab = nextDynamic(
  () =>
    import('@/components/dashboard/pages/PortfolioTab').then((mod) => ({ default: mod.PortfolioTab })),
  { loading: () => <LoadingSkeleton />, ssr: false },
);

const RiskTab = nextDynamic(
  () =>
    import('@/components/dashboard/pages/RiskTab').then((mod) => ({ default: mod.RiskTab })),
  { loading: () => <LoadingSkeleton />, ssr: false },
);

const CustodyTab = nextDynamic(
  () =>
    import('@/components/dashboard/pages/CustodyTab').then((mod) => ({ default: mod.CustodyTab })),
  { loading: () => <LoadingSkeleton />, ssr: false },
);

// Reusable loading skeleton
function LoadingSkeleton({ height = 'h-40' }: { height?: string }) {
  return <div className={`animate-pulse bg-[#f5f5f7] ${height} rounded-[24px]`} />;
}

// Navigation configuration
interface NavItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
}

// Primary nav — surfaces the daily user actions (deposit + monitor).
// Vault first: flagship product; user lands on deposit/withdraw immediately.
const navItems: NavItem[] = [
  { id: 'community', label: 'Vault', icon: Users },
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'positions', label: 'Positions', icon: Briefcase },
  { id: 'hedges', label: 'Hedges', icon: Shield },
  { id: 'agents', label: 'AI Agents', icon: Bot, badge: 'Live' },
  { id: 'insights', label: 'Insights', icon: TrendingUp },
];

// Platform nav — sub-tabs consolidated from former /dashboard/{portfolio,risk,
// custody} sub-routes. Rendered in a secondary sidebar section so they stay
// visually separated from the daily-use tabs above.
const platformItems: NavItem[] = [
  { id: 'portfolio', label: 'Portfolio', icon: Layers },
  { id: 'risk', label: 'Risk', icon: Activity },
  { id: 'custody', label: 'Custody', icon: ShieldCheck },
];

type NavId = (typeof navItems)[number]['id'] | (typeof platformItems)[number]['id'];

export default function DashboardPage() {
  // EVM wallet state
  const { address: evmAddress, isConnected: evmConnected } = useAccount();
  const { data: balance } = useBalance({ address: evmAddress });

  // SUI wallet state
  const sui = useSui();
  const suiAddress = sui.address;
  const suiConnected = sui.isConnected;
  const suiBalance = sui.balance;

  // Combined wallet state - prefer SUI if connected, otherwise EVM
  const isConnected = suiConnected || evmConnected;
  const address = suiAddress || evmAddress?.toString();
  const displayBalance = suiConnected
    ? `${suiBalance} SUI`
    : balance
      ? `${parseFloat(balance.formatted).toFixed(4)} ${balance.symbol}`
      : '';

  const contractAddresses = useContractAddresses();
  // Get portfolio count and other data from centralized context - no redundant fetches!
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { derived } = usePositions();
  // Use centralized AI service for portfolio actions
  const { requestCustomAction } = usePortfolioAction();
  // Portfolio count available via derived?.portfolioCount if needed

  // Default to the Vault tab — clicking "Vault" in the top nav should land the
  // user on the actual deposit/withdraw surface, not a generic dashboard view.
  const [activeNav, setActiveNav] = useState<NavId>('community');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);
  const [agentMessage, setAgentMessage] = useState<string | null>(null);
  const [showChat, setShowChat] = useState(false);

  const displayAddress = address || '';
  // SUI-only mode: portfolio asset universe is fixed to SUI/USDC.
  const portfolioAssets = ['SUI', 'USDC'];

  // Debug notification state changes
  useEffect(() => {
    logger.debug('Notification state changed', { component: 'DashboardPage', data: notification });
  }, [notification]);

  // Close mobile menu on nav change
  const handleNavChange = (id: NavId) => {
    setActiveNav(id);
    setMobileMenuOpen(false);
  };

  const handleOpenHedge = async (market: PredictionMarket) => {
    logger.info('Hedge button clicked', { component: 'DashboardPage', data: market });
    logger.info('🛡️ Opening hedge on Moonlander', { data: market.question });

    // Show initial loading notification (no setTimeout yet)
    const loadingMsg = `🛡️ Processing hedge request...`;
    logger.debug('Setting notification', { component: 'DashboardPage', data: loadingMsg });
    setNotification(loadingMsg);

    try {
      // Determine primary asset to hedge
      const primaryAsset = market.relatedAssets[0] || 'BTC';

      // Calculate notional value based on probability (higher probability = larger hedge)
      const baseNotional = 1000; // $1000 base hedge
      const notionalValue = baseNotional * (market.probability / 100);

      logger.debug('Hedge parameters', {
        component: 'DashboardPage',
        data: {
          asset: primaryAsset,
          notionalValue,
          leverage: 5,
        },
      });

      const response = await fetch('/api/agents/hedging/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portfolioId: 1,
          asset: primaryAsset,
          side: 'SHORT',
          notionalValue: Math.round(notionalValue),
          leverage: 5,
          reason: market.question,
          // Enable auto-approval for prediction market triggered hedges
          autoApprovalEnabled: true,
          autoApprovalThreshold: 50000,
          walletAddress: address, // Associate hedge with connected wallet
        }),
      });

      logger.debug('API Response status', { component: 'DashboardPage', data: response.status });

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      logger.debug('API Response data', { component: 'DashboardPage', data });

      if (data.success) {
        const simulationBadge = data.simulationMode
          ? '\n\n⚠️ SIMULATION MODE'
          : '\n\n🔴 LIVE TRADING';
        const msg = `✅ Hedge Opened Successfully\n\nMarket: ${data.market}\nSide: ${data.side}\nSize: ${data.size}\nEntry: $${data.entryPrice || 'Pending'}\nLeverage: ${data.leverage}x${simulationBadge}`;
        logger.info('Setting success notification', { component: 'DashboardPage' });
        setNotification(msg);
        logger.info('✅ Moonlander hedge successful', data);

        // Auto-clear after 10 seconds
        setTimeout(() => {
          logger.debug('Clearing notification', { component: 'DashboardPage' });
          setNotification(null);
        }, 10000);
      } else {
        throw new Error(data.error || 'Hedge execution failed');
      }
    } catch (error) {
      logger.error('Hedge error', error instanceof Error ? error : undefined, {
        component: 'DashboardPage',
      });
      logger.error('❌ Moonlander hedge failed', undefined, {
        error: error instanceof Error ? error.message : String(error),
      });
      const errorMsg = error instanceof Error ? error.message : 'Unknown error occurred';
      setNotification(`❌ Hedge Failed\n\n${errorMsg}\n\nCheck browser console for details.`);

      // Auto-clear error after 10 seconds
      setTimeout(() => setNotification(null), 10000);
    }
  };

  const handleAgentAnalysis = async (market: PredictionMarket) => {
    logger.info('🤖 Triggering AI Agent Analysis', { market: market.question });

    // Show loading message
    setAgentMessage(
      '🤖 AI Agents Analyzing...\n\nRisk Agent, Hedging Agent, and Settlement Agent are evaluating your portfolio...'
    );

    try {
      // Use centralized AI service with caching
      const actionPayload: CustomActionPayload = {
        portfolioId: 1,
        currentValue: 50000,
        targetYield: 12,
        riskTolerance: 50,
        assets: market.relatedAssets,
        predictions: [
          {
            question: market.question,
            probability: market.probability,
            impact: market.impact,
            recommendation: market.recommendation || 'HOLD',
            source: market.source,
          },
        ],
        realMetrics: {
          riskScore: market.probability,
          volatility: 0.35,
          sharpeRatio: 1.2,
          hedgeSignals: market.recommendation === 'HEDGE' ? 1 : 0,
          totalValue: 50000,
        },
      };

      const data = await requestCustomAction(actionPayload, true);

      if (!data) {
        throw new Error('AI analysis returned no data');
      }

      // Format the AI response
      const agentName = 'AI Agent';
      const reasoning =
        typeof data.reasoning === 'string' ? data.reasoning.slice(0, 200) : 'Analysis complete';

      const msg = `🤖 ${agentName}\n\nAction: ${data.action}\nConfidence: ${Math.round(data.confidence * 100)}%\nUrgency: ${data.urgency}\n\n• ${reasoning}`;

      setAgentMessage(msg);
      logger.info('✅ AI Analysis Complete', { action: data.action, confidence: data.confidence });
    } catch (error) {
      logger.error('❌ AI Analysis Failed', { error });
      setAgentMessage('❌ AI Analysis Error\n\nPlease check console for details.');
    }

    // Auto-dismiss after 15 seconds
    setTimeout(() => setAgentMessage(null), 15000);
  };

  useEffect(() => {
    if (isConnected && contractAddresses) {
      logger.debug('Contract Addresses', { addresses: contractAddresses });
    }
  }, [isConnected, contractAddresses]);

  // Close mobile menu on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileMenuOpen(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, []);

  return (
    <div className="min-h-screen bg-[#f5f5f7]">
      {/* Mobile Header - Slim page-title bar. Primary navigation now lives in
          the bottom tab bar (see <MobileTabBar/> below). We keep only the
          current page title and the chat action here. Access to the drawer
          (secondary items: portfolio/risk/custody/settings) is via the 'More'
          tab in the bottom bar. */}
      <header className="lg:hidden fixed top-[52px] left-0 right-0 z-40 bg-white/95 backdrop-blur-xl border-b border-black/5">
        <div className="flex items-center justify-between px-4 h-12">
          {/* Uses <p role=heading aria-level=1> instead of a second <h1>.
              The desktop h1 below is display:none on mobile, and vice versa,
              but audit tools count both DOM nodes. Screen readers still
              announce this as a level-1 heading via ARIA. */}
          <p role="heading" aria-level={1} className="text-[17px] font-semibold text-[#1d1d1f] tracking-tight truncate m-0">
            {[...navItems, ...platformItems].find((n) => n.id === activeNav)?.label}
          </p>

          <button
            onClick={() => setShowChat(true)}
            className="p-2 -mr-2 text-[#007AFF] active:scale-[0.96] transition-transform"
            aria-label="Open chat"
          >
            <MessageSquare className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Mobile Sidebar — capped at 84vw so it can't bleed on 320px viewports */}
      <aside
        className={`
        lg:hidden fixed top-0 left-0 bottom-0 w-[min(84vw,300px)] z-50 bg-white pt-safe pb-safe
        transform transition-transform duration-300 ease-out shadow-2xl
        ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}
      `}
      >
        <div className="flex flex-col h-full">
          {/* Mobile Menu Header */}
          <div className="flex items-center justify-between p-4 border-b border-black/5">
            <span className="text-lg font-bold text-[#1d1d1f]">Menu</span>
            <button
              onClick={() => setMobileMenuOpen(false)}
              className="p-2 -mr-2 text-[#86868b] hover:text-[#1d1d1f]"
              aria-label="Close menu"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Wallet Info */}
          <div className="p-4 border-b border-black/5">
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center ${suiConnected ? 'bg-[#4DA2FF]' : 'bg-gradient-to-br from-blue-500 to-purple-600'}`}
              >
                <span className="text-white text-sm font-bold">
                  {suiConnected
                    ? 'SUI'
                    : displayAddress
                      ? displayAddress.slice(2, 4).toUpperCase()
                      : 'ZK'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[#1d1d1f] truncate">
                  {displayAddress
                    ? `${displayAddress.slice(0, 6)}...${displayAddress.slice(-4)}`
                    : 'Not Connected'}
                </p>
                <p className="text-xs text-[#86868b]">
                  {isConnected ? displayBalance : 'Connect Wallet'}
                </p>
              </div>
            </div>
          </div>

          {/* Mobile Nav */}
          <nav className="flex-1 py-2 overflow-y-auto">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeNav === item.id;

              return (
                <button
                  key={item.id}
                  onClick={() => handleNavChange(item.id)}
                  className={`
                    w-full flex items-center gap-3 px-4 py-3 text-left transition-colors
                    ${
                      isActive
                        ? 'bg-[#007AFF]/10 border-r-2 border-[#007AFF]'
                        : 'hover:bg-[#f5f5f7]'
                    }
                  `}
                >
                  <Icon className={`w-5 h-5 ${isActive ? 'text-[#007AFF]' : 'text-[#86868b]'}`} />
                  <span className={`font-medium ${isActive ? 'text-[#007AFF]' : 'text-[#1d1d1f]'}`}>
                    {item.label}
                  </span>
                  {item.badge && (
                    <span className="ml-auto px-2 py-0.5 text-xs font-semibold bg-[#34C759] text-white rounded-full">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Mobile Menu Footer */}
          <div className="p-4 border-t border-black/5">
            <button
              onClick={() => {
                setSettingsOpen(true);
                setMobileMenuOpen(false);
              }}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#f5f5f7] rounded-[18px] transition-colors"
            >
              <Settings className="w-5 h-5 text-[#86868b]" />
              <span className="font-medium text-[#1d1d1f]">Settings</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Desktop Layout */}
      <div className="flex pt-[52px]">
        {/* Desktop Sidebar - Hidden on mobile */}
        <aside className="hidden lg:flex w-64 h-[calc(100vh-52px)] sticky top-[52px] flex-col bg-white border-r border-black/5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
          {/* Wallet Section */}
          <div className="p-5 border-b border-black/5">
            <div className="flex items-center gap-3">
              <div
                className={`w-12 h-12 rounded-full flex items-center justify-center shadow-[0_4px_12px_rgba(0,122,255,0.3)] ${suiConnected ? 'bg-[#4DA2FF]' : 'bg-gradient-to-br from-[#007AFF] to-[#5856D6]'}`}
              >
                <span className="text-white text-[15px] font-semibold">
                  {suiConnected
                    ? 'SUI'
                    : displayAddress
                      ? displayAddress.slice(2, 4).toUpperCase()
                      : 'ZK'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[15px] font-semibold text-[#1d1d1f] truncate tracking-[-0.01em]">
                  {displayAddress
                    ? `${displayAddress.slice(0, 6)}...${displayAddress.slice(-4)}`
                    : 'Not Connected'}
                </p>
                <p className="text-[13px] text-[#86868b] tracking-[-0.003em]">
                  {isConnected ? displayBalance : 'Connect Wallet'}
                </p>
              </div>
            </div>
          </div>

          {/* Desktop Navigation */}
          <nav className="flex-1 py-4 overflow-y-auto">
            <p className="px-5 mb-3 text-[13px] font-semibold text-[#86868b] uppercase tracking-[0.06em]">
              Menu
            </p>

            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeNav === item.id;

              return (
                <button
                  key={item.id}
                  onClick={() => setActiveNav(item.id)}
                  className={`
                    w-[calc(100%-16px)] mx-2 mb-1 flex items-center gap-3 px-4 py-2.5 rounded-[12px] text-left transition-all duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]
                    ${
                      isActive
                        ? 'bg-[#007AFF] shadow-[0_2px_8px_rgba(0,122,255,0.25)]'
                        : 'hover:bg-[#f5f5f7]'
                    }
                  `}
                >
                  <Icon className={`w-5 h-5 ${isActive ? 'text-white' : 'text-[#86868b]'}`} />
                  <span
                    className={`text-[15px] font-medium tracking-[-0.01em] ${isActive ? 'text-white' : 'text-[#1d1d1f]'}`}
                  >
                    {item.label}
                  </span>
                  {item.badge && (
                    <span
                      className={`
                      ml-auto px-2 py-0.5 text-[11px] font-semibold rounded-full shadow-sm
                      ${isActive ? 'bg-white/20 text-white' : 'bg-[#34C759] text-white'}
                    `}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}

            <div className="my-4 mx-4 border-t border-black/5" />

            <p className="px-5 mb-3 text-[13px] font-semibold text-[#86868b] uppercase tracking-[0.06em]">
              Platform
            </p>

            {platformItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeNav === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveNav(item.id)}
                  className={`
                    w-[calc(100%-16px)] mx-2 mb-1 flex items-center gap-3 px-4 py-2.5 rounded-[12px] text-left transition-all duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]
                    ${isActive ? 'bg-[#007AFF] shadow-[0_2px_8px_rgba(0,122,255,0.25)]' : 'hover:bg-[#f5f5f7]'}
                  `}
                >
                  <Icon className={`w-5 h-5 ${isActive ? 'text-white' : 'text-[#86868b]'}`} />
                  <span className={`text-[15px] font-medium tracking-[-0.01em] ${isActive ? 'text-white' : 'text-[#1d1d1f]'}`}>
                    {item.label}
                  </span>
                </button>
              );
            })}

            <div className="my-4 mx-4 border-t border-black/5" />

            <button
              onClick={() => setSettingsOpen(true)}
              className="w-[calc(100%-16px)] mx-2 flex items-center gap-3 px-4 py-2.5 rounded-[12px] text-left hover:bg-[#f5f5f7] transition-colors duration-200"
            >
              <Settings className="w-5 h-5 text-[#86868b]" strokeWidth={2} />
              <span className="text-[15px] font-medium text-[#1d1d1f] tracking-[-0.01em]">
                Settings
              </span>
            </button>
          </nav>

          {/* AI Assistant Button */}
          <div className="p-4 border-t border-black/5">
            <button
              onClick={() => setShowChat(true)}
              className="w-full flex items-center justify-center gap-2.5 px-4 py-3 bg-[#007AFF] text-white rounded-[14px] text-[15px] font-semibold hover:opacity-90 active:scale-[0.98] transition-all duration-200 shadow-[0_4px_12px_rgba(0,122,255,0.3)]"
            >
              <MessageSquare className="w-5 h-5" strokeWidth={2.5} />
              AI Assistant
            </button>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 min-h-[calc(100vh-52px)] pt-12 lg:pt-0 pb-[calc(52px+env(safe-area-inset-bottom))] lg:pb-0">
          <div className="max-w-[1280px] mx-auto px-3 sm:px-5 py-3 sm:py-6 lg:px-8 lg:py-10">
            {/* Page Header - Desktop only */}
            <div className="hidden lg:block mb-8">
              <h1 className="text-[34px] font-bold text-[#1d1d1f] tracking-[-0.02em] leading-[1.1]">
                {[...navItems, ...platformItems].find((n) => n.id === activeNav)?.label}
              </h1>
            </div>

            {/* Content Area. Keyed on activeNav so React tears down + remounts
                the tab's subtree, giving each tab-switch a natural fade-in
                (paired with the animate-fade-in class). Feels closer to
                UINavigationController on iOS than a raw conditional swap. */}
            <Suspense fallback={<LoadingSkeleton height="h-96" />}>
              <div key={activeNav} className="animate-fade-in">
                {renderContent()}
              </div>
            </Suspense>
          </div>
        </main>
      </div>

      {/* iOS-style bottom tab bar — primary nav on mobile. 4 tabs + More.
          The "More" button opens the drawer where the wallet controls,
          portfolio/risk/custody sub-pages, and settings live. Reduces the
          old 4-tap "menu → drawer → tab → close" flow to 1 tap. */}
      <MobileTabBar
        items={navItems.slice(0, 4)}
        activeId={activeNav}
        onSelect={(id) => handleNavChange(id as NavId)}
        onOpenMore={() => setMobileMenuOpen(true)}
        moreLabel="More"
        moreIcon={MoreHorizontal}
      />

      {/* Notification Toast */}
      {notification && (
        <div className="fixed top-20 lg:top-[68px] left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-2 duration-300 max-w-md">
          <div className="flex items-start gap-3 px-5 py-4 bg-gray-900 text-white rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
            <div className="w-2 h-2 mt-1.5 bg-green-400 rounded-full animate-pulse flex-shrink-0" />
            <p className="text-sm font-medium whitespace-pre-line leading-relaxed">
              {notification}
            </p>
          </div>
        </div>
      )}

      {/* Create Portfolio CTA disabled in SUI-only mode (EVM/Cronos required). */}

      {/* Chat Panel */}
      {showChat && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm lg:bg-transparent lg:backdrop-blur-none lg:pointer-events-none"
            onClick={() => setShowChat(false)}
          />
          <div className="fixed bottom-[calc(52px+env(safe-area-inset-bottom))] lg:bottom-6 left-0 right-0 lg:right-6 lg:left-auto z-50 lg:w-[440px] lg:pointer-events-auto">
            <div className="bg-white lg:rounded-[24px] shadow-2xl border-t lg:border border-black/5 overflow-hidden">
              <div className="flex items-center justify-between p-3 sm:p-4 border-b border-black/5">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-gradient-to-br from-[#007AFF] to-[#5856D6] rounded-[12px] flex items-center justify-center shadow-[0_2px_8px_rgba(0,122,255,0.25)]">
                    <Bot className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <span className="font-semibold text-[15px] text-[#1d1d1f] block">
                      AI Assistant
                    </span>
                    <span className="text-[11px] text-[#86868b]">Your portfolio co-pilot</span>
                  </div>
                </div>
                <button
                  onClick={() => setShowChat(false)}
                  className="p-2 text-[#86868b] hover:text-[#1d1d1f] hover:bg-[#f5f5f7] rounded-full transition-all"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="h-[70vh] lg:h-[520px]">
                <EnhancedChat
                  address={displayAddress}
                  hideHeader={true}
                  onActionTrigger={(action, params) => {
                    switch (action) {
                      case 'analyze':
                        setActiveNav('insights');
                        setShowChat(false);
                        break;
                      case 'status':
                        setActiveNav('positions');
                        setShowChat(false);
                        break;
                      default:
                        // hedge/swap actions dropped: SUI-only mode hedges
                        // via the auto-hedge cron, not manual modals.
                        logger.info('Chat action triggered', {
                          component: 'DashboardPage',
                          data: { action, params },
                        });
                    }
                  }}
                />
              </div>
            </div>
          </div>
        </>
      )}

      {/* Chat FAB - Hidden when chat is open */}
      {!showChat && (
        <button
          onClick={() => setShowChat(true)}
          className="fixed bottom-6 right-6 z-50 w-14 h-14 bg-[#007AFF] text-white rounded-full shadow-[0_8px_30px_rgba(0,122,255,0.3)] hover:opacity-90 hover:scale-105 transition-all flex items-center justify-center"
        >
          <MessageSquare className="w-6 h-6" />
        </button>
      )}

      {/* Swap Modal and Manual Hedge Modal are Cronos/EVM-bound and disabled
          in SUI-only mode. Hedging is driven by the SUI Community Pool +
          Bluefin auto-hedge cron instead. */}

      {/* Settings Modal */}
      {settingsOpen && (
        <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );

  // Content renderer
  function renderContent() {
    switch (activeNav) {
      case 'overview':
        return (
          <div className="space-y-3 sm:space-y-6">
            {/* Portfolio Card */}
            <Card>
              <PortfolioOverview
                address={displayAddress}
                onNavigateToPositions={() => setActiveNav('positions')}
                onNavigateToHedges={() => setActiveNav('hedges')}
              />
            </Card>

            {/* Real-time 5-Min BTC Signal */}
            <FiveMinSignalWidget />

            {/* Stats Grid - Stack on mobile, 2 cols on tablet+ */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-6 items-stretch">
              <Card className="flex flex-col">
                <CardHeader title="Risk Metrics" />
                <div className="flex-1">
                  <RiskMetrics address={displayAddress} />
                </div>
              </Card>

              <Card className="flex flex-col">
                <CardHeader
                  title="Active Hedges"
                  action={
                    <button
                      onClick={() => setActiveNav('hedges')}
                      className="flex items-center gap-1 text-sm text-[#007AFF] font-medium hover:opacity-80 transition-opacity"
                    >
                      View All <ChevronRight className="w-4 h-4" />
                    </button>
                  }
                />
                <div className="flex-1">
                  <ActiveHedges
                    address={displayAddress}
                    compact
                    onOpenChat={() => setShowChat(true)}
                  />
                </div>
              </Card>
            </div>

            {/* Agent Alert */}
            {agentMessage && (
              <div className="p-4 sm:p-6 bg-[#007AFF]/5 border border-[#007AFF]/20 rounded-[24px]">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 sm:w-12 sm:h-12 bg-[#007AFF] rounded-[18px] flex items-center justify-center flex-shrink-0">
                    <Bot className="w-5 h-5 sm:w-6 sm:h-6 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-[#1d1d1f] mb-1">AI Agent Alert</h3>
                    <p className="text-[#86868b] text-sm sm:text-base whitespace-pre-line">
                      {agentMessage}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        );

      case 'positions':
        return (
          <Card>
            <CardHeader title="Positions" subtitle="Manage your portfolio holdings" />
            <PositionsList address={displayAddress} onOpenHedge={handleOpenHedge} />
          </Card>
        );

      case 'hedges':
        return (
          <div className="space-y-3 sm:space-y-6">
            <Card>
              <CardHeader title="Active Hedges" subtitle="Your protective positions and options" />
              <ActiveHedges
                address={displayAddress}
                onOpenChat={() => setShowChat(true)}
              />
            </Card>
            <TestnetUSDCFaucet />
          </div>
        );

      case 'agents':
        return (
          <div className="space-y-3 sm:space-y-6">
            <Card>
              <CardHeader
                title="AI Agents"
                subtitle="Autonomous trading and risk management"
                badge={<Badge color="green">ACTIVE</Badge>}
              />
              <AgentActivity address={displayAddress} />
            </Card>

            {agentMessage && (
              <div className="p-4 sm:p-6 bg-gradient-to-br from-[#007AFF]/5 to-[#AF52DE]/5 border border-[#007AFF]/20 rounded-[24px]">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 bg-[#007AFF] rounded-[18px] flex items-center justify-center">
                    <Bot className="w-6 h-6 text-white" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-[#1d1d1f] mb-1">Latest Analysis</h3>
                    <p className="text-[#86868b] whitespace-pre-line">{agentMessage}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        );

      case 'insights':
        return (
          <PredictionInsights
            onOpenHedge={handleOpenHedge}
            onTriggerAgentAnalysis={handleAgentAnalysis}
            assets={portfolioAssets}
          />
        );

      case 'community':
        return (
          <Card>
            <CardHeader
              title="Community Pool"
              subtitle="AI-managed collective investment fund"
              badge={<Badge color="blue">AI DRIVEN</Badge>}
            />
            <CommunityPool address={displayAddress} />
          </Card>
        );

      // Platform tabs — extracted from former /dashboard/{portfolio,risk,custody}
      // sub-routes. Self-contained (own header + spacing), so no Card wrapper.
      case 'portfolio':
        return <PortfolioTab />;

      case 'risk':
        return <RiskTab />;

      case 'custody':
        return <CustodyTab />;

      default:
        return null;
    }
  }
}

// Reusable Card component
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`bg-white rounded-[20px] sm:rounded-[24px] shadow-sm border border-black/5 overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}

// Card Header component
function CardHeader({
  title,
  subtitle,
  action,
  badge,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <div className="px-3 sm:px-6 py-2.5 sm:py-4 border-b border-black/5">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[17px] sm:text-[20px] font-semibold text-[#1d1d1f] tracking-[-0.01em]">
              {title}
            </h2>
            {badge}
          </div>
          {subtitle && (
            <p className="text-[12px] sm:text-[13px] text-[#86868b] mt-0.5">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
    </div>
  );
}

// Badge component
function Badge({ children, color }: { children: React.ReactNode; color: 'green' | 'blue' }) {
  const colors = {
    green: 'bg-[#34C759] text-white',
    blue: 'bg-[#007AFF] text-white',
  };

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full ${colors[color]}`}
    >
      {color === 'green' && <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />}
      {children}
    </span>
  );
}
