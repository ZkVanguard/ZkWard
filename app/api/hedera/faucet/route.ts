/**
 * Hedera testnet USDC faucet.
 *
 * Mints a small fixed amount of test USDC (MockERC20 at
 * HEDERA_CONTRACT_ADDRESSES.testnet.usdtToken) to the requested EVM
 * address, using the operator key held server-side. This lets any Privy
 * user sign in, land on the Hedera pool tab, and immediately have USDC
 * to deposit — without the operator manually funding each demo user.
 *
 * Per-address throttle (in-process): one drip per address per hour.
 * Amount cap: 100 USDC per drip. Both are conservative for a testnet demo.
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
      nextDripAt: new Date(now + THROTTLE_MS).toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('[hedera-faucet] mint failed', { to, error: msg });
    return NextResponse.json({ error: `mint failed: ${msg.slice(0, 200)}` }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    faucet: 'hedera-testnet-usdc',
    token: HEDERA_CONTRACT_ADDRESSES.testnet.usdtToken,
    dripAmount: DRIP_HUMAN_USDC,
    dripCurrency: 'USDC',
    throttle: '1 drip per address per hour',
    method: 'POST',
    body: { address: '0x…40-hex' },
  });
}
