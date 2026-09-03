'use client';

// Wallet providers — currently just SuiWalletProviders (@mysten/sui +
// @mysten/dapp-kit). Extracted from app/providers.tsx so the ~800 KB of
// wallet SDKs only mount inside /dashboard, not on marketing routes.
//
// Multi-chain EVM connector slot: to be wired here when the universal
// EVM wallet is chosen (wagmi + WalletConnect / Reown AppKit).

import type { ReactNode } from 'react';
import { SuiWalletProviders } from './sui-providers';

export function WalletProviders({ children }: { children: ReactNode }) {
  return <SuiWalletProviders>{children}</SuiWalletProviders>;
}
