'use client';

/**
 * Privy connect section — email / social / embedded-wallet flow.
 *
 * Shown by ConnectButton when Privy is enabled (NEXT_PUBLIC_PRIVY_APP_ID
 * set). Renders BEFORE EvmConnectSection so the "log in with email" CTA
 * is the primary path — matches the "hide unnecessary onchain complexity"
 * criterion of the Privy Financial Flow prize track.
 *
 * When the user isn't logged in, we show "Sign in" that pops the Privy
 * modal with all configured login methods (email, Google, wallet).
 * When logged in, we show a compact account chip with logout + copy.
 */

import { useCallback, useState } from 'react';
import { usePrivy, useLogin, useLogout, useWallets } from '@privy-io/react-auth';
import { Copy, Check, LogOut, Mail } from 'lucide-react';

const PRIVY_ACCENT = '#00A79F';

function truncate(addr: string | undefined): string {
  if (!addr) return '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function PrivyConnectSection() {
  const { ready, authenticated, user } = usePrivy();
  const { login } = useLogin();
  const { logout } = useLogout();
  const { wallets } = useWallets();
  const [showMenu, setShowMenu] = useState(false);
  const [copied, setCopied] = useState(false);

  // Prefer the embedded wallet address when present; fall back to first
  // connected external wallet. This matches how Privy's own Universal
  // Wallet API resolves the "user's primary address."
  const primary = wallets.find((w) => w.walletClientType === 'privy') ?? wallets[0];
  const address = primary?.address;

  const copyAddress = useCallback(() => {
    if (!address) return;
    navigator.clipboard.writeText(address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [address]);

  // Not yet initialized — render an inert placeholder same size as the
  // final button so the navbar layout doesn't jump on hydration.
  if (!ready) {
    return (
      <div className="h-11 px-4 rounded-[12px] bg-system-bg-secondary dark:bg-[#2c2c2e] opacity-60 flex items-center gap-2">
        <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
        <span className="text-[13px] text-label-tertiary">Loading…</span>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <button
        onClick={() => login()}
        data-connect-cta="true"
        title="Sign in with email — Privy creates a self-custodial wallet in the background"
        className="h-11 px-4 rounded-[12px] font-semibold text-[15px] text-white active:scale-[0.98] flex items-center gap-2"
        style={{ background: PRIVY_ACCENT }}
      >
        <Mail className="w-4 h-4" />
        Sign in with email
      </button>
    );
  }

  const label = user?.email?.address ?? user?.google?.email ?? truncate(address);

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu((v) => !v)}
        className="h-11 bg-system-bg-secondary dark:bg-[#2c2c2e] hover:bg-[#E5E5EA] dark:hover:bg-[#3c3c3e] border border-black/5 dark:border-white/10 rounded-[12px] flex items-center gap-2 px-3"
      >
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold"
          style={{ background: PRIVY_ACCENT }}
        >
          {(label ?? '?').charAt(0).toUpperCase()}
        </div>
        <span className="text-label-primary dark:text-white font-medium text-[13px] max-w-[140px] truncate">
          {label ?? 'account'}
        </span>
      </button>

      {showMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
          <div className="absolute top-full mt-2 right-0 w-64 bg-white dark:bg-[#1c1c1e] border border-[#E5E5EA] dark:border-[#38383a] rounded-xl shadow-lg overflow-hidden z-50">
            <div className="p-3">
              <div className="flex items-center gap-2 mb-3">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[12px] font-bold"
                  style={{ background: PRIVY_ACCENT }}
                >
                  {(label ?? '?').charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-label-primary dark:text-white truncate">
                    {label ?? 'account'}
                  </div>
                  <div className="text-[11px] text-label-tertiary font-mono truncate">
                    {truncate(address) || 'no wallet address'}
                  </div>
                </div>
              </div>

              {address && (
                <div className="flex gap-1.5 mb-2">
                  <button
                    onClick={copyAddress}
                    className="flex-1 py-1.5 bg-system-bg-secondary dark:bg-[#2c2c2e] hover:bg-[#E5E5EA] rounded-lg text-[12px] font-medium flex items-center justify-center gap-1"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-[#34C759]" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied' : 'Copy address'}
                  </button>
                </div>
              )}

              <button
                onClick={() => {
                  logout();
                  setShowMenu(false);
                }}
                className="w-full py-2 text-[#FF3B30] hover:bg-[#FF3B30]/5 rounded-lg text-[13px] font-medium flex items-center justify-center gap-1.5"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
