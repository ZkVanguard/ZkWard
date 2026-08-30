'use client';

import { useState } from 'react';
import { logger } from '@/lib/utils/logger';
import { useApiAuth } from '@/lib/hooks/useApiAuth';
import { X, TrendingUp, PieChart, History, Brain, Settings, ArrowUpRight, ArrowDownRight, RefreshCw } from 'lucide-react';
import PerformanceChart from './PerformanceChart';

interface Asset {
  symbol: string;
  address: string;
  allocation: number;
  value: number;
  change24h: number;
  price?: number;
  chain?: string;
}

interface Transaction {
  type: 'deposit' | 'withdraw' | 'rebalance';
  timestamp: number;
  amount?: number;
  token?: string;
  changes?: { from: number; to: number; asset: string }[];
  txHash: string;
}

interface Portfolio {
  id: number;
  name: string;
  totalValue: number;
  status: 'FUNDED' | 'EMPTY' | 'NEW';
  targetAPY: number;
  riskLevel: 'Low' | 'Medium' | 'High';
  currentYield: number;
  assets: Asset[];
  lastRebalanced: number;
  transactions: Transaction[];
  aiAnalysis: {
    summary: string;
    recommendations: string[];
    riskAssessment: string;
  };
}

interface PortfolioDetailModalProps {
  portfolio: Portfolio;
  onClose: () => void;
  walletAddress?: string;
}

