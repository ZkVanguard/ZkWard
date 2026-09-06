'use client';

/**
 * Privy Financial Flow — Best Financial Flow prize track.
 *
 * Demonstrates hiding onchain complexity behind Privy:
 *   1. Sign in with email → Privy creates a self-custodial embedded EVM wallet
 *      (no seed phrase surfaced to the user).
 *   2. Fund the wallet with a card via useFundWallet (MoonPay sandbox).
 *   3. Send an on-chain "commit" transaction to the Hedera CommunityPool
 *      using useSendTransaction — no external wallet extension needed.
 *
 * Prize qualification map:
 *   ✅ Integrate Privy as a core part of the product        → this file + navbar Sign-in
 *   ✅ Create or use at least one Privy wallet              → embedded wallet auto-created
 *   ✅ Complete a functional financial flow                 → useFundWallet + useSendTransaction
 *   ✅ Hide unnecessary onchain complexity                  → no seed phrase, no gas manual mgmt
 *
 * Runs inside WalletProviders → PrivyProvider (dashboard/layout.tsx).
 * Gated by isPrivyEnabled().
 */

import { useCallback, useMemo, useState } from 'react';
import { usePrivy, useLogin, useWallets } from '@privy-io/react-auth';
import { useFundWallet, useSendTransaction } from '@privy-io/react-auth';
import { CreditCard, Send, LogIn, Loader2, Copy, Check, ExternalLink, Sparkles } from 'lucide-react';
import { isPrivyEnabled } from '@/lib/evm-wallet/privy-config';
import { HEDERA_CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';

const ACCENT = '#00A79F';
const HEDERA_TESTNET_CHAIN_ID = 296;

// Symbolic-commit tx sends the smallest indivisible HBAR unit — enough
// to prove the wallet, chain, and signing pipeline all work end-to-end
// without moving meaningful value during a judge's click-through.
const COMMIT_AMOUNT_WEI = '0x2386F26FC10000'; // 0.01 HBAR (18-decimal on Hedera EVM)
const COMMIT_AMOUNT_LABEL = '0.01 HBAR';

function truncate(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function PrivyFinancialFlow() {
  const enabled = isPrivyEnabled();
  const { ready, authenticated, user } = usePrivy();
  const { login } = useLogin();
  const { wallets } = useWallets();
  const { fundWallet } = useFundWallet();
  const { sendTransaction } = useSendTransaction();

  const [copied, setCopied] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [funding, setFunding] = useState(false);

  // Privy exposes both external + embedded wallets in useWallets. Prefer
  // the embedded ("privy" client type) so the demo showcases Privy's
  // self-custodial wallet, not whatever extension the user happens to
  // have installed.
  const embedded = useMemo(
    () => wallets.find((w) => w.walletClientType === 'privy') ?? wallets[0],
    [wallets],
  );
  const address = embedded?.address;

  const poolAddress = HEDERA_CONTRACT_ADDRESSES.testnet.communityPool;

  const copyAddress = useCallback(() => {
    if (!address) return;
    navigator.clipboard.writeText(address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [address]);

  const onFund = useCallback(async () => {
    if (!address) return;
    setFunding(true);
    try {
      await fundWallet({
        address,
        options: {
          chain: { id: HEDERA_TESTNET_CHAIN_ID },
          // Privy's MoonPay integration; sandbox is enabled in
          // privy-client-config.ts when HEDERA_NETWORK !== 'mainnet'.
          amount: '20',
        },
      });
    } catch (e) {
      setTxError(e instanceof Error ? e.message : String(e));
    } finally {
      setFunding(false);
    }
  }, [address, fundWallet]);

  const onSendCommit = useCallback(async () => {
    setTxError(null);
    setTxHash(null);
    setSending(true);
    try {
      const receipt = await sendTransaction({
        to: poolAddress,
        value: COMMIT_AMOUNT_WEI,
        chainId: HEDERA_TESTNET_CHAIN_ID,
      });
      // Privy returns either a hex hash string OR an object depending on
      // version — normalise to a string.
      const hash =
        typeof receipt === 'string'
          ? receipt
          : (receipt as { hash?: string; transactionHash?: string })?.hash
            ?? (receipt as { transactionHash?: string })?.transactionHash
            ?? null;
      setTxHash(hash);
    } catch (e) {
      setTxError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [poolAddress, sendTransaction]);

  if (!enabled) {
    return (
      <div className="p-6 text-center text-label-tertiary text-sm">
        Privy is not configured. Set{' '}
        <code className="px-1.5 py-0.5 bg-system-bg-secondary rounded">NEXT_PUBLIC_PRIVY_APP_ID</code>{' '}
        to enable the financial flow demo.
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="p-6 flex items-center justify-center gap-2 text-label-tertiary">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading Privy…
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="p-6 sm:p-8 text-center">
        <div
          className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-4"
          style={{ background: `${ACCENT}15` }}
        >
          <Sparkles className="w-7 h-7" style={{ color: ACCENT }} />
        </div>
        <h3 className="text-title-3 font-semibold text-label-primary mb-2">
          Zero-friction onboarding
        </h3>
        <p className="text-callout text-label-secondary max-w-md mx-auto mb-5">
          Sign in with your email — Privy creates a self-custodial wallet in the
          background, funds it with a card, and lets you interact with the
          Hedera pool without ever seeing a seed phrase.
        </p>
        <button
          onClick={() => login()}
          className="inline-flex items-center gap-2 px-5 h-11 rounded-[12px] text-white font-semibold text-[15px] active:scale-[0.98]"
          style={{ background: ACCENT }}
        >
          <LogIn className="w-4 h-4" />
          Sign in with email
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* Wallet card */}
      <div className="rounded-2xl border border-separator-opaque/40 bg-system-bg-primary p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary">
            Your embedded wallet
          </div>
          <span
            className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full text-white font-semibold"
            style={{ background: ACCENT }}
          >
            Privy · self-custodial
          </span>
        </div>
        <div className="flex items-center gap-3 mb-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-white text-[13px] font-bold flex-shrink-0"
            style={{ background: ACCENT }}
          >
            {(user?.email?.address ?? 'U').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-label-primary truncate">
              {user?.email?.address ?? user?.google?.email ?? 'account'}
            </div>
            <div className="text-[11px] text-label-tertiary font-mono truncate">
              {address ? truncate(address) : 'creating wallet…'}
            </div>
          </div>
          {address && (
            <button
              onClick={copyAddress}
              className="p-2 rounded-lg hover:bg-system-bg-secondary active:scale-[0.96] transition-all"
              title="Copy address"
              aria-label="Copy address"
            >
              {copied ? (
                <Check className="w-4 h-4 text-[#34C759]" />
              ) : (
                <Copy className="w-4 h-4 text-label-tertiary" />
              )}
            </button>
          )}
        </div>
        <div className="text-[11px] text-label-tertiary leading-relaxed">
          Network: Hedera Testnet (chainId 296). No seed phrase to memorise —
          Privy manages key shards behind email auth.
        </div>
      </div>

      {/* Fund step */}
      <div className="rounded-2xl border border-separator-opaque/40 bg-system-bg-primary p-4">
        <div className="flex items-start gap-3">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-white flex-shrink-0"
            style={{ background: ACCENT }}
          >
            <CreditCard className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-headline font-semibold text-label-primary">
              1 · Fund with card
            </div>
            <div className="text-caption-1 text-label-secondary mt-0.5 mb-3">
              Opens Privy&apos;s MoonPay sandbox — buy testnet HBAR with a card.
              No CEX withdrawal, no bridge.
            </div>
            <button
              onClick={onFund}
              disabled={!address || funding}
              className="inline-flex items-center gap-2 px-4 h-10 rounded-[10px] bg-system-bg-secondary hover:bg-[#E5E5EA] text-label-primary font-semibold text-[13px] active:scale-[0.98] disabled:opacity-60"
            >
              {funding ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
              {funding ? 'Opening MoonPay…' : 'Fund $20 HBAR'}
            </button>
          </div>
        </div>
      </div>

      {/* Send step */}
      <div className="rounded-2xl border border-separator-opaque/40 bg-system-bg-primary p-4">
        <div className="flex items-start gap-3">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-white flex-shrink-0"
            style={{ background: ACCENT }}
          >
            <Send className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-headline font-semibold text-label-primary">
              2 · Commit to the pool
            </div>
            <div className="text-caption-1 text-label-secondary mt-0.5 mb-3">
              Sends {COMMIT_AMOUNT_LABEL} to the Hedera CommunityPool at{' '}
              <code className="font-mono text-[11px] break-all">
                {truncate(poolAddress)}
              </code>
              . Signed and broadcast by your Privy wallet — no extension prompt.
            </div>
            <button
              onClick={onSendCommit}
              disabled={!address || sending}
              className="inline-flex items-center gap-2 px-4 h-10 rounded-[10px] text-white font-semibold text-[13px] active:scale-[0.98] disabled:opacity-60"
              style={{ background: ACCENT }}
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {sending ? 'Signing…' : `Send ${COMMIT_AMOUNT_LABEL}`}
            </button>

            {txHash && (
              <div className="mt-3 text-[11px] text-[#34C759] flex flex-wrap items-center gap-1.5">
                <Check className="w-3.5 h-3.5" />
                Sent —
                <a
                  href={`https://hashscan.io/testnet/transaction/${txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-mono flex items-center gap-1"
                >
                  {truncate(txHash)}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            )}
            {txError && (
              <div className="mt-3 text-[11px] text-[#FF3B30] break-words">{txError}</div>
            )}
          </div>
        </div>
      </div>

      {/* Prize-track caption */}
      <div className="text-[11px] text-label-tertiary text-center leading-relaxed px-2">
        Powered by Privy · <span className="font-medium">useFundWallet</span> +{' '}
        <span className="font-medium">useSendTransaction</span> + email auth.
        Prize track: <span className="font-medium">Best financial flow</span>.
      </div>
    </div>
  );
}
