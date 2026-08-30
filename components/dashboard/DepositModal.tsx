'use client';

import { useState, useEffect, useMemo } from 'react';
import { logger } from '@/lib/utils/logger';
import { X, Loader2, CheckCircle, AlertCircle, ExternalLink, Coins } from 'lucide-react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, usePublicClient, useBalance, useChainId } from '@/lib/wdk/wdk-hooks';
import { parseUnits, formatUnits, parseEther } from 'viem';
import { getContractAddresses } from '../../lib/contracts/addresses';
import { RWA_MANAGER_ABI } from '../../lib/contracts/abis';
import { trackSuccessfulTransaction } from '@/lib/utils/transactionTracker';
import { EXPLORER_URLS } from '@/lib/hooks/useNetwork';
import { getUSDTAddress, getChainConfig, USDT_METADATA } from '../../lib/config/wdk';

// WCRO contract address for wrapping native CRO
const WCRO_ADDRESS = '0x6a3173618859C7cd40fAF6921b5E9eB6A76f1fD4' as `0x${string}`;

// Token interface
interface TokenConfig {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  description: string;
  isNative: boolean;
  logo?: string;
}

// Cronos Testnet tokens ONLY (verified contract addresses)
const TESTNET_TOKENS: TokenConfig[] = [
  {
    symbol: 'tCRO',
    name: 'Native CRO (Testnet)',
    address: 'native' as `0x${string}`, // Special marker for native token
    decimals: 18,
    description: 'Native testnet CRO - will be wrapped to WCRO',
    isNative: true,
  },
  { 
    symbol: 'devUSDC', 
    name: 'DevUSDCe (Testnet)',
    address: '0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0' as `0x${string}`,
    decimals: 6,
    description: 'Testnet USDC for development',
    isNative: false,
  },
  { 
    symbol: 'WCRO', 
    name: 'Wrapped CRO (Testnet)',
    address: '0x6a3173618859C7cd40fAF6921b5E9eB6A76f1fD4' as `0x${string}`,
    decimals: 18,
    description: 'Wrapped version of tCRO',
    isNative: false,
  },
];

// Mainnet tokens with USDT via Tether WDK
function getMainnetTokens(chainId: number): TokenConfig[] {
  const usdtAddress = getUSDTAddress(chainId);
  const chainConfig = getChainConfig(chainId);
  
  const tokens: TokenConfig[] = [];
  
  // Add USDT if available on this chain
  if (usdtAddress) {
    tokens.push({
      symbol: 'USDT',
      name: 'Tether USD',
      address: usdtAddress as `0x${string}`,
      decimals: USDT_METADATA.decimals,
      description: 'Official Tether USDT stablecoin',
      isNative: false,
      logo: USDT_METADATA.logo,
    });
  }
  
  // Add native token for the chain
  if (chainConfig) {
    tokens.push({
      symbol: chainConfig.nativeCurrency.symbol,
      name: `Native ${chainConfig.nativeCurrency.name}`,
      address: 'native' as `0x${string}`,
      decimals: chainConfig.nativeCurrency.decimals,
      description: `Native ${chainConfig.name} token`,
      isNative: true,
    });
  }
  
  return tokens;
}

// WCRO ABI for wrapping
const WCRO_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
] as const;

// ERC20 ABI for approve and balanceOf
const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

interface DepositModalProps {
  isOpen: boolean;
  onClose: () => void;
  portfolioId: number;
  targetYield: number;
  riskTolerance: number;
  onSuccess?: () => void;
}

