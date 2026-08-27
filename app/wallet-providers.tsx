'use client';

// Wallet providers — WdkProvider (ethers) and SuiWalletProviders
// (@mysten/sui + @mysten/dapp-kit). Extracted from app/providers.tsx
// so they only mount inside /dashboard, not on marketing routes.
//
// Marketing pages don't call any wallet hooks and don't need the SDKs.
// Deferring these providers ships ~800 KB less JS on /, /agents, /zk,
// /rwa, /whitepaper — the pages users land on first.

import type { ReactNode } from 'react';
import { WdkProvider } from '../lib/wdk/wdk-context';
import { SuiWalletProviders } from './sui-providers';
import { WdkModalProvider } from '../contexts/WdkModalContext';

export function WalletProviders({ children }: { children: ReactNode }) {
  return (
    <WdkProvider defaultChain={process.env.NEXT_PUBLIC_DEFAULT_CHAIN || 'cronos-mainnet'}>
      <SuiWalletProviders>
        {/* WdkModalProvider renders the modal outside Navbar's
            backdrop-filter stacking context. */}
        <WdkModalProvider>
          {children}
        </WdkModalProvider>
      </SuiWalletProviders>
    </WdkProvider>
  );
}
