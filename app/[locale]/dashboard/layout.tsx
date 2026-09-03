'use client';

// Provider wrapping for /dashboard. WalletProviders (SuiWalletProviders
// — ~800 KB of @mysten/dapp-kit + @mysten/sui) live here instead of
// root providers so marketing routes (/, /agents, /zk, /rwa,
// /whitepaper) don't pay the bundle cost.

import type { ReactNode } from 'react';
import { PositionsProvider } from '@/contexts/PositionsContext';
import { AIDecisionsProvider } from '@/contexts/AIDecisionsContext';
import { WalletProviders } from '@/app/wallet-providers';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <WalletProviders>
      <PositionsProvider>
        <AIDecisionsProvider>
          {children}
        </AIDecisionsProvider>
      </PositionsProvider>
    </WalletProviders>
  );
}
