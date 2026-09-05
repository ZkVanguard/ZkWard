'use client';

// Wallet providers — WagmiProvider (Hedera-primary EVM) + SuiWalletProviders.
// Extracted from app/providers.tsx so the ~800 KB of wallet SDKs only mount
// inside /dashboard, not on marketing routes.
//
// Hackathon pivot (2026-09-04): Hedera is now the primary chain. Wagmi
// config in lib/evm-wallet/wagmi-config.ts orders Hedera Testnet first,
// so a user without a wallet defaults to prompting for Hedera. SUI stays
// live as the secondary optional path.

import type { ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { getWagmiConfig } from '@/lib/evm-wallet/wagmi-config';
import { SuiWalletProviders } from './sui-providers';

export function WalletProviders({ children }: { children: ReactNode }) {
  // React Query client for wagmi — separate from the app-level one to
  // isolate wallet queries from dashboard data queries.
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 },
    },
  }));

  return (
    <WagmiProvider config={getWagmiConfig()}>
      <QueryClientProvider client={queryClient}>
        <SuiWalletProviders>{children}</SuiWalletProviders>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
