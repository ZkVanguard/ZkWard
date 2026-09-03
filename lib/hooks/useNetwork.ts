/**
 * Network Hooks
 * React hooks for network-aware utilities
 */

'use client';

import { useChainId } from '@/lib/evm-wallet/hooks';
import { useMemo } from 'react';

// ============================================
// CONSTANTS
// ============================================

export const CHAIN_IDS = {
  CRONOS_MAINNET: 25,
  CRONOS_TESTNET: 338,
  CRONOS_ZKEVM: 388,
} as const;

export const EXPLORER_URLS: Record<number, string> = {
  [CHAIN_IDS.CRONOS_MAINNET]: 'https://explorer.cronos.org',
  [CHAIN_IDS.CRONOS_TESTNET]: 'https://explorer.cronos.org/testnet',
  [CHAIN_IDS.CRONOS_ZKEVM]: 'https://explorer.zkevm.cronos.org',
};

// ============================================
// HOOKS
// ============================================

/**
 * Hook to get the explorer base URL for the current chain
 */
export function useExplorerUrl(): string {
  const chainId = useChainId();
  return useMemo(() => {
    return EXPLORER_URLS[chainId] || EXPLORER_URLS[CHAIN_IDS.CRONOS_TESTNET];
  }, [chainId]);
}

/**
 * Hook to get explorer URL for a transaction
 */
export function useExplorerTxUrl(txHash?: string): string {
  const explorerUrl = useExplorerUrl();
  return useMemo(() => {
    if (!txHash) return '';
    return `${explorerUrl}/tx/${txHash}`;
  }, [explorerUrl, txHash]);
}

/**
 * Hook to get explorer URL for an address
 */
export function useExplorerAddressUrl(address?: string): string {
  const explorerUrl = useExplorerUrl();
  return useMemo(() => {
    if (!address) return '';
    return `${explorerUrl}/address/${address}`;
  }, [explorerUrl, address]);
}

/**
 * Hook to check if on mainnet
 */
export function useIsMainnet(): boolean {
  const chainId = useChainId();
  return chainId === CHAIN_IDS.CRONOS_MAINNET;
}

/**
 * Hook to check if on testnet
 */
export function useIsTestnet(): boolean {
  const chainId = useChainId();
  return chainId === CHAIN_IDS.CRONOS_TESTNET;
}

/**
 * Hook to get network name
 */
export function useNetworkName(): string {
  const chainId = useChainId();
  return useMemo(() => {
    switch (chainId) {
      case CHAIN_IDS.CRONOS_MAINNET:
        return 'Cronos Mainnet';
      case CHAIN_IDS.CRONOS_TESTNET:
        return 'Cronos Testnet';
      case CHAIN_IDS.CRONOS_ZKEVM:
        return 'Cronos zkEVM';
      default:
        return 'Unknown Network';
    }
  }, [chainId]);
}

/**
 * Hook to get USDC address for current chain
 */
export function useUsdcAddress(): `0x${string}` {
  const chainId = useChainId();
  return useMemo(() => {
    switch (chainId) {
      case CHAIN_IDS.CRONOS_MAINNET:
        // Real USDC on Cronos Mainnet
        return '0xc21223249CA28397B4B6541dfFaEcC539BfF0c59';
      case CHAIN_IDS.CRONOS_TESTNET:
        // DevUSDCe on Cronos Testnet
        return '0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0';
      case CHAIN_IDS.CRONOS_ZKEVM:
        // zkUSDC on Cronos zkEVM
        return '0xaa5b845F8C9c047779bEDf64829601d8B264076c';
      default:
        return '0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0';
    }
  }, [chainId]);
}

/**
 * Hook to get Moonlander address for current chain
 */
export function useMoonlanderAddress(): `0x${string}` {
  const chainId = useChainId();
  return useMemo(() => {
    switch (chainId) {
      case CHAIN_IDS.CRONOS_MAINNET:
      case CHAIN_IDS.CRONOS_TESTNET:
        // Same address works on both (Moonlander Diamond)
        return '0xE6F6351fb66f3a35313fEEFF9116698665FBEeC9';
      case CHAIN_IDS.CRONOS_ZKEVM:
        return '0x02ae2e56bfDF1ee4667405eE7e959CD3fE717A05';
      default:
        return '0xE6F6351fb66f3a35313fEEFF9116698665FBEeC9';
    }
  }, [chainId]);
}

// ============================================
// UTILITY FUNCTIONS (for non-hook contexts)
// ============================================

/**
 * Get explorer URL for a transaction (non-hook version)
 */
export function getExplorerTxUrl(txHash: string, chainId: number = 338): string {
  const baseUrl = EXPLORER_URLS[chainId] || EXPLORER_URLS[CHAIN_IDS.CRONOS_TESTNET];
  return `${baseUrl}/tx/${txHash}`;
}

/**
 * Get explorer URL for an address (non-hook version)
 */
export function getExplorerAddressUrl(address: string, chainId: number = 338): string {
  const baseUrl = EXPLORER_URLS[chainId] || EXPLORER_URLS[CHAIN_IDS.CRONOS_TESTNET];
  return `${baseUrl}/address/${address}`;
}
