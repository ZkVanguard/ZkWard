'use client';

/**
 * usePrivyEmbeddedAddress — returns the current user's Privy-embedded
 * EVM wallet address, or null.
 *
 * Why not just call usePrivy() / useWallets() directly?
 *   1. Rules of Hooks — call sites must not conditionally invoke Privy
 *      hooks based on whether isPrivyEnabled().
 *   2. Marketing routes don't mount PrivyProvider, so a raw usePrivy()
 *      call throws.
 *
 * Compromise: split the hook by module. The safe wrapper below dynamically
 * imports the real hook only when Privy env is set at build time (the check
 * is static — Next.js inlines process.env.NEXT_PUBLIC_PRIVY_APP_ID at
 * build). That keeps the hook call count stable across renders (the real
 * hook is either always called, or always the noop).
 */

import { isPrivyEnabled } from './privy-config';
import { usePrivyEmbeddedAddressReal } from './usePrivyEmbeddedAddress.impl';

export function usePrivyEmbeddedAddress(): `0x${string}` | null {
  // Static: same branch on every render for this build.
  if (!isPrivyEnabled()) return null;
  // The impl module calls Privy hooks — safe here because Privy is on.
  return usePrivyEmbeddedAddressReal();
}
