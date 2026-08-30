/**
 * Deposit POST-action handlers for the sui/community-pool route.
 *
 * Extracted from route.ts on 2026-08-10.
 */
import { NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { getSuiUsdcPoolService } from '@/lib/services/sui/SuiCommunityPoolService';
import { getBluefinAggregatorService, type PoolAsset } from '@/lib/services/sui/BluefinAggregatorService';
import { withWalletLock } from './wallet-lock';
import type { ActionCtx } from './types';

export async function handleDeposit(ctx: ActionCtx): Promise<NextResponse> {
  const { network, body } = ctx;
  const amount = body.amount;
  if (!amount) {
    return NextResponse.json({ success: false, error: 'Amount required (in MIST or SUI)' }, { status: 400 });
  }

  // CRITICAL: validate positive amount to prevent negative-value attacks.
  // BigInt() throws on invalid input; catch → 400 not 500.
  let amountRaw: bigint;
  try {
    amountRaw = BigInt(amount as string | number | bigint);
  } catch {
    return NextResponse.json({ success: false, error: 'Amount must be an integer (USDC base units)' }, { status: 400 });
  }
  if (amountRaw <= 0n) {
    return NextResponse.json({ success: false, error: 'Amount must be positive' }, { status: 400 });
  }
  const MAX_DEPOSIT_RAW = 1_000_000_000_000_000n; // 1B USDC * 10^6
  if (amountRaw > MAX_DEPOSIT_RAW) {
    return NextResponse.json({ success: false, error: 'Amount exceeds maximum deposit (1B USDC)' }, { status: 400 });
  }

  const service = getSuiUsdcPoolService(network);
  await service.getPoolStats();

  const amountUsdc = Number(amountRaw) / 1_000_000;
  const params = service.buildDepositParams(amountUsdc);
  service.clearCaches();

  return NextResponse.json({
    success: true,
    data: {
      target: params.target,
      poolStateId: params.poolStateId,
      amountRaw: params.amountRaw.toString(),
      clockId: params.clockId,
      usdcCoinType: params.usdcCoinType,
      typeArg: params.typeArg,
    },
    chain: 'sui',
    network,
  });
}

export async function handleExecuteDepositSwaps(ctx: ActionCtx): Promise<NextResponse> {
  const { request, network, body } = ctx;
  const authResult = await verifyCronRequest(request, 'SUI execute-deposit-swaps');
  if (authResult !== true) {
    return NextResponse.json({ success: false, error: 'Unauthorized — admin operation requires authentication' }, { status: 401 });
  }

  const amountUsdc = body.amountUsdc;
  const allocations = body.allocations;

  if (!amountUsdc || typeof amountUsdc !== 'number' || amountUsdc <= 0) {
    return NextResponse.json({ success: false, error: 'amountUsdc required (positive number)' }, { status: 400 });
  }
  if (!allocations || typeof allocations !== 'object') {
    return NextResponse.json({ success: false, error: 'allocations required (e.g. { BTC: 30, ETH: 30, SUI: 25, CRO: 15 })' }, { status: 400 });
  }

  const aggregator = getBluefinAggregatorService(network);

  const wallet = await aggregator.checkAdminWallet();
  if (!wallet.configured || !wallet.hasGas) {
    return NextResponse.json({ success: false, error: 'Admin wallet not configured or insufficient gas' }, { status: 503 });
  }

  const plan = await aggregator.planRebalanceSwaps(amountUsdc, allocations as Record<PoolAsset, number>);
  const onChainSwaps = plan.swaps.filter(s => s.canSwapOnChain && s.routerData);
  const hedgedSwaps = plan.swaps.filter(s => !s.canSwapOnChain && s.hedgeVia === 'bluefin');

  if (onChainSwaps.length === 0 && hedgedSwaps.length === 0) {
    return NextResponse.json({
      success: false,
      data: { message: 'No on-chain swaps or hedges available for these assets', plan },
      chain: 'sui',
    }, { status: 400 });
  }

  const result = await aggregator.executeRebalance(plan, 0.01);

  logger.info('[SUI-API] Deposit swaps executed', {
    amountUsdc,
    executed: result.totalExecuted,
    failed: result.totalFailed,
    hedged: hedgedSwaps.length,
    digests: result.results.filter(r => r.txDigest).map(r => `${r.asset}:${r.txDigest}`),
  });

  return NextResponse.json({
    success: result.success,
    data: {
      executed: result.totalExecuted,
      failed: result.totalFailed,
      results: result.results.map(r => ({
        asset: r.asset,
        success: r.success,
        txDigest: r.txDigest,
        amountIn: r.amountIn,
        amountOut: r.amountOut,
        error: r.error,
      })),
    },
    chain: 'sui',
  });
}

export async function handleDryRunDepositSwaps(ctx: ActionCtx): Promise<NextResponse> {
  const { network, body } = ctx;
  const amountUsdc = body.amountUsdc;
  const allocations = body.allocations;

  if (!amountUsdc || typeof amountUsdc !== 'number' || amountUsdc <= 0) {
    return NextResponse.json({ success: false, error: 'amountUsdc required (positive number)' }, { status: 400 });
  }
  if (!allocations || typeof allocations !== 'object') {
    return NextResponse.json({ success: false, error: 'allocations required (e.g. { BTC: 30, ETH: 30, SUI: 25, CRO: 15 })' }, { status: 400 });
  }

  const aggregator = getBluefinAggregatorService(network);
  const wallet = await aggregator.checkAdminWallet();

  const plan = await aggregator.planRebalanceSwaps(amountUsdc, allocations as Record<PoolAsset, number>);
  const result = await aggregator.executeRebalance(plan, 0.01, { dryRun: true });

  return NextResponse.json({
    success: true,
    data: {
      dryRun: true,
      wallet: { configured: wallet.configured, hasGas: wallet.hasGas, address: wallet.address },
      plan: {
        totalUsdcToSwap: plan.totalUsdcToSwap,
        swaps: plan.swaps.map(s => ({
          asset: s.asset,
          amountIn: s.amountIn,
          expectedAmountOut: s.expectedAmountOut,
          canSwapOnChain: s.canSwapOnChain,
          hedgeVia: s.hedgeVia,
        })),
      },
      execution: {
        executed: result.totalExecuted,
        failed: result.totalFailed,
        results: result.results,
      },
      hedgeValidation: result.dryRunDetails || [],
    },
    chain: 'sui',
  });
}

export async function handleRecordDeposit(ctx: ActionCtx): Promise<NextResponse> {
  const { network, body } = ctx;
  const walletAddress = body.walletAddress as string | undefined;
  const amountUsdc = body.amountUsdc as number | undefined;
  const allocations = body.allocations as Record<string, number> | undefined;
  const txDigest = body.txDigest as string | undefined;

  if (!walletAddress || typeof walletAddress !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(walletAddress)) {
    return NextResponse.json({ success: false, error: 'Valid SUI wallet address required (0x + 64 hex chars)' }, { status: 400 });
  }
  if (!amountUsdc || typeof amountUsdc !== 'number' || amountUsdc <= 0) {
    return NextResponse.json({ success: false, error: 'amountUsdc required (positive number)' }, { status: 400 });
  }
  const MAX_SINGLE_DEPOSIT_USDC = 10_000_000; // $10M max per deposit
  if (amountUsdc > MAX_SINGLE_DEPOSIT_USDC) {
    return NextResponse.json({ success: false, error: `Deposit exceeds maximum ($${MAX_SINGLE_DEPOSIT_USDC.toLocaleString()} USDC)` }, { status: 400 });
  }
  if (txDigest && typeof txDigest === 'string' && !/^[A-Za-z0-9+/=]{32,64}$/.test(txDigest) && !txDigest.startsWith('usdc-deposit-')) {
    return NextResponse.json({ success: false, error: 'Invalid transaction digest format' }, { status: 400 });
  }

  const service = getSuiUsdcPoolService(network);
  const { getUserSharesFromDb, saveUserSharesToDb, addPoolTransactionToDb, txHashExists } = await import('@/lib/db/community-pool');

  if (txDigest) {
    const alreadyRecorded = await txHashExists(txDigest);
    if (alreadyRecorded) {
      const existingShares = await getUserSharesFromDb(walletAddress, 'sui');
      return NextResponse.json({
        success: true,
        data: {
          walletAddress,
          amountUsdc,
          sharesMinted: 0,
          totalShares: existingShares?.shares || 0,
          message: 'Transaction already recorded (idempotent)',
        },
        chain: 'sui',
        network,
      });
    }
  }

  const isOnChainDeposit = !!txDigest && !txDigest.startsWith('usdc-deposit-');

  return withWalletLock(walletAddress, async () => {
    let swapResult = { totalExecuted: 0, totalFailed: 0, results: [] as Array<{ asset: string; success: boolean; txDigest?: string; amountIn?: string; amountOut?: string; error?: string }> };
    const hedgeResults: Array<{ asset: string; success: boolean; hedgeId?: string; method: string; error?: string }> = [];

    if (!isOnChainDeposit && allocations && typeof allocations === 'object') {
      const aggregator = getBluefinAggregatorService(network);
      const wallet = await aggregator.checkAdminWallet();

      if (wallet.configured && wallet.hasGas) {
        let finalAllocations = allocations as Record<PoolAsset, number>;
        const isStaticDefault = allocations.BTC === 30 && allocations.ETH === 30 && allocations.SUI === 25 && allocations.CRO === 15;
        if (isStaticDefault) {
          try {
            const { getSuiPoolAgent } = await import('@/agents/specialized/SuiPoolAgent');
            const agent = getSuiPoolAgent(network);
            const indicators = await agent.analyzeMarket();
            const decision = agent.generateAllocation(indicators);
            finalAllocations = decision.allocations;
          } catch {
            // Keep static allocation on failure
          }
        }

        const plan = await aggregator.planRebalanceSwaps(amountUsdc, finalAllocations);
        swapResult = await aggregator.executeRebalance(plan, 0.01);
      } else {
        logger.info('[SUI-API] Admin wallet not configured — deposit recorded to DB only (on-chain deposit handled by user wallet)');
      }
    } else if (isOnChainDeposit) {
      logger.info('[SUI-API] On-chain deposit detected, skipping server-side swaps', { txDigest });
    }

    const sharesToMint = amountUsdc;
    let newTotalShares = sharesToMint;
    let newCostBasis = amountUsdc;
    let onChainVerified = false;
    // Actual share price at the moment of the deposit — used to log a
    // truthful sharePrice in community_pool_transactions. Prior code
    // hard-coded 1.0 which was only true at pool inception. Falls back
    // to 1.0 if the pool stats read fails (same fallback as the
    // rest of this handler).
    let sharePrice = 1.0;

    try {
      service.clearCaches();
      if (isOnChainDeposit) {
        await new Promise(r => setTimeout(r, 2000));
      }
      const [onChainPos, stats] = await Promise.all([
        service.getMemberPosition(walletAddress),
        service.getPoolStats(),
      ]);
      if (stats?.sharePrice && stats.sharePrice > 0) sharePrice = stats.sharePrice;
      if (onChainPos.isMember && onChainPos.shares > 0) {
        newTotalShares = onChainPos.shares;
        // Cost basis in USD: previous entries at their entry prices +
        // this deposit at its USD amount. Prior code overwrote basis
        // with `onChainPos.shares` (treating shares as USD). If we
        // have no prior DB record, fall back to this deposit's USDC
        // amount as the basis floor.
        const existingShares = await getUserSharesFromDb(walletAddress, 'sui');
        newCostBasis = (existingShares?.cost_basis_usd || 0) + amountUsdc;
        onChainVerified = true;
      } else {
        const existingShares = await getUserSharesFromDb(walletAddress, 'sui');
        newTotalShares = (existingShares?.shares || 0) + sharesToMint;
        newCostBasis = (existingShares?.cost_basis_usd || 0) + amountUsdc;
        logger.warn('[SUI-API] On-chain member not found yet, using DB + deposit estimate', {
          wallet: walletAddress.slice(0, 10) + '...',
          estimate: newTotalShares,
        });
      }
    } catch (err) {
      logger.error('[SUI-API] On-chain read failed during deposit recording', {
        error: err instanceof Error ? err.message : err,
      });
      const existingShares = await getUserSharesFromDb(walletAddress, 'sui');
      newTotalShares = (existingShares?.shares || 0) + sharesToMint;
      newCostBasis = (existingShares?.cost_basis_usd || 0) + amountUsdc;
    }

    if (newTotalShares < 0 || newTotalShares > MAX_SINGLE_DEPOSIT_USDC * 100) {
      logger.error('[SUI-API] SANITY CHECK FAILED on deposit shares', {
        newTotalShares, walletAddress: walletAddress.slice(0, 10) + '...',
      });
      return NextResponse.json({ success: false, error: 'Calculated shares failed sanity check — please retry' }, { status: 500 });
    }

    await saveUserSharesToDb({
      walletAddress,
      shares: newTotalShares,
      costBasisUSD: newCostBasis,
      chain: 'sui',
    });

    await addPoolTransactionToDb({
      id: `sui-deposit-${Date.now()}-${walletAddress.slice(-8)}`,
      type: 'DEPOSIT',
      walletAddress,
      amountUSD: amountUsdc,
      shares: sharesToMint,
      sharePrice,
      details: {
        network,
        txDigest,
        onChainVerified,
        swapResults: swapResult.results,
        allocations,
      },
      txHash: txDigest || undefined,
    });

    logger.info('[SUI-API] USDC deposit recorded', {
      wallet: walletAddress.slice(0, 10) + '...',
      amountUsdc,
      sharesTotal: newTotalShares,
      swapsExecuted: swapResult.totalExecuted,
      hedgesAttempted: hedgeResults.length,
    });

    return NextResponse.json({
      success: true,
      data: {
        walletAddress,
        amountUsdc,
        sharesMinted: sharesToMint,
        totalShares: newTotalShares,
        swaps: {
          executed: swapResult.totalExecuted,
          failed: swapResult.totalFailed,
          results: swapResult.results,
        },
        hedges: hedgeResults.length > 0 ? hedgeResults : undefined,
      },
      chain: 'sui',
      network,
    });
  });
}
