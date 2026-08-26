'use client';

// After PR #71 consolidated portfolio/risk/custody into tabs on
// /dashboard itself, this layout's only remaining job is provider
// wrapping. The old sub-tab strip + `onRoot` branch pointed at routes
// that no longer exist — the Link elements were emitting 404 RSC
// prefetches on every /dashboard visit (visible in the console).

import type { ReactNode } from 'react';
import { PositionsProvider } from '@/contexts/PositionsContext';
import { AIDecisionsProvider } from '@/contexts/AIDecisionsContext';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <PositionsProvider>
      <AIDecisionsProvider>
        {children}
      </AIDecisionsProvider>
    </PositionsProvider>
  );
}
