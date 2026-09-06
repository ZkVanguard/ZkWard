'use client';

/**
 * Real implementation — only imported when Privy is enabled at build time.
 * Split from the safe wrapper so tests + non-Privy builds don't need to
 * satisfy the '@privy-io/react-auth' peer.
 */

import { usePrivy, useWallets } from '@privy-io/react-auth';

export function usePrivyEmbeddedAddressReal(): `0x${string}` | null {
  const { authenticated } = usePrivy();
  const { wallets } = useWallets();
  if (!authenticated) return null;
  // Prefer the embedded wallet; fall back to the first wallet if there's
  // only an external one connected (edge case: user pasted a MetaMask
  // address then also signed in with Google).
  const embedded = wallets?.find((w) => w.walletClientType === 'privy') ?? wallets?.[0];
  return (embedded?.address as `0x${string}`) ?? null;
}
