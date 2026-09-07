'use client';

/**
 * Real implementation — only imported when Privy is enabled at build time.
 * Split from the safe wrapper so tests + non-Privy builds don't need to
 * satisfy the '@privy-io/react-auth' peer.
 *
 * Address resolution order:
 *   1. useWallets() — fastest once Privy's WagmiProvider has connected
 *      the embedded wallet, but may be empty for a beat after Google
 *      login while the wallet materialises server-side.
 *   2. user.linkedAccounts — the source of truth. Every account tied
 *      to the current Privy user, including embedded EVM wallets.
 *   3. useCreateWallet().createWallet() — fired once when the user is
 *      authenticated but no embedded wallet is linked. Handles the
 *      edge case where createOnLogin didn't trigger (some Google-first
 *      flows skip it silently).
 */

import { useEffect, useRef } from 'react';
import { usePrivy, useWallets, useCreateWallet } from '@privy-io/react-auth';

interface LinkedAccountLike {
  type?: string;
  address?: string;
  walletClientType?: string;
  wallet_client_type?: string;
  chainType?: string;
  chain_type?: string;
}

function findEmbeddedFromLinkedAccounts(
  linkedAccounts: readonly LinkedAccountLike[] | undefined,
): string | null {
  if (!linkedAccounts) return null;
  // Prefer explicit ethereum embedded wallets. Privy also stores solana +
  // bitcoin embedded wallets under the same 'wallet' type — filter by chain.
  const embedded = linkedAccounts.find(
    (a) =>
      a.type === 'wallet' &&
      (a.walletClientType === 'privy' || a.wallet_client_type === 'privy') &&
      (a.chainType === 'ethereum' || a.chain_type === 'ethereum' || !a.chainType),
  );
  return embedded?.address ?? null;
}

export function usePrivyEmbeddedAddressReal(): `0x${string}` | null {
  const { authenticated, user, ready } = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();

  // Auto-create embedded wallet exactly once per authenticated session
  // when no embedded EVM wallet is linked. Privy's createOnLogin: 'users-
  // without-wallets' should handle this automatically, but some Google
  // login flows silently skip it — this belt-and-braces catches those.
  const autoCreatedRef = useRef(false);
  useEffect(() => {
    if (!ready || !authenticated || autoCreatedRef.current) return;
    const walletFromHook = wallets?.find((w) => w.walletClientType === 'privy');
    const walletFromLinked = findEmbeddedFromLinkedAccounts(
      user?.linkedAccounts as unknown as LinkedAccountLike[],
    );
    if (walletFromHook || walletFromLinked) return;
    autoCreatedRef.current = true;
    createWallet().catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[privy] auto-create embedded wallet failed', e);
    });
  }, [ready, authenticated, wallets, user, createWallet]);

  if (!authenticated) return null;

  // 1. useWallets — preferred (has walletClientType for disambiguation).
  const fromWallets = wallets?.find((w) => w.walletClientType === 'privy') ?? wallets?.[0];
  if (fromWallets?.address) return fromWallets.address as `0x${string}`;

  // 2. Fallback to linked accounts on the user object.
  const fromLinked = findEmbeddedFromLinkedAccounts(
    user?.linkedAccounts as unknown as LinkedAccountLike[],
  );
  if (fromLinked && /^0x[a-fA-F0-9]{40}$/.test(fromLinked)) {
    return fromLinked as `0x${string}`;
  }

  return null;
}