export function DepositModal({ 
  isOpen, 
  onClose, 
  portfolioId, 
  targetYield, 
  riskTolerance,
  onSuccess 
}: DepositModalProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const explorerUrl = EXPLORER_URLS[chainId] || EXPLORER_URLS[338];
  
  // Determine available tokens based on network (mainnet vs testnet)
  const chainConfig = getChainConfig(chainId);
  const isMainnetNetwork = chainConfig?.network === 'mainnet';
  const availableTokens = useMemo(() => {
    return isMainnetNetwork ? getMainnetTokens(chainId) : TESTNET_TOKENS;
  }, [chainId, isMainnetNetwork]);
  
  const [selectedToken, setSelectedToken] = useState<TokenConfig>(availableTokens[0]);
  const [amount, setAmount] = useState('');
  const [tokenBalance, setTokenBalance] = useState<string>('0');
  const [nativeBalance, setNativeBalance] = useState<string>('0');
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [step, setStep] = useState<'input' | 'wrapping' | 'approve' | 'deposit' | 'success' | 'error'>('input');
  const [errorMessage, setErrorMessage] = useState('');
  
  // Reset selected token when chain changes
  useEffect(() => {
    setSelectedToken(availableTokens[0]);
  }, [chainId, availableTokens]);

  const addresses = getContractAddresses(chainId);
  const rwaManagerAddress = addresses.rwaManager as `0x${string}`;

  // Get native balance using WDK hook
  const { data: nativeBalanceData } = useBalance({
    address: address,
  });

  // Wrap CRO transaction
  const { 
    writeContract: writeWrap, 
    data: wrapHash,
    isPending: _isWrapPending,
    error: wrapError 
  } = useWriteContract();

  // Wait for wrap confirmation
  const { isLoading: isWrapConfirming, isSuccess: isWrapSuccess } = 
    useWaitForTransactionReceipt({ hash: wrapHash });

  // Approve transaction
  const { 
    writeContract: writeApprove, 
    data: approveHash,
    isPending: _isApprovePending,
    error: approveError 
  } = useWriteContract();

  // Deposit transaction
  const { 
    writeContract: writeDeposit, 
    data: depositHash,
    isPending: _isDepositPending,
    error: depositError 
  } = useWriteContract();

  // Wait for approve confirmation
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = 
    useWaitForTransactionReceipt({ hash: approveHash });

  // Wait for deposit confirmation
  const { isLoading: isDepositConfirming, isSuccess: isDepositSuccess } = 
    useWaitForTransactionReceipt({ hash: depositHash });

  // Update native balance when data changes
  useEffect(() => {
    if (nativeBalanceData) {
      setNativeBalance(formatUnits(nativeBalanceData.value, 18));
    }
  }, [nativeBalanceData]);

  // Fetch token balance and allowance
  useEffect(() => {
    async function fetchBalanceAndAllowance() {
      if (!address || !publicClient) return;

      // For native token, use the native balance
      if (selectedToken.isNative) {
        // Native balance is already set via useBalance hook
        // For native CRO deposits, we'll wrap to WCRO, so check WCRO allowance
        try {
          const currentAllowance = await publicClient.readContract({
            address: WCRO_ADDRESS,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [address, rwaManagerAddress],
          });
          setAllowance(currentAllowance);
          setTokenBalance(nativeBalance);
        } catch (error) {
          logger.error('Failed to fetch WCRO allowance', error instanceof Error ? error : undefined);
          setAllowance(0n);
        }
        return;
      }

      try {
        const balance = await publicClient.readContract({
          address: selectedToken.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        });
        setTokenBalance(formatUnits(balance, selectedToken.decimals));

        const currentAllowance = await publicClient.readContract({
          address: selectedToken.address,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [address, rwaManagerAddress],
        });
        setAllowance(currentAllowance);
      } catch (error) {
        logger.error('Failed to fetch balance', error instanceof Error ? error : undefined);
        setTokenBalance('0');
      }
    }

    if (isOpen) {
      fetchBalanceAndAllowance();
    }
  }, [address, selectedToken, isOpen, publicClient, rwaManagerAddress, nativeBalance]);

  // Handle approve success - proceed to deposit
  useEffect(() => {
    if (isApproveSuccess && step === 'approve' && approveHash && address) {
      // Track the approval transaction
      trackSuccessfulTransaction({
        hash: approveHash,
        type: 'approve',
        from: address,
        to: selectedToken.address,
        value: amount,
        tokenSymbol: selectedToken.symbol,
        description: `Approve ${selectedToken.symbol} for Portfolio #${portfolioId}`,
      });
      handleDeposit();
    }
  }, [isApproveSuccess, approveHash, address, step]);

  // Handle deposit success
  useEffect(() => {
    if (isDepositSuccess && depositHash && address) {
      // Track the successful deposit transaction
      trackSuccessfulTransaction({
        hash: depositHash,
        type: 'deposit',
        from: address,
        to: rwaManagerAddress,
        value: amount,
        tokenSymbol: selectedToken.symbol,
        description: `Deposit ${amount} ${selectedToken.symbol} to Portfolio #${portfolioId}`,
      });
      
      setStep('success');
      onSuccess?.();
    }
  }, [isDepositSuccess, depositHash, address, amount, selectedToken.symbol, portfolioId, rwaManagerAddress]);

  // Handle errors
  useEffect(() => {
    if (approveError) {
      setErrorMessage(approveError.message || 'Approval failed');
      setStep('error');
    }
    if (depositError) {
      setErrorMessage(depositError.message || 'Deposit failed');
      setStep('error');
    }
    if (wrapError) {
      setErrorMessage(wrapError.message || 'Wrapping CRO failed');
      setStep('error');
    }
  }, [approveError, depositError, wrapError]);

  // Handle wrap success - proceed to approve WCRO
  useEffect(() => {
    if (isWrapSuccess && step === 'wrapping' && wrapHash && address) {
      trackSuccessfulTransaction({
        hash: wrapHash,
        type: 'wrap',
        from: address,
        to: WCRO_ADDRESS,
        value: amount,
        tokenSymbol: 'tCRO → WCRO',
        description: `Wrap ${amount} tCRO to WCRO`,
      });
      // After wrapping, proceed to approve WCRO
      handleApproveWCRO();
    }
  }, [isWrapSuccess, wrapHash, address, step]);

  const handleWrap = () => {
    if (!amount) return;
    
    const amountInWei = parseEther(amount);
    setStep('wrapping');

    writeWrap({
      address: WCRO_ADDRESS,
      abi: WCRO_ABI,
      functionName: 'deposit',
      value: amountInWei,
    });
  };

  const handleApproveWCRO = () => {
    if (!amount) return;
    
    const amountInWei = parseEther(amount);
    setStep('approve');

    writeApprove({
      address: WCRO_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [rwaManagerAddress, amountInWei],
    });
  };

  const handleApprove = () => {
    if (!amount) return;
    
    const amountInWei = parseUnits(amount, selectedToken.decimals);
    setStep('approve');

    // For native token, we already wrapped, so approve WCRO
    const tokenAddress = selectedToken.isNative ? WCRO_ADDRESS : selectedToken.address;

    writeApprove({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [rwaManagerAddress, amountInWei],
    });
  };

  const handleDeposit = () => {
    if (!amount) return;
    
    // For native token, deposit WCRO
    const depositAddress = selectedToken.isNative ? WCRO_ADDRESS : selectedToken.address;
    const decimals = selectedToken.isNative ? 18 : selectedToken.decimals;
    const amountInWei = parseUnits(amount, decimals);
    
    setStep('deposit');

    writeDeposit({
      address: rwaManagerAddress,
      abi: RWA_MANAGER_ABI,
      functionName: 'depositAsset',
      args: [BigInt(portfolioId), depositAddress, amountInWei],
    });
  };

  const handleSubmit = () => {
    if (!amount || parseFloat(amount) <= 0) return;
    
    // Clear previous error state on new attempt
    setErrorMessage('');

    // For native token, need to wrap first, then approve, then deposit
    if (selectedToken.isNative) {
      handleWrap();
      return;
    }

    const amountInWei = parseUnits(amount, selectedToken.decimals);
    
    // Check if we need approval first
    if (allowance < amountInWei) {
      handleApprove();
    } else {
      handleDeposit();
    }
  };

  const needsApproval = amount && parseFloat(amount) > 0 && 
    allowance < parseUnits(amount || '0', selectedToken.decimals);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl border border-separator-opaque w-full max-w-md shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-separator-opaque">
          <div>
            <h2 className="text-xl font-bold text-label-primary">Fund Portfolio #{portfolioId}</h2>
            <p className="text-sm text-label-secondary mt-1">
              {targetYield}% yield target • {riskTolerance}/100 risk
            </p>
          </div>
          <button 
            onClick={onClose}
            className="p-2 hover:bg-system-bg-secondary rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-label-secondary" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {step === 'input' && (
            <>
              {/* Token Selection */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-label-primary mb-2">
                  Select Token {isMainnetNetwork && <span className="text-ios-green text-xs ml-1">(Mainnet)</span>}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {availableTokens.slice(0, 6).map((token) => (
                    <button
                      key={token.symbol}
                      onClick={() => setSelectedToken(token)}
                      className={`p-3 rounded-xl border transition-all ${
                        selectedToken.symbol === token.symbol
                          ? 'border-ios-blue bg-ios-blue/10'
                          : 'border-separator-opaque hover:border-label-tertiary bg-system-bg-secondary'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {token.symbol === 'USDT' && (
                          <img src={USDT_METADATA.logo} alt="USDT" className="w-4 h-4" />
                        )}
                        <span className="text-sm font-semibold text-label-primary">{token.symbol}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Amount Input */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-label-primary mb-2">
                  Amount
                </label>
                <div className="relative">
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-system-bg-secondary border border-separator-opaque rounded-xl px-4 py-3 text-lg text-label-primary placeholder-label-tertiary focus:outline-none focus:border-ios-blue transition-colors"
                  />
                  <button
                    onClick={() => setAmount(tokenBalance)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-ios-blue hover:text-ios-blueHover"
                  >
                    MAX
                  </button>
                </div>
                <div className="flex justify-between mt-2 text-sm">
                  <span className="text-label-secondary">Available:</span>
                  <span className="text-label-primary">
                    {parseFloat(tokenBalance).toLocaleString(undefined, { maximumFractionDigits: 6 })} {selectedToken.symbol}
                  </span>
                </div>
              </div>

              {/* Info Box */}
              <div className="bg-system-bg-secondary rounded-lg p-4 mb-6">
                <div className="flex items-start gap-3">
                  <Coins className="w-5 h-5 text-ios-blue mt-0.5" />
                  <div className="text-sm">
                    <p className="text-label-primary mb-1">
                      {selectedToken.isNative 
                        ? 'tCRO will be wrapped to WCRO then deposited'
                        : 'Depositing to smart contract portfolio'}
                    </p>
                    <p className="text-label-secondary text-xs">
                      {selectedToken.isNative
                        ? 'Native CRO will be wrapped to WCRO (ERC20) and then transferred to the portfolio contract.'
                        : 'Tokens will be transferred to the portfolio contract for automated strategy execution.'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Action Button */}
              <button
                onClick={handleSubmit}
                disabled={!amount || parseFloat(amount) <= 0 || parseFloat(amount) > parseFloat(tokenBalance)}
                className="w-full py-3 bg-ios-blue hover:bg-ios-blueHover disabled:bg-label-tertiary disabled:cursor-not-allowed rounded-xl font-semibold text-white transition-all"
              >
                {selectedToken.isNative 
                  ? `Wrap & Deposit ${selectedToken.symbol}`
                  : needsApproval 
                    ? `Approve & Deposit ${selectedToken.symbol}` 
                    : `Deposit ${selectedToken.symbol}`}
              </button>

              {parseFloat(tokenBalance) === 0 && (
                <p className="text-center text-ios-orange text-sm mt-3">
                  You don't have any {selectedToken.symbol}. Try a different token or get testnet tokens first.
                </p>
              )}
            </>
          )}

          {step === 'wrapping' && (
            <div className="text-center py-8">
              <Loader2 className="w-16 h-16 text-ios-blue animate-spin mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-label-primary mb-2">Wrapping tCRO...</h3>
              <p className="text-label-secondary mb-4">
                Please confirm the wrap transaction in your wallet
              </p>
              {isWrapConfirming && (
                <p className="text-sm text-ios-blue">
                  Waiting for confirmation...
                </p>
              )}
            </div>
          )}

          {(step === 'approve' || step === 'deposit') && (
            <div className="text-center py-8">
              <Loader2 className="w-16 h-16 text-ios-blue animate-spin mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-label-primary mb-2">
                {step === 'approve' ? 'Approving Token...' : 'Depositing...'}
              </h3>
              <p className="text-label-secondary mb-4">
                {step === 'approve' 
                  ? 'Please confirm the approval in your wallet'
                  : 'Please confirm the deposit in your wallet'}
              </p>
              {(isApproveConfirming || isDepositConfirming) && (
                <p className="text-sm text-ios-blue">
                  Waiting for confirmation...
                </p>
              )}
            </div>
          )}

          {step === 'success' && (
            <div className="text-center py-8">
              <CheckCircle className="w-16 h-16 text-ios-green mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">Deposit Successful!</h3>
              <p className="text-label-secondary mb-4">
                {amount} {selectedToken.symbol} has been deposited to Portfolio #{portfolioId}
              </p>
              {depositHash && (
                <a
                  href={`${explorerUrl}/tx/${depositHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-ios-blue hover:text-ios-blueHover"
                >
                  View Transaction <ExternalLink className="w-4 h-4" />
                </a>
              )}
              <button
                onClick={onClose}
                className="w-full mt-6 py-3 bg-system-bg-secondary border border-separator-opaque hover:bg-ios-gray5 text-label-primary rounded-lg font-semibold transition-colors"
              >
                Close
              </button>
            </div>
          )}

          {step === 'error' && (
            <div className="text-center py-8">
              <AlertCircle className="w-16 h-16 text-ios-red mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">Transaction Failed</h3>
              <p className="text-label-secondary mb-4 text-sm break-words">
                {errorMessage.slice(0, 200)}
              </p>
              <button
                onClick={() => {
                  setStep('input');
                  setErrorMessage('');
                }}
                className="w-full py-3 bg-system-bg-secondary border border-separator-opaque hover:bg-ios-gray5 text-label-primary rounded-lg font-semibold transition-colors"
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
