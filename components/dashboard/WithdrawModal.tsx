'use client';

import { useState, useEffect } from 'react';
import { logger } from '@/lib/utils/logger';
import { X, Loader2, CheckCircle, AlertCircle, ArrowDownToLine, ExternalLink } from 'lucide-react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, usePublicClient, useChainId } from '@/lib/evm-wallet/hooks';
import { parseUnits, formatUnits } from 'viem';
import { getContractAddresses } from '../../lib/contracts/addresses';
import { RWA_MANAGER_ABI } from '../../lib/contracts/abis';
import { trackSuccessfulTransaction } from '@/lib/utils/transactionTracker';
import { EXPLORER_URLS } from '@/lib/hooks/useNetwork';

// Token info map
const TOKEN_INFO: Record<string, { symbol: string; decimals: number }> = {
  '0xc01efaaf7c5c61bebfaeb358e1161b537b8bc0e0': { symbol: 'devUSDC', decimals: 6 },
  '0x6a3173618859c7cd40faf6921b5e9eb6a76f1fd4': { symbol: 'WCRO', decimals: 18 },
};

interface WithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
  portfolioId: number;
  assets: string[];
  totalValue: number;
  onSuccess?: () => void;
}

export function WithdrawModal({ 
  isOpen, 
  onClose, 
  portfolioId, 
  assets,
  totalValue,
  onSuccess 
}: WithdrawModalProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const explorerUrl = EXPLORER_URLS[chainId] || EXPLORER_URLS[338];
  const [selectedAsset, setSelectedAsset] = useState<string>(assets[0] || '');
  const [amount, setAmount] = useState('');
  const [assetBalance, setAssetBalance] = useState<string>('0');
  const [step, setStep] = useState<'input' | 'withdraw' | 'success' | 'error'>('input');
  const [errorMessage, setErrorMessage] = useState('');

  const addresses = getContractAddresses(chainId);
  const rwaManagerAddress = addresses.rwaManager as `0x${string}`;

  // Get token info
  const tokenInfo = TOKEN_INFO[selectedAsset.toLowerCase()] || { symbol: 'Unknown', decimals: 18 };

  // Withdraw transaction
  const { 
    writeContract: writeWithdraw, 
    data: withdrawHash,
    isPending: _isWithdrawPending,
    error: withdrawError 
  } = useWriteContract();

  // Wait for withdraw confirmation
  const { isLoading: isWithdrawConfirming, isSuccess: isWithdrawSuccess } = 
    useWaitForTransactionReceipt({ hash: withdrawHash });

  // Fetch asset allocation in portfolio
  useEffect(() => {
    async function fetchAssetBalance() {
      if (!publicClient || !selectedAsset) return;

      try {
        const balance = await publicClient.readContract({
          address: rwaManagerAddress,
          abi: RWA_MANAGER_ABI,
          functionName: 'getAssetAllocation',
          args: [BigInt(portfolioId), selectedAsset as `0x${string}`],
        });
        setAssetBalance(formatUnits(balance as bigint, tokenInfo.decimals));
      } catch (error) {
        logger.error('Failed to fetch asset balance', error instanceof Error ? error : undefined);
        // Fallback: estimate from totalValue (assuming single asset)
        if (assets.length === 1) {
          setAssetBalance(formatUnits(BigInt(Math.floor(totalValue * (10 ** tokenInfo.decimals))), tokenInfo.decimals));
        } else {
          setAssetBalance('0');
        }
      }
    }

    if (isOpen && selectedAsset) {
      fetchAssetBalance();
    }
  }, [publicClient, selectedAsset, isOpen, portfolioId, rwaManagerAddress, tokenInfo.decimals, assets.length, totalValue]);

  // Handle withdraw success
  useEffect(() => {
    if (isWithdrawSuccess && withdrawHash && address) {
      // Track the successful withdraw transaction
      trackSuccessfulTransaction({
        hash: withdrawHash,
        type: 'withdraw',
        from: rwaManagerAddress,
        to: address,
        value: amount,
        tokenSymbol: tokenInfo.symbol,
        description: `Withdraw ${amount} ${tokenInfo.symbol} from Portfolio #${portfolioId}`,
      });
      
      setStep('success');
      onSuccess?.();
    }
  }, [isWithdrawSuccess, withdrawHash, address, amount, tokenInfo.symbol, portfolioId, rwaManagerAddress]);

  // Handle errors
  useEffect(() => {
    if (withdrawError) {
      setErrorMessage(withdrawError.message || 'Withdrawal failed');
      setStep('error');
    }
  }, [withdrawError]);

  const handleWithdraw = () => {
    if (!amount || parseFloat(amount) <= 0) return;
    
    const amountInWei = parseUnits(amount, tokenInfo.decimals);
    setStep('withdraw');

    writeWithdraw({
      address: rwaManagerAddress,
      abi: RWA_MANAGER_ABI,
      functionName: 'withdrawAsset',
      args: [BigInt(portfolioId), selectedAsset as `0x${string}`, amountInWei],
    });
  };

  const handleWithdrawAll = () => {
    setAmount(assetBalance);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl border border-[#e8e8ed] w-full max-w-md shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-[#e8e8ed]">
          <div>
            <h2 className="text-xl font-bold text-[#1d1d1f]">Withdraw from Portfolio #{portfolioId}</h2>
            <p className="text-sm text-[#86868b] mt-1">
              Current balance: ${totalValue.toFixed(2)}
            </p>
          </div>
          <button 
            onClick={onClose}
            className="p-2 hover:bg-[#F5F5F7] rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-[#86868b]" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {step === 'input' && (
            <>
              {/* Asset Selection */}
              {assets.length > 1 && (
                <div className="mb-4">
                  <label className="block text-sm font-medium text-[#1d1d1f] mb-2">
                    Select Asset to Withdraw
                  </label>
                  <div className="flex gap-2">
                    {assets.map((asset) => {
                      const info = TOKEN_INFO[asset.toLowerCase()] || { symbol: 'Unknown', decimals: 18 };
                      return (
                        <button
                          key={asset}
                          onClick={() => setSelectedAsset(asset)}
                          className={`px-4 py-2 rounded-xl border transition-all ${
                            selectedAsset === asset
                              ? 'border-[#007AFF] bg-[#007AFF]/10'
                              : 'border-[#e8e8ed] hover:border-[#86868b] bg-[#f5f5f7]'
                          }`}
                        >
                          <span className="text-[#1d1d1f] font-medium">{info.symbol}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Current Asset */}
              <div className="mb-4 p-4 bg-[#f5f5f7] rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm text-[#86868b]">Withdrawing</div>
                    <div className="text-lg font-bold">{tokenInfo.symbol}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm text-[#86868b]">Available</div>
                    <div className="text-lg font-bold text-[#34C759]">
                      {parseFloat(assetBalance).toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    </div>
                  </div>
                </div>
              </div>

              {/* Amount Input */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-[#1d1d1f] mb-2">
                  Amount to Withdraw
                </label>
                <div className="relative">
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-[#f5f5f7] border border-[#e8e8ed] rounded-xl px-4 py-3 text-lg text-[#1d1d1f] placeholder-[#86868b] focus:outline-none focus:border-[#007AFF] transition-colors"
                  />
                  <button
                    onClick={handleWithdrawAll}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#007AFF] hover:text-[#0066CC]"
                  >
                    MAX
                  </button>
                </div>
              </div>

              {/* Info Box */}
              <div className="bg-[#f5f5f7] rounded-lg p-4 mb-6">
                <div className="flex items-start gap-3">
                  <ArrowDownToLine className="w-5 h-5 text-[#007AFF] mt-0.5" />
                  <div className="text-sm">
                    <p className="text-[#1d1d1f] mb-1">
                      Withdraw to your wallet
                    </p>
                    <p className="text-[#86868b] text-xs">
                      Tokens will be transferred from the portfolio contract back to your wallet.
                    </p>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-3">
                <button
                  onClick={onClose}
                  className="flex-1 py-3 bg-[#F5F5F7] border border-[#E5E5EA] hover:bg-[#E5E5EA] text-[#1D1D1F] rounded-lg font-semibold transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleWithdraw}
                  disabled={!amount || parseFloat(amount) <= 0 || parseFloat(amount) > parseFloat(assetBalance)}
                  className="flex-1 py-3 bg-[#FF3B30] hover:bg-[#E6352B] disabled:bg-[#E5E5EA] disabled:text-[#86868B] disabled:cursor-not-allowed text-white rounded-xl font-semibold transition-all"
                >
                  Withdraw {tokenInfo.symbol}
                </button>
              </div>
            </>
          )}

          {step === 'withdraw' && (
            <div className="text-center py-8">
              <Loader2 className="w-16 h-16 text-[#007AFF] animate-spin mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">Processing Withdrawal...</h3>
              <p className="text-[#86868b] mb-4">
                Please confirm the transaction in your wallet
              </p>
              {isWithdrawConfirming && (
                <p className="text-sm text-[#007AFF]">
                  Waiting for confirmation...
                </p>
              )}
            </div>
          )}

          {step === 'success' && (
            <div className="text-center py-8">
              <CheckCircle className="w-16 h-16 text-[#34C759] mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">Withdrawal Successful!</h3>
              <p className="text-[#86868b] mb-4">
                {amount} {tokenInfo.symbol} has been withdrawn to your wallet
              </p>
              {withdrawHash && (
                <a
                  href={`${explorerUrl}/tx/${withdrawHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-[#007AFF] hover:text-[#0066CC]"
                >
                  View Transaction <ExternalLink className="w-4 h-4" />
                </a>
              )}
              <button
                onClick={onClose}
                className="w-full mt-6 py-3 bg-[#F5F5F7] border border-[#E5E5EA] hover:bg-[#E5E5EA] text-[#1D1D1F] rounded-lg font-semibold transition-colors"
              >
                Close
              </button>
            </div>
          )}

          {step === 'error' && (
            <div className="text-center py-8">
              <AlertCircle className="w-16 h-16 text-[#FF3B30] mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">Withdrawal Failed</h3>
              <p className="text-[#86868b] mb-4 text-sm break-words">
                {errorMessage.slice(0, 200)}
              </p>
              <button
                onClick={() => {
                  setStep('input');
                  setErrorMessage('');
                }}
                className="w-full py-3 bg-[#F5F5F7] border border-[#E5E5EA] hover:bg-[#E5E5EA] text-[#1D1D1F] rounded-lg font-semibold transition-colors"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
