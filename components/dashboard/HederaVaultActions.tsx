'use client';

/**
 * HederaVaultActions — deposit / withdraw for the SimpleUsdcVault on
 * Hedera Testnet. Standalone from the SUI/Cronos DepositWithdrawActions
 * because that component's logic is welded to WDK + permit + smart-account
 * flows that Hedera doesn't need.
 *
 * Flow
 *   Deposit:  approve(usdc, pool, amount) → deposit(amount)
 *   Withdraw: withdraw(shares)
 *
 * Wallet: whatever wagmi's useAccount returns. Privy's WagmiProvider
 * transparently proxies the embedded wallet's signer, so this works
 * with both email/Google Privy users AND MetaMask/injected users.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseUnits, formatUnits, erc20Abi } from 'viem';
import {
  useAccount,
  useChainId,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
} from 'wagmi';
import { Plus, Minus, Loader2, Check, ExternalLink, AlertTriangle, Wallet, Droplets } from 'lucide-react';
import { HEDERA_CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';
import { hederaTestnet } from '@/lib/evm-wallet/wagmi-config';

const HEDERA_TESTNET_ID = 296;
const USDC_DECIMALS = 6;
const HEDERA_ACCENT = '#00A79F';
const ACCENT = '#0069D9';

// SimpleUsdcVault ABI subset — deposit / withdraw / read helpers only.
const VAULT_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    name: 'sharesOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'totalShares',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'totalAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

interface Props {
  /** Address override (Privy embedded wallet) — overrides wagmi useAccount */
  address?: `0x${string}`;
  onRefresh?: () => void;
}

