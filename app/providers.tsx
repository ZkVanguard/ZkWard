'use client';

// MUST be imported first - sets up BigInt serialization and fetch interceptor
import './api-interceptor';

import { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider as CustomThemeProvider } from '../contexts/ThemeContext';

// Light-weight providers used across every route (marketing + app).
// Wallet-heavy providers (WdkProvider, SuiWalletProviders — ~800 KB of
// @mysten SDKs + ethers) live in app/wallet-providers.tsx and only
// wrap /dashboard/**. See dashboard/layout.tsx.

// Singleton QueryClient instance — optimized for multi-user scale
let queryClientInstance: QueryClient | null = null;
function getQueryClient() {
  if (!queryClientInstance) {
    queryClientInstance = new QueryClient({
      defaultOptions: {
        queries: {
          refetchOnWindowFocus: false,
          retry: 1,                      // Reduced from 2: fail fast for faster UX
          staleTime: 120_000,            // 2 minutes
          gcTime: 600_000,               // 10 minutes
          refetchOnMount: false,
          refetchOnReconnect: false,
          networkMode: 'offlineFirst',   // Use cache while offline, reduces refetches
        },
        mutations: {
          retry: 1,
          networkMode: 'offlineFirst',
        },
      },
    });
  }
  return queryClientInstance;
}

export function Providers({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();

  return (
    <CustomThemeProvider>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </CustomThemeProvider>
  );
}
