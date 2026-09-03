'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAccount, usePublicClient, useChainId, useWriteContract, useWaitForTransactionReceipt } from '@/lib/evm-wallet/hooks';
import { parseUnits, formatUnits } from 'viem';
import { getUSDTAddress, getChainConfig, USDT_METADATA, WDK_SUPPORTED_CHAINS } from '@/lib/evm-wallet/chains';

// ============================================
// Types
// ============================================

export interface USDTState {
  // Balance info
  balance: bigint;
  balanceFormatted: string;
  usdValue: number;
  
  // Token info
  tokenAddress: string | null;
  chainId: number;
  chainName: string;
  isMainnet: boolean;
  
  // Status
  isLoading: boolean;
  error: Error | null;
  
  // Actions
  refetchBalance: () => Promise<void>;
}

export interface UseUSDTApprovalResult {
  approve: (spender: string, amount: bigint) => Promise<`0x${string}` | undefined>;
  isApproving: boolean;
  approvalHash: `0x${string}` | undefined;
  isApprovalPending: boolean;
  isApprovalSuccess: boolean;
  error: Error | null;
}

export interface UseUSDTTransferResult {
  transfer: (to: string, amount: bigint) => Promise<`0x${string}` | undefined>;
  isTransferring: boolean;
  transferHash: `0x${string}` | undefined;
  isTransferPending: boolean;
  isTransferSuccess: boolean;
  error: Error | null;
}

// ============================================
// ERC20 ABI
// ============================================

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: 'remaining', type: 'uint256' }],
  },
] as const;

// ============================================
// useUSDT Hook
// ============================================

/**
 * Hook to get USDT balance and token info for the connected wallet.
 * Automatically uses the correct USDT address based on the connected chain.
 * 
 * @example
 * ```tsx
 * const { balance, balanceFormatted, tokenAddress, isLoading } = useUSDT();
 * ```
 */
export function useUSDT(): USDTState {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  
  const [balance, setBalance] = useState<bigint>(BigInt(0));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  
  // Get chain config and USDT address
  const chainConfig = useMemo(() => getChainConfig(chainId), [chainId]);
  const tokenAddress = chainConfig?.usdtAddress ?? null;
  const chainName = chainConfig?.name ?? 'Unknown';
  const isMainnetChain = chainConfig?.network === 'mainnet';
  
  // Fetch balance
  const fetchBalance = useCallback(async () => {
    if (!address || !tokenAddress || !publicClient) {
      setBalance(BigInt(0));
      setIsLoading(false);
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [address],
      });
      
      setBalance(result as bigint);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to fetch USDT balance');
      setError(error);
      console.error('[useUSDT] Error fetching balance:', error);
    } finally {
      setIsLoading(false);
    }
  }, [address, tokenAddress, publicClient]);
  
  // Fetch on mount and when dependencies change
  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);
  
  // Format balance
  const balanceFormatted = useMemo(() => {
    return formatUnits(balance, USDT_METADATA.decimals);
  }, [balance]);
  
  const usdValue = parseFloat(balanceFormatted);
  
  return {
    balance,
    balanceFormatted,
    usdValue,
    tokenAddress,
    chainId,
    chainName,
    isMainnet: isMainnetChain,
    isLoading,
    error,
    refetchBalance: fetchBalance,
  };
}

// ============================================
// useUSDTApproval Hook
// ============================================

/**
 * Hook to approve USDT spending for a contract.
 * 
 * @example
 * ```tsx
 * const { approve, isApproving, isApprovalSuccess } = useUSDTApproval();
 * 
 * // Approve 100 USDT for CommunityPool
 * await approve(poolAddress, parseUnits('100', 6));
 * ```
 */
export function useUSDTApproval(): UseUSDTApprovalResult {
  const chainId = useChainId();
  const tokenAddress = getUSDTAddress(chainId);
  
  const { writeContractAsync, data: hash, isPending, error } = useWriteContract();
  
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });
  
  const approve = useCallback(async (spender: string, amount: bigint) => {
    if (!tokenAddress) {
      throw new Error(`No USDT address for chain ${chainId}`);
    }
    
    return writeContractAsync({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender as `0x${string}`, amount],
    });
  }, [tokenAddress, chainId, writeContractAsync]);
  
  return {
    approve,
    isApproving: isPending,
    approvalHash: hash,
    isApprovalPending: isConfirming,
    isApprovalSuccess: isSuccess,
    error: error as Error | null,
  };
}

// ============================================
// useUSDTTransfer Hook
// ============================================

/**
 * Hook to transfer USDT to another address.
 * 
 * @example
 * ```tsx
 * const { transfer, isTransferring, isTransferSuccess } = useUSDTTransfer();
 * 
 * // Send 50 USDT
 * await transfer(recipientAddress, parseUnits('50', 6));
 * ```
 */
export function useUSDTTransfer(): UseUSDTTransferResult {
  const chainId = useChainId();
  const tokenAddress = getUSDTAddress(chainId);
  
  const { writeContractAsync, data: hash, isPending, error } = useWriteContract();
  
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });
  
  const transfer = useCallback(async (to: string, amount: bigint) => {
    if (!tokenAddress) {
      throw new Error(`No USDT address for chain ${chainId}`);
    }
    
    return writeContractAsync({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [to as `0x${string}`, amount],
    });
  }, [tokenAddress, chainId, writeContractAsync]);
  
  return {
    transfer,
    isTransferring: isPending,
    transferHash: hash,
    isTransferPending: isConfirming,
    isTransferSuccess: isSuccess,
    error: error as Error | null,
  };
}

// ============================================
// useUSDTAllowance Hook
// ============================================

/**
 * Hook to check USDT allowance for a spender.
 * 
 * @param spender - The address to check allowance for
 * @example
 * ```tsx
 * const { allowance, isLoading, refetch } = useUSDTAllowance(poolAddress);
 * ```
 */
export function useUSDTAllowance(spender: string | undefined) {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const tokenAddress = getUSDTAddress(chainId);
  
  const [allowance, setAllowance] = useState<bigint>(BigInt(0));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  
  const fetchAllowance = useCallback(async () => {
    if (!address || !spender || !tokenAddress || !publicClient) {
      setAllowance(BigInt(0));
      setIsLoading(false);
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [address, spender as `0x${string}`],
      });
      
      setAllowance(result as bigint);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to fetch allowance');
      setError(error);
      console.error('[useUSDTAllowance] Error:', error);
    } finally {
      setIsLoading(false);
    }
  }, [address, spender, tokenAddress, publicClient]);
  
  useEffect(() => {
    fetchAllowance();
  }, [fetchAllowance]);
  
  return {
    allowance,
    allowanceFormatted: formatUnits(allowance, USDT_METADATA.decimals),
    isLoading,
    error,
    refetch: fetchAllowance,
  };
}

// ============================================
// Utility Functions
// ============================================

/**
 * Parse USDT amount from string to BigInt.
 * 
 * @param amount - Amount as decimal string (e.g., "100.50")
 * @returns BigInt representation
 */
export function parseUSDTAmount(amount: string): bigint {
  return parseUnits(amount, USDT_METADATA.decimals);
}

/**
 * Format USDT amount from BigInt to string.
 * 
 * @param amount - Amount as BigInt
 * @returns Decimal string representation
 */
export function formatUSDTAmount(amount: bigint): string {
  return formatUnits(amount, USDT_METADATA.decimals);
}

/**
 * Check if current chain supports USDT via WDK.
 */
export function useIsWDKSupported(): boolean {
  const chainId = useChainId();
  return WDK_SUPPORTED_CHAINS.includes(chainId as any);
}