export default function PortfolioDetailModal({ portfolio, onClose, walletAddress }: PortfolioDetailModalProps) {
  const { getAuthHeaders } = useApiAuth(walletAddress);
  const [activeTab, setActiveTab] = useState<'overview' | 'transactions' | 'analysis' | 'settings'>('overview');
  const [riskLevel, setRiskLevel] = useState<'Low' | 'Medium' | 'High'>(portfolio.riskLevel);
  const [targetAPY, setTargetAPY] = useState(portfolio.targetAPY);
  const [autoRebalance, setAutoRebalance] = useState(true);
  const [rebalanceThreshold, setRebalanceThreshold] = useState(5);
  const [saving, setSaving] = useState(false);

  const tabs = [
    { id: 'overview', label: 'Overview', icon: PieChart },
    { id: 'transactions', label: 'History', icon: History },
    { id: 'analysis', label: 'AI Analysis', icon: Brain },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatCurrency = (value: number) => {
    return `$${value.toFixed(2)}`;
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-ios-blue px-6 py-5 text-white flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">{portfolio.name}</h2>
            <p className="text-white/80 text-sm mt-1">
              {formatCurrency(portfolio.totalValue)} • {portfolio.status}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/20 rounded-lg transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 px-6 flex gap-1">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as typeof activeTab)}
                className={`flex items-center gap-2 px-4 py-3 font-medium transition-all relative ${
                  activeTab === tab.id
                    ? 'text-ios-blue'
                    : 'text-label-secondary hover:text-label-primary'
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
                {activeTab === tab.id && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-ios-blue" />
                )}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Key Metrics — 2-col on mobile, 4-col on tablet+ */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 min-w-0">
                <div className="bg-system-bg-secondary rounded-xl p-3 sm:p-4 min-w-0">
                  <p className="text-label-secondary text-xs sm:text-sm mb-1 truncate">Total Value</p>
                  <p className="text-lg sm:text-2xl font-bold text-label-primary tabular-nums break-all">{formatCurrency(portfolio.totalValue)}</p>
                </div>
                <div className="bg-system-bg-secondary rounded-xl p-3 sm:p-4 min-w-0">
                  <p className="text-label-secondary text-xs sm:text-sm mb-1 truncate">Current Yield</p>
                  <p className="text-lg sm:text-2xl font-bold text-ios-green tabular-nums break-all">{portfolio.currentYield}%</p>
                </div>
                <div className="bg-system-bg-secondary rounded-xl p-3 sm:p-4 min-w-0">
                  <p className="text-label-secondary text-xs sm:text-sm mb-1 truncate">Target APY</p>
                  <p className="text-lg sm:text-2xl font-bold text-label-primary tabular-nums break-all">{portfolio.targetAPY}%</p>
                </div>
                <div className="bg-system-bg-secondary rounded-xl p-3 sm:p-4 min-w-0">
                  <p className="text-label-secondary text-xs sm:text-sm mb-1 truncate">Risk Level</p>
                  <p className={`text-lg sm:text-2xl font-bold break-words ${
                    portfolio.riskLevel === 'High' ? 'text-ios-red' :
                    portfolio.riskLevel === 'Medium' ? 'text-ios-orange' :
                    'text-ios-green'
                  }`}>{portfolio.riskLevel}</p>
                </div>
              </div>

              {/* Asset Allocation */}
              <div>
                <h3 className="text-lg font-semibold text-label-primary mb-4 flex items-center gap-2">
                  <PieChart className="w-5 h-5 text-ios-blue" />
                  Asset Allocation
                </h3>
                <div className="space-y-3">
                  {portfolio.assets.map((asset, idx) => (
                    <div key={idx} className="bg-system-bg-secondary rounded-xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <div className={`w-3 h-3 rounded-full ${
                            idx === 0 ? 'bg-ios-blue' :
                            idx === 1 ? 'bg-ios-green' :
                            idx === 2 ? 'bg-ios-orange' :
                            'bg-ios-red'
                          }`} />
                          <span className="font-semibold text-label-primary">{asset.symbol}</span>
                        </div>
                        <span className="text-label-secondary text-sm">{asset.allocation}%</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-label-primary font-medium">{formatCurrency(asset.value)}</span>
                        <span className={`text-sm flex items-center gap-1 ${
                          asset.change24h >= 0 ? 'text-ios-green' : 'text-ios-red'
                        }`}>
                          {asset.change24h >= 0 ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
                          {Math.abs(asset.change24h).toFixed(2)}%
                        </span>
                      </div>
                      {/* Allocation Bar */}
                      <div className="mt-3 bg-white rounded-full h-2 overflow-hidden">
                        <div 
                          className={`h-full ${
                            idx === 0 ? 'bg-ios-blue' :
                            idx === 1 ? 'bg-ios-green' :
                            idx === 2 ? 'bg-ios-orange' :
                            'bg-ios-red'
                          }`}
                          style={{ width: `${asset.allocation}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Performance Chart */}
              <div>
                <h3 className="text-lg font-semibold text-label-primary mb-4 flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-ios-blue" />
                  Performance
                </h3>
                {walletAddress ? (
                  <PerformanceChart 
                    walletAddress={walletAddress} 
                    currentValue={portfolio.totalValue}
                    assets={portfolio.assets.map(a => ({
                      symbol: a.symbol,
                      value: a.value,
                      change24h: a.change24h,
                    }))}
                  />
                ) : (
                  <div className="bg-system-bg-secondary rounded-xl p-8 text-center">
                    <TrendingUp className="w-12 h-12 text-label-secondary mx-auto mb-3" />
                    <p className="text-label-secondary">Connect wallet to view performance</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'transactions' && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-label-primary mb-4 flex items-center gap-2">
                <History className="w-5 h-5 text-ios-blue" />
                Transaction History
              </h3>
              {portfolio.transactions.length === 0 ? (
                <div className="bg-system-bg-secondary rounded-xl p-8 text-center">
                  <History className="w-12 h-12 text-label-secondary mx-auto mb-3" />
                  <p className="text-label-secondary">No transactions yet</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {portfolio.transactions.map((tx, idx) => (
                    <div key={idx} className="bg-system-bg-secondary rounded-xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                            tx.type === 'deposit' ? 'bg-ios-green/20' :
                            tx.type === 'withdraw' ? 'bg-ios-red/20' :
                            'bg-ios-blue/20'
                          }`}>
                            {tx.type === 'deposit' && <ArrowUpRight className="w-5 h-5 text-ios-green" />}
                            {tx.type === 'withdraw' && <ArrowDownRight className="w-5 h-5 text-ios-red" />}
                            {tx.type === 'rebalance' && <RefreshCw className="w-5 h-5 text-ios-blue" />}
                          </div>
                          <div>
                            <p className="font-semibold text-label-primary capitalize">{tx.type}</p>
                            <p className="text-sm text-label-secondary">{formatDate(tx.timestamp)}</p>
                          </div>
                        </div>
                        {tx.amount && (
                          <div className="text-right">
                            <p className="font-semibold text-label-primary">{formatCurrency(tx.amount)}</p>
                            {tx.token && <p className="text-sm text-label-secondary">{tx.token}</p>}
                          </div>
                        )}
                      </div>
                      {tx.changes && (
                        <div className="mt-3 pl-13 space-y-1">
                          {tx.changes.map((change, cidx) => (
                            <p key={cidx} className="text-sm text-label-secondary">
                              {change.asset}: {change.from}% → {change.to}%
                            </p>
                          ))}
                        </div>
                      )}
                      <a 
                        href={`https://explorer.cronos.org/testnet/tx/${tx.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-ios-blue hover:underline mt-2 inline-block"
                      >
                        View on Explorer →
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'analysis' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-label-primary mb-4 flex items-center gap-2">
                  <Brain className="w-5 h-5 text-ios-blue" />
                  AI Analysis
                </h3>
                <div className="bg-system-bg-secondary rounded-xl p-5">
                  <p className="text-label-primary leading-relaxed">{portfolio.aiAnalysis.summary}</p>
                </div>
              </div>

              <div>
                <h4 className="font-semibold text-label-primary mb-3">Recommendations</h4>
                <div className="space-y-2">
                  {portfolio.aiAnalysis.recommendations.map((rec, idx) => (
                    <div key={idx} className="bg-system-bg-secondary rounded-lg p-4 flex gap-3">
                      <div className="w-6 h-6 rounded-full bg-ios-blue text-white flex items-center justify-center text-sm font-semibold flex-shrink-0">
                        {idx + 1}
                      </div>
                      <p className="text-label-primary">{rec}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h4 className="font-semibold text-label-primary mb-3">Risk Assessment</h4>
                <div className="bg-system-bg-secondary rounded-xl p-5">
                  <p className="text-label-primary leading-relaxed">{portfolio.aiAnalysis.riskAssessment}</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-6">
              <h3 className="text-lg font-semibold text-label-primary mb-4 flex items-center gap-2">
                <Settings className="w-5 h-5 text-ios-blue" />
                Portfolio Settings
              </h3>

              {/* Risk Level */}
              <div className="bg-system-bg-secondary rounded-xl p-6">
                <label className="block text-sm font-medium text-label-primary mb-3">Risk Level</label>
                <div className="flex gap-3">
                  {(['Low', 'Medium', 'High'] as const).map((level) => (
                    <button
                      key={level}
                      onClick={() => setRiskLevel(level)}
                      className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                        riskLevel === level
                          ? 'bg-ios-blue text-white'
                          : 'bg-white text-label-secondary hover:bg-gray-50'
                      }`}
                    >
                      {level}
                    </button>
                  ))}
                </div>
                <p className="text-sm text-label-secondary mt-3">
                  {riskLevel === 'Low' && 'Conservative approach with stable assets'}
                  {riskLevel === 'Medium' && 'Balanced mix of stable and growth assets'}
                  {riskLevel === 'High' && 'Aggressive strategy for maximum returns'}
                </p>
              </div>

              {/* Target APY */}
              <div className="bg-system-bg-secondary rounded-xl p-6">
                <label className="block text-sm font-medium text-label-primary mb-3">
                  Target APY: {targetAPY}%
                </label>
                <input
                  type="range"
                  min="1"
                  max="50"
                  value={targetAPY}
                  onChange={(e) => setTargetAPY(Number(e.target.value))}
                  className="w-full h-2 bg-gray-300 rounded-lg appearance-none cursor-pointer accent-ios-blue"
                />
                <div className="flex justify-between text-sm text-label-secondary mt-2">
                  <span>1%</span>
                  <span>50%</span>
                </div>
              </div>

              {/* Auto-Rebalance */}
              <div className="bg-system-bg-secondary rounded-xl p-6">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <label className="block text-sm font-medium text-label-primary">Auto-Rebalance</label>
                    <p className="text-sm text-label-secondary mt-1">Automatically maintain target allocations</p>
                  </div>
                  <button
                    onClick={() => setAutoRebalance(!autoRebalance)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      autoRebalance ? 'bg-ios-green' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        autoRebalance ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {autoRebalance && (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <label className="block text-sm font-medium text-label-primary mb-3">
                      Rebalance Threshold: {rebalanceThreshold}%
                    </label>
                    <input
                      type="range"
                      min="1"
                      max="20"
                      value={rebalanceThreshold}
                      onChange={(e) => setRebalanceThreshold(Number(e.target.value))}
                      className="w-full h-2 bg-gray-300 rounded-lg appearance-none cursor-pointer accent-ios-blue"
                    />
                    <p className="text-sm text-label-secondary mt-2">
                      Rebalance when allocation drifts by {rebalanceThreshold}%
                    </p>
                  </div>
                )}
              </div>

              {/* Save Button */}
              <div className="flex gap-3">
                <button
                  onClick={async () => {
                    if (!walletAddress) {
                      alert('Please connect your wallet first');
                      return;
                    }

                    setSaving(true);
                    try {
                      // Enable/disable auto-rebalancing based on toggle
                      const action = autoRebalance ? 'enable' : 'disable';
                      const authHeaders = await getAuthHeaders();
                      const response = await fetch(`/api/agents/auto-rebalance?action=${action}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders },
                        body: JSON.stringify({
                          portfolioId: portfolio.id,
                          walletAddress,
                          config: {
                            threshold: rebalanceThreshold,
                            frequency: 'DAILY',
                            autoApprovalEnabled: true,
                            autoApprovalThreshold: 50000, // $50K default
                          },
                        }),
                      });

                      const result = await response.json();

                      if (result.success) {
                        alert(`Settings saved! Auto-rebalancing ${autoRebalance ? 'enabled' : 'disabled'} for this portfolio.`);
                      } else {
                        throw new Error(result.error || 'Failed to save settings');
                      }
                    } catch (error) {
                      logger.error('Failed to save settings', error instanceof Error ? error : undefined);
                      alert(`Error: ${error instanceof Error ? error.message : 'Failed to save settings'}`);
                    } finally {
                      setSaving(false);
                    }
                  }}
                  disabled={saving}
                  className="flex-1 bg-ios-blue text-white py-3 px-6 rounded-xl font-medium hover:bg-ios-blueHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  onClick={() => {
                    setRiskLevel(portfolio.riskLevel);
                    setTargetAPY(portfolio.targetAPY);
                    setAutoRebalance(true);
                    setRebalanceThreshold(5);
                  }}
                  className="px-6 py-3 bg-white text-label-secondary rounded-xl font-medium hover:bg-gray-50 transition-colors"
                >
                  Reset
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