function truncate(v: string): string {
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

export function HederaVaultActions({ address: propAddress, onRefresh }: Props) {
  const { address: wagmiAddress } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const address = (propAddress ?? wagmiAddress) as `0x${string}` | undefined;

  const usdc = HEDERA_CONTRACT_ADDRESSES.testnet.usdtToken as `0x${string}`;
  const vault = HEDERA_CONTRACT_ADDRESSES.testnet.communityPool as `0x${string}`;

  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<'idle' | 'switching' | 'approving' | 'depositing' | 'withdrawing' | 'complete' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pendingHash, setPendingHash] = useState<`0x${string}` | null>(null);
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [faucetTx, setFaucetTx] = useState<string | null>(null);

  // ─── Reads ─────────────────────────────────────────────────────────────
  const { data: usdcBalance, refetch: refetchBalance } = useReadContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { data: userShares, refetch: refetchShares } = useReadContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: 'sharesOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { data: totalShares } = useReadContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: 'totalShares',
    query: { enabled: true },
  });

  const { data: totalAssets } = useReadContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: 'totalAssets',
    query: { enabled: true },
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, vault] : undefined,
    query: { enabled: !!address },
  });

  // ─── Writes ─────────────────────────────────────────────────────────────
  const { writeContractAsync } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: pendingHash ?? undefined,
  });

  // Refresh reads + parent when a tx confirms.
  useEffect(() => {
    if (!isConfirmed || !pendingHash) return;
    refetchBalance();
    refetchShares();
    refetchAllowance();
    onRefresh?.();
    setStatus('complete');
    setAmount('');
    setPendingHash(null);
    const t = setTimeout(() => setStatus('idle'), 3000);
    return () => clearTimeout(t);
  }, [isConfirmed, pendingHash, refetchBalance, refetchShares, refetchAllowance, onRefresh]);

  // ─── Actions ───────────────────────────────────────────────────────────
  const ensureHederaChain = useCallback(async (): Promise<boolean> => {
    if (chainId === HEDERA_TESTNET_ID) return true;
    setStatus('switching');
    try {
      await switchChainAsync({ chainId: HEDERA_TESTNET_ID });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
      return false;
    }
  }, [chainId, switchChainAsync]);

  const onDeposit = useCallback(async () => {
    setError(null);
    if (!address) { setError('Sign in first.'); return; }
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) { setError('Enter an amount.'); return; }

    const okChain = await ensureHederaChain();
    if (!okChain) return;

    const amountWei = parseUnits(amount, USDC_DECIMALS);
    const need = amountWei;
    const have = (allowance as bigint | undefined) ?? 0n;

    try {
      // Approve first if allowance is short. Approve for exact `need`
      // rather than max so the user sees a specific number in the wallet
      // prompt (matches ERC-20 best practice + reduces exploit surface
      // if the vault is ever compromised).
      if (have < need) {
        setStatus('approving');
        const approveHash = await writeContractAsync({
          address: usdc,
          abi: erc20Abi,
          functionName: 'approve',
          args: [vault, need],
          chainId: HEDERA_TESTNET_ID,
        });
        setPendingHash(approveHash);
        // Wait for approve tx receipt before deposit — otherwise deposit
        // will revert with allowance shortfall. We can't chain the two
        // in one tx (would need Permit which MockERC20 doesn't support).
        // The effect below will fire when isConfirmed → we manually
        // fall through to deposit here after waiting inline.
        await waitForTx(approveHash);
        await refetchAllowance();
      }

      setStatus('depositing');
      const depositHash = await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: 'deposit',
        args: [amountWei],
        chainId: HEDERA_TESTNET_ID,
      });
      setPendingHash(depositHash);
    } catch (e) {
      setError(shortErr(e));
      setStatus('error');
      setPendingHash(null);
    }
  }, [address, amount, allowance, ensureHederaChain, usdc, vault, writeContractAsync, refetchAllowance]);

  const onWithdraw = useCallback(async () => {
    setError(null);
    if (!address) { setError('Sign in first.'); return; }
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) { setError('Enter shares to burn.'); return; }

    const okChain = await ensureHederaChain();
    if (!okChain) return;

    // Shares are 18 decimals in SimpleUsdcVault (matches ERC-20 default).
    const sharesWei = parseUnits(amount, 18);
    try {
      setStatus('withdrawing');
      const hash = await writeContractAsync({
        address: vault,
        abi: VAULT_ABI,
        functionName: 'withdraw',
        args: [sharesWei],
        chainId: HEDERA_TESTNET_ID,
      });
      setPendingHash(hash);
    } catch (e) {
      setError(shortErr(e));
      setStatus('error');
    }
  }, [address, amount, ensureHederaChain, vault, writeContractAsync]);

  const onFaucet = useCallback(async () => {
    if (!address) return;
    setFaucetLoading(true);
    setError(null);
    setFaucetTx(null);
    try {
      const r = await fetch('/api/hedera/faucet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      const j = (await r.json()) as { ok?: boolean; txHash?: string; error?: string };
      if (!r.ok || !j.ok) {
        setError(j.error ?? `faucet HTTP ${r.status}`);
      } else if (j.txHash) {
        setFaucetTx(j.txHash);
        // Wait a beat for mirror indexer then refresh balance.
        await new Promise((res) => setTimeout(res, 1500));
        await refetchBalance();
      }
    } catch (e) {
      setError(shortErr(e));
    } finally {
      setFaucetLoading(false);
    }
  }, [address, refetchBalance]);

  // ─── Derived ────────────────────────────────────────────────────────────
  const humanUsdcBalance = usdcBalance
    ? Number(formatUnits(usdcBalance as bigint, USDC_DECIMALS))
    : 0;
  const humanShares = userShares ? Number(formatUnits(userShares as bigint, 18)) : 0;
  const humanTotalAssets = totalAssets
    ? Number(formatUnits(totalAssets as bigint, USDC_DECIMALS))
    : 0;
  const humanTotalShares = totalShares ? Number(formatUnits(totalShares as bigint, 18)) : 0;
  const sharePrice = humanTotalShares > 0
    ? (humanTotalAssets + 1e-6) / (humanTotalShares + 1e-18)
    : 1;
  const userValueUsdc = humanShares * sharePrice;

  const explorer = pendingHash
    ? `https://hashscan.io/testnet/transaction/${pendingHash}`
    : null;

  const chainMismatch = address && chainId !== HEDERA_TESTNET_ID && status === 'idle';

  return (
    <div className="p-4 border-b border-gray-100 dark:border-gray-700 space-y-3">
      {/* Balance chips */}
      <div className="flex flex-wrap gap-2 text-[12px]">
        {address ? (
          <>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-system-bg-secondary">
              <Wallet className="w-3 h-3" />
              <span className="tabular-nums">{truncate(address)}</span>
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full" style={{ background: `${HEDERA_ACCENT}15`, color: HEDERA_ACCENT }}>
              <span className="tabular-nums font-semibold">{humanUsdcBalance.toFixed(2)} USDC</span>
            </span>
            {humanUsdcBalance < 1 && (
              <button
                onClick={onFaucet}
                disabled={faucetLoading}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-[#0069D9]/10 text-[#0069D9] font-semibold hover:bg-[#0069D9]/15 active:scale-[0.98] disabled:opacity-60"
                title="Mint 100 test USDC to your wallet (testnet faucet)"
              >
                {faucetLoading ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Droplets className="w-3 h-3" />
                )}
                Faucet 100 USDC
              </button>
            )}
            {faucetTx && (
              <a
                href={`https://hashscan.io/testnet/transaction/${faucetTx}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-[#34C759]/10 text-[#34C759] font-semibold hover:bg-[#34C759]/15"
              >
                <Check className="w-3 h-3" />
                Minted <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {humanShares > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-[#34C759]/10 text-[#34C759] font-semibold">
                <span className="tabular-nums">{humanShares.toFixed(4)} shares</span>
                <span className="opacity-70">· ${userValueUsdc.toFixed(2)}</span>
              </span>
            )}
          </>
        ) : (
          <span className="text-label-tertiary">Sign in to see balance.</span>
        )}
      </div>

      {chainMismatch && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-[#FF9500]/10 border border-[#FF9500]/30">
          <AlertTriangle className="w-4 h-4 text-[#FF9500] flex-shrink-0" />
          <span className="text-[12px] text-[#B26400]">
            Your wallet is on chain {chainId}. Click Deposit/Withdraw and we&apos;ll switch to Hedera Testnet (296).
          </span>
        </div>
      )}

      {/* Mode toggle */}
      <div className="inline-flex rounded-[10px] bg-system-bg-secondary p-0.5">
        <button
          onClick={() => setMode('deposit')}
          className={`px-3 py-1.5 rounded-[8px] text-[12px] font-semibold transition-all ${
            mode === 'deposit' ? 'bg-white shadow-ios-1 text-label-primary' : 'text-label-tertiary'
          }`}
        >
          <Plus className="inline w-3 h-3 mr-1" />
          Deposit
        </button>
        <button
          onClick={() => setMode('withdraw')}
          className={`px-3 py-1.5 rounded-[8px] text-[12px] font-semibold transition-all ${
            mode === 'withdraw' ? 'bg-white shadow-ios-1 text-label-primary' : 'text-label-tertiary'
          }`}
        >
          <Minus className="inline w-3 h-3 mr-1" />
          Withdraw
        </button>
      </div>

      {/* Amount + action */}
      <div className="flex gap-2">
        <input
          type="number"
          inputMode="decimal"
          step="any"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={mode === 'deposit' ? 'USDC amount' : `Shares (max ${humanShares.toFixed(4)})`}
          disabled={status !== 'idle' && status !== 'complete' && status !== 'error'}
          className="flex-1 h-11 px-3 rounded-[10px] border border-black/10 dark:border-white/15 bg-system-bg-secondary tabular-nums focus:outline-none"
        />
        {mode === 'withdraw' && humanShares > 0 && (
          <button
            onClick={() => setAmount(humanShares.toString())}
            className="px-3 h-11 rounded-[10px] bg-system-bg-secondary text-[12px] font-medium text-label-secondary hover:bg-[#E5E5EA] active:scale-[0.98]"
          >
            Max
          </button>
        )}
        <button
          onClick={mode === 'deposit' ? onDeposit : onWithdraw}
          disabled={
            !address ||
            !amount ||
            (status !== 'idle' && status !== 'complete' && status !== 'error') ||
            isConfirming
          }
          className="h-11 px-4 rounded-[10px] text-white font-semibold text-[13px] active:scale-[0.98] disabled:opacity-60 flex items-center gap-1.5"
          style={{ background: mode === 'deposit' ? ACCENT : '#FF3B30' }}
        >
          {(status !== 'idle' && status !== 'complete') && <Loader2 className="w-4 h-4 animate-spin" />}
          {status === 'complete' && <Check className="w-4 h-4" />}
          {status === 'idle' && <>{mode === 'deposit' ? 'Deposit' : 'Withdraw'}</>}
          {status === 'switching' && 'Switching…'}
          {status === 'approving' && 'Approving…'}
          {status === 'depositing' && 'Depositing…'}
          {status === 'withdrawing' && 'Withdrawing…'}
          {status === 'complete' && 'Done'}
          {status === 'error' && 'Retry'}
        </button>
      </div>

      {/* Status + tx link */}
      <div className="text-[11px] text-label-tertiary flex flex-wrap gap-x-2 gap-y-1">
        <span>
          Share price: <span className="tabular-nums font-medium text-label-secondary">${sharePrice.toFixed(6)} USDC</span>
        </span>
        <span>·</span>
        <span>
          Pool TVL: <span className="tabular-nums font-medium text-label-secondary">${humanTotalAssets.toFixed(2)}</span>
        </span>
        {explorer && (
          <a href={explorer} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-[#0069D9] hover:underline">
            View tx <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      {error && (
        <div className="text-[11px] text-[#FF3B30] break-words">{error}</div>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function shortErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // wagmi's error messages are verbose; keep the first line for the toast.
  return msg.split('\n')[0].slice(0, 200);
}

async function waitForTx(hash: `0x${string}`, maxWaitMs = 30_000): Promise<void> {
  // Lightweight polling receipt-wait — dedicated to the inline approve→deposit
  // chain. Uses Hashio public RPC directly to avoid pulling in a whole ethers
  // provider just for one call.
  const url = 'https://testnet.hashio.io/api';
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [hash],
        }),
      });
      const j = (await r.json()) as { result?: { status?: string } | null };
      if (j.result && j.result.status === '0x1') return;
      if (j.result && j.result.status === '0x0') throw new Error('approve reverted');
    } catch { /* poll again */ }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('approve tx timed out');
}
