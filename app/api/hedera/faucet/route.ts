/**
 * Hedera testnet USDC + HBAR faucet.
 *
 * Two-stage drip:
 *   1. If the target has < HBAR_MIN_TINYBAR, send HBAR_DRIP_TINYBAR of HBAR
 *      first. On Hedera an EVM-only address stays "Inactive" (no underlying
 *      account, contract calls revert) until it receives HBAR — Privy embedded
 *      wallets ship with 0 HBAR, so every new demo user hits this. Auto-funding
 *      unblocks the deposit flow without operator hand-holding.
 *   2. Mint DRIP_HUMAN_USDC of the MockERC20 test USDC.
 *
 * Per-address throttle (in-process): one drip per address per hour.
 * Amount caps: DRIP_HUMAN_USDC USDC + HBAR_DRIP_TINYBAR HBAR per drip.
 *
 * Body: { address: '0x...' }
 * Auth: none (rate-limited by IP + address, testnet mints only).
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { readLimiter } from '@/lib/security/rate-limiter';
import { HEDERA_CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const DRIP_HUMAN_USDC = 100;
const USDC_DECIMALS = 6;
const THROTTLE_MS = 60 * 60 * 1000; // 1 drip per address per hour

// HBAR activation: threshold is ~0.5 HBAR; below it we top up by 1 HBAR.
// 1 HBAR covers hundreds of small contract calls at Hashio's gas prices.
const HBAR_MIN_WEI = 500_000_000_000_000_000n; // 0.5 HBAR in 18-dec wei
const HBAR_DRIP_WEI = 1_000_000_000_000_000_000n; // 1 HBAR

// In-process throttle. Vercel serverless instances aren't shared, so a
// determined user can drip a few times by hitting different instances,
// but that's testnet-only value — good enough guard for a demo.
const lastDrip = new Map<string, number>();

interface FaucetBody {
  address?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = readLimiter.check(request);
  if (limited) return limited;

  let body: FaucetBody;
  try {
    body = (await request.json()) as FaucetBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const to = (body.address ?? '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(to)) {
    return NextResponse.json({ error: 'address must be a 0x… 40-hex EVM address' }, { status: 400 });
  }

  // Throttle check
  const now = Date.now();
  const last = lastDrip.get(to);
  if (last && now - last < THROTTLE_MS) {
    const waitSecs = Math.ceil((THROTTLE_MS - (now - last)) / 1000);
    return NextResponse.json(
      { error: `throttled — try again in ${Math.ceil(waitSecs / 60)} min` },
      { status: 429 },
    );
  }

  const operatorKey = (process.env.HEDERA_OPERATOR_KEY || '').trim();
  if (!operatorKey) {
    return NextResponse.json({ error: 'faucet not configured (server)' }, { status: 503 });
  }

  const usdc = HEDERA_CONTRACT_ADDRESSES.testnet.usdtToken;
  const rpcUrl = (process.env.HEDERA_TESTNET_RPC_URL || 'https://testnet.hashio.io/api').trim();

  try {
    // ethers is already a dep. Lazy-import so this route stays cold-start-cheap.
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(operatorKey, provider);

    // ─── Stage 1: HBAR activation ─────────────────────────────────
    // On Hedera, an EVM-only address is "Inactive" until it receives HBAR.
    // Contract calls from an inactive address revert (no gas debit possible).
    let hbarTxHash: string | undefined;
    let hbarBalanceWeiBefore = 0n;
    try {
      hbarBalanceWeiBefore = await provider.getBalance(to);
    } catch (e) {
      logger.warn('[hedera-faucet] hbar balance read failed', {
        to, error: e instanceof Error ? e.message : String(e),
      });
    }

    if (hbarBalanceWeiBefore < HBAR_MIN_WEI) {
      const hbarTx = await wallet.sendTransaction({
        to,
        value: HBAR_DRIP_WEI,
        gasLimit: 800_000, // account-creation on Hedera burns ~600k
        maxFeePerGas: ethers.parseUnits('20000', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
        type: 2,
      });
      const hbarReceipt = await hbarTx.wait(1);
      hbarTxHash = hbarReceipt?.hash;
      logger.info('[hedera-faucet] hbar activation', {
        to, amountHbar: '1', txHash: hbarTxHash,
      });
    }

    // ─── Stage 2: USDC mint ───────────────────────────────────────
    // MockERC20 exposes public mint(address to, uint256 amount).
    const abi = ['function mint(address to, uint256 amount) external'];
    const token = new ethers.Contract(usdc, abi, wallet);
    const amount = ethers.parseUnits(String(DRIP_HUMAN_USDC), USDC_DECIMALS);

    // Hedera EVM needs generous fee overrides — Hashio simulator rejects
    // otherwise. Same numbers we used at deploy time in
    // scripts/deploy/deploy-hedera-usdc-full.cjs.
    const tx = await token.mint(to, amount, {
      gasLimit: 200_000,
      maxFeePerGas: ethers.parseUnits('20000', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      type: 2,
    });
    const receipt = await tx.wait(1);
    lastDrip.set(to, now);

    logger.info('[hedera-faucet] minted', {
      to, amount: DRIP_HUMAN_USDC, txHash: receipt?.hash,
    });

    return NextResponse.json({
      ok: true,
      to,
      amount: DRIP_HUMAN_USDC,
      currency: 'USDC',
      txHash: receipt?.hash,
      explorerUrl: `https://hashscan.io/testnet/transaction/${receipt?.hash}`,
      hbarActivation: hbarTxHash
        ? {
            sent: true,
            amountHbar: 1,
            txHash: hbarTxHash,
            explorerUrl: `https://hashscan.io/testnet/transaction/${hbarTxHash}`,
            reason: 'target had < 0.5 HBAR — inactive account activated',
          }
        : { sent: false, reason: 'target already had sufficient HBAR' },
      nextDripAt: new Date(now + THROTTLE_MS).toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('[hedera-faucet] drip failed', { to, error: msg });
    return NextResponse.json({ error: `drip failed: ${msg.slice(0, 200)}` }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    faucet: 'hedera-testnet-usdc',
    token: HEDERA_CONTRACT_ADDRESSES.testnet.usdtToken,
    drip: {
      usdc: DRIP_HUMAN_USDC,
      hbar: 1,
      hbarNote: 'auto-sent when target balance < 0.5 HBAR to activate the account',
    },
    throttle: '1 drip per address per hour',
    method: 'POST',
    body: { address: '0x…40-hex' },
  });
}
