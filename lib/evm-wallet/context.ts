/**
 * EVM wallet context — wagmi bridge for legacy `useWdkSafe` consumers.
 *
 * Existing dashboard code (12+ files, mostly under components/dashboard/)
 * imports `useWdkSafe` / `useWdkAccountSafe` from here — these were the
 * safe-hook wrappers around the deleted WDK provider. This file now
 * bridges wagmi state into those same shapes so nothing downstream has
 * to change during the Hedera-primary pivot.
 *
 * Once every consumer migrates to wagmi's native hooks directly, this
 * file can be deleted.
 */

'use client';

import { useAccount, useDisconnect, useSwitchChain } from 'wagmi';
import { CHAIN_PICKER_ORDER, isHederaChain } from './wagmi-config';

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

// Map chain id → the string "chainKey" the legacy WDK API used.
function chainIdToKey(chainId: number | undefined): string | null {
  if (!chainId) return null;
  const match = CHAIN_PICKER_ORDER.find((c) => c.id === chainId);
  return match?.name.toLowerCase().replace(/\s+/g, '-') ?? null;
}

/**
 * Safe accessor — returns null if wagmi isn't mounted (SSR, marketing
 * routes without the WagmiProvider). Consumers use ?? disconnected
 * defaults.
 */
export function useWdkSafe(): WdkContextValue | null {
  try {
    const acct = useAccount();
    const disc = useDisconnect();
    const sw = useSwitchChain();
    const state: WdkWalletState = {
      isConnected: acct.isConnected,
      isLoading: acct.isConnecting || acct.isReconnecting,
      address: acct.address ?? null,
      chainId: acct.chainId ?? null,
      chainKey: chainIdToKey(acct.chainId),
      accounts: acct.address && acct.chainId
        ? [{ address: acct.address, chainKey: chainIdToKey(acct.chainId) ?? 'unknown', chainId: acct.chainId }]
        : [],
      error: null,
      isUnlocked: acct.isConnected,
      hasPasskey: false,
      hasWallet: acct.isConnected,
    };
    return {
      state,
      isChainSupported: (chainKey: string) =>
        CHAIN_PICKER_ORDER.some((c) => c.name.toLowerCase().replace(/\s+/g, '-') === chainKey),
      getSupportedChains: () =>
        CHAIN_PICKER_ORDER.map((c) => c.name.toLowerCase().replace(/\s+/g, '-')),
      switchChain: async (chainKey: string) => {
        const target = CHAIN_PICKER_ORDER.find(
          (c) => c.name.toLowerCase().replace(/\s+/g, '-') === chainKey,
        );
        if (!target) return false;
        try {
          await sw.switchChainAsync({ chainId: target.id });
          return true;
        } catch {
          return false;
        }
      },
      disconnect: () => disc.disconnect(),
    };
  } catch {
    // Provider missing — return disconnected shape so marketing routes
    // don't crash on the shared Navbar's ConnectButton.
    return null;
  }
}

export function useWdkAccountSafe(): {
  address: string | null;
  isConnected: boolean;
  chainId: number | null;
  chainKey: string | null;
} {
  const ctx = useWdkSafe();
  if (!ctx) return { address: null, isConnected: false, chainId: null, chainKey: null };
  return {
    address: ctx.state.address,
    isConnected: ctx.state.isConnected,
    chainId: ctx.state.chainId,
    chainKey: ctx.state.chainKey,
  };
}

/** True when the connected EVM wallet is on a Hedera chain (primary). */
export function useIsOnHedera(): boolean {
  const acct = useAccount();
  return isHederaChain(acct.chainId);
}

// Kept for API compat with the old shim.
export function useWdk(): WdkContextValue {
  const safe = useWdkSafe();
  if (!safe) {
    throw new Error('useWdk called outside WagmiProvider — use useWdkSafe on marketing routes');
  }
  return safe;
}
