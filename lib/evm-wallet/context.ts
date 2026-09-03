/**
 * EVM wallet context shim — replaces the deleted WdkProvider.
 *
 * useWdkSafe / useWdkAccountSafe kept as-is so consumers (dashboard
 * useCommunityPool, ConnectButton) continue to compile. Every field is
 * a permanent "disconnected" until the universal EVM wallet is wired.
 */

'use client';

export interface WdkAccount {
  address: string;
  chainKey: string;
  chainId: number;
}

export interface WdkWalletState {
  isConnected: boolean;
  isLoading: boolean;
  address: string | null;
  chainId: number | null;
  chainKey: string | null;
  accounts: WdkAccount[];
  error: string | null;
  isUnlocked: boolean;
  hasPasskey: boolean;
  hasWallet: boolean;
}

export interface WdkContextValue {
  state: WdkWalletState;
  isChainSupported: (chainKey: string) => boolean;
  getSupportedChains: () => string[];
  switchChain: (chainKey: string) => Promise<boolean>;
  disconnect: () => void;
}

const disconnectedState: WdkWalletState = {
  isConnected: false,
  isLoading: false,
  address: null,
  chainId: null,
  chainKey: null,
  accounts: [],
  error: null,
  isUnlocked: false,
  hasPasskey: false,
  hasWallet: false,
};

export function useWdkSafe(): WdkContextValue | null {
  return null;
}

export function useWdkAccountSafe(): {
  address: string | null;
  isConnected: boolean;
  chainId: number | null;
  chainKey: string | null;
} {
  return { address: null, isConnected: false, chainId: null, chainKey: null };
}

export function useWdk(): WdkContextValue {
  return {
    state: disconnectedState,
    isChainSupported: () => false,
    getSupportedChains: () => [],
    switchChain: async () => false,
    disconnect: () => {},
  };
}
