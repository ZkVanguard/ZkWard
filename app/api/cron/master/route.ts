/**
 * QStash Cron Job: Master Orchestrator
 * 
 * Chains ALL cron tasks in a single invocation:
 * 
 * 1. Community Pool snapshot & AI management (EVM)
 * 2. SUI Community Pool AI management (USDC, 4-asset)
 * 3. Pool NAV monitoring & drawdown alerts
 * 4. Auto-rebalance & loss protection
 * 5. Hedge position monitoring (stop-loss, take-profit, trailing stops)
 * 6. Liquidation guard for leveraged positions
 * 
 * Schedule: Every 5 minutes via Upstash QStash
 * 
 * Security: Verified by QStash signature or CRON_SECRET for internal calls
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { errMsg, errName } from '@/lib/utils/error-handler';

export const runtime = 'nodejs';

interface SubCronResult {
  name: string;
  success: boolean;
  duration: number;
  data?: Record<string, unknown>;
  error?: string;
}

interface MasterCronResult {
  success: boolean;
  ranAt: string;
  totalDuration: number;
  subTasks: SubCronResult[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
  };
}

/**
 * Call a sub-cron endpoint and capture result
 */
async function runSubCron(name: string, path: string, cronSecret: string): Promise<SubCronResult> {
  const start = Date.now();
  
  try {
    const baseUrl = process.env.VERCEL 
      ? 'https://zkward.com' 
      : process.env.NEXTAUTH_URL || 'http://localhost:3000';
    
    const url = `${baseUrl}${path}`;
    logger.info(`[MasterCron] Running: ${name} → ${path}`);
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000); // 25s timeout per sub-task
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cronSecret}`,
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    
    const data = await response.json().catch(() => ({ status: response.status }));
    const duration = Date.now() - start;
    
    if (response.ok) {
      logger.info(`[MasterCron] ✅ ${name} completed in ${duration}ms`);
      return { name, success: true, duration, data };
    } else {
      logger.warn(`[MasterCron] ⚠️ ${name} returned ${response.status} in ${duration}ms`);
      return { name, success: false, duration, error: `HTTP ${response.status}`, data };
    }
  } catch (error: unknown) {
    const duration = Date.now() - start;
    const errorMsg = errName(error) === 'AbortError' ? 'Timeout (25s)' : errMsg(error);
    logger.error(`[MasterCron] ❌ ${name} failed in ${duration}ms: ${errorMsg}`);
    return { name, success: false, duration, error: errorMsg };
  }
}

/**
 * GET handler — Vercel Cron entry point
 * Runs all sub-crons sequentially to stay within execution limits
 */
export async function GET(request: NextRequest): Promise<NextResponse<MasterCronResult>> {
  const startTime = Date.now();
  const ranAt = new Date().toISOString();
  
  // Security: Verify QStash signature or CRON_SECRET
  const authResult = await verifyCronRequest(request, 'MasterCron');
  if (authResult !== true) {
    return NextResponse.json(
      { 
        success: false, 
        ranAt, 
        totalDuration: Date.now() - startTime,
        subTasks: [], 
        summary: { total: 0, succeeded: 0, failed: 0 } 
      },
      { status: 401 }
    );
  }
  const cronSecret = process.env.CRON_SECRET?.trim() || '';
  
  logger.info('[MasterCron] ═══════════════════════════════════════');
  logger.info('[MasterCron] Starting master cron orchestration');
  logger.info('[MasterCron] ═══════════════════════════════════════');
  
  // Run all sub-crons sequentially (order matters — snapshot before monitor before hedge)
  const subTasks: SubCronResult[] = [];
  
  // Hourly counter (UTC) — used to gate cadence-controlled sub-crons.
  // Master runs every 5 min, so most sub-crons run every tick. The hedge-state
  // reconcile + fee-collection paths are daily/hourly; we gate them here so a
  // QStash retry storm cannot accidentally collect-fees 12× in an hour.
  const now = new Date();
  const utcMinute = now.getUTCMinutes();
  const utcHour = now.getUTCHours();
  const isTopOfHour = utcMinute < 5;       // first tick each UTC hour
  const isDailyHeartbeat = utcHour === 3 && utcMinute < 5; // ~03:05 UTC daily

  const cronJobs: Array<{ name: string; path: string }> = [
    { name: 'Pyth Price Update',      path: '/api/cron/pyth-update' },        // Update oracle prices first
    { name: 'BlueFin Health Monitor',  path: '/api/cron/bluefin-health' },     // Counter-party / venue distress probe (every 5m)
    { name: 'Community Pool Snapshot', path: '/api/cron/community-pool' },
    { name: 'SUI Community Pool',      path: '/api/cron/sui-community-pool' },
    { name: 'Hedera Community Pool',   path: '/api/cron/hedera-community-pool' },
    { name: 'Pool NAV Monitor',       path: '/api/cron/pool-nav-monitor' },
    { name: 'Auto Rebalance',         path: '/api/cron/auto-rebalance' },
    { name: 'Hedge Monitor',          path: '/api/cron/hedge-monitor' },
    { name: 'Liquidation Guard',      path: '/api/cron/liquidation-guard' },
    { name: 'Polymarket Edge Trader', path: '/api/cron/polymarket-edge-trader' }, // 5-min binary signal → BTC perp
  ];

  // Hourly: SUI on-chain hedge state ↔ live BlueFin reconciliation.
  // Repairs drift caused by external liquidations / manual closes.
  if (isTopOfHour) {
    cronJobs.push({ name: 'SUI Hedge Reconcile', path: '/api/cron/sui-hedge-reconcile' });
  }

  // Daily: Move fee-collection heartbeat — rolls forward last_fee_collection
  // so the on-chain `nav * bps * seconds` math cannot wrap u64 at scale.
  if (isDailyHeartbeat) {
    cronJobs.push({ name: 'SUI Collect Fees', path: '/api/cron/sui-collect-fees' });
  }
  
  for (const job of cronJobs) {
    const result = await runSubCron(job.name, job.path, cronSecret || '');
    subTasks.push(result);
    
    // If a critical job fails, still continue to the next one
    // (each sub-cron is independent enough to run even if a prior one failed)
  }
  
  const succeeded = subTasks.filter(t => t.success).length;
  const failed = subTasks.filter(t => !t.success).length;
  const totalDuration = Date.now() - startTime;
  
  logger.info(`[MasterCron] ═══════════════════════════════════════`);
  logger.info(`[MasterCron] Complete: ${succeeded}/${subTasks.length} succeeded in ${totalDuration}ms`);
  logger.info(`[MasterCron] ═══════════════════════════════════════`);
  
  return NextResponse.json({
    success: failed === 0,
    ranAt,
    totalDuration,
    subTasks,
    summary: {
      total: subTasks.length,
      succeeded,
      failed,
    },
  });
}

// QStash sends POST, Vercel cron sends GET — support both
export const POST = GET;

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes — enough for all sub-tasks
