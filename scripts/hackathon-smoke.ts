/**
 * Hackathon smoke test — orchestrates the existing test infrastructure
 * so we get one pass/fail summary that maps to the demo pillars.
 *
 * Delegates the actual mocking to jest (which bun-test respects), the
 * contract compile to hardhat, and hits the Hedera testnet RPC + our
 * running dev server (if reachable) directly.
 *
 * Run: bun run scripts/hackathon-smoke.ts
 * Skip live RPC/dev-server: SMOKE_OFFLINE=1 bun run scripts/hackathon-smoke.ts
 */

/* eslint-disable no-console */

import { spawn } from 'child_process';

interface Result {
  pillar: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const results: Result[] = [];

async function run(pillar: string, cmd: string, args: string[], parseOutput?: (out: string) => string): Promise<void> {
  const start = Date.now();
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { shell: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { out += d.toString(); });
    p.on('close', (code) => {
      const ok = code === 0;
      const ms = Date.now() - start;
      const detail = parseOutput?.(out) ?? (ok ? 'passed' : `exit ${code}`);
      results.push({ pillar, ok, detail, ms });
      const icon = ok ? '✓' : '✗';
      console.log(`  ${icon} ${pillar}  ·  ${detail}  ·  ${ms}ms`);
      resolve();
    });
    p.on('error', (err) => {
      results.push({ pillar, ok: false, detail: err.message, ms: Date.now() - start });
      console.log(`  ✗ ${pillar}  ·  spawn failed: ${err.message}`);
      resolve();
    });
  });
}

async function httpCheck(pillar: string, url: string, opts: RequestInit = {}, validate?: (body: string) => boolean): Promise<void> {
  const start = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    const ok = res.ok && (validate ? validate(body) : true);
    results.push({ pillar, ok, detail: `HTTP ${res.status}`, ms: Date.now() - start });
    console.log(`  ${ok ? '✓' : '✗'} ${pillar}  ·  HTTP ${res.status}  ·  ${Date.now() - start}ms`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ pillar, ok: false, detail, ms: Date.now() - start });
    console.log(`  ✗ ${pillar}  ·  ${detail}`);
  }
}

function parseJestSummary(out: string): string {
  // Grab the "Tests: X passed" line jest prints on completion.
  const m = /Tests:\s+(\d+ passed(?:, \d+ (?:failed|skipped))?, \d+ total)/i.exec(out);
  return m?.[1] ?? 'no jest summary';
}

async function main(): Promise<void> {
  console.log('\n═══ ZkWard Hackathon Smoke Test ═══\n');
  const offline = process.env.SMOKE_OFFLINE === '1';

  console.log('[1] TypeScript compile');
  await run('tsc --noEmit', 'bun', ['tsc', '--noEmit']);

  console.log('\n[2] Unit tests — Hedera pillars');
  await run(
    'chain-halt (per-chain kill switches)',
    'bun', ['jest', 'test/unit/chain-halt.test.ts'],
    parseJestSummary,
  );
  await run(
    'constants (portfolio-id routing)',
    'bun', ['jest', 'test/unit/constants.test.ts'],
    parseJestSummary,
  );
  await run(
    'hedera-agent-identity (HCS-14 DID docs)',
    'bun', ['jest', 'test/unit/hedera-agent-identity.test.ts'],
    parseJestSummary,
  );
  await run(
    'x402-client-budget (pay-per-call + budget cap)',
    'bun', ['jest', 'test/unit/x402-client-budget.test.ts'],
    parseJestSummary,
  );
  await run(
    'a2a-negotiation (proposal → acceptance → settlement)',
    'bun', ['jest', 'test/unit/a2a-negotiation.test.ts'],
    parseJestSummary,
  );

  console.log('\n[3] Unit tests — The Graph pillars');
  await run(
    'subgraph-queries (client + bucketing)',
    'bun', ['jest', 'test/unit/subgraph-queries.test.ts'],
    parseJestSummary,
  );
  await run(
    'subgraph-queries-extended (hedges/txs/state/member)',
    'bun', ['jest', 'test/unit/subgraph-queries-extended.test.ts'],
    parseJestSummary,
  );
  await run(
    'cron-state-redis (Aiven-retirement backend)',
    'bun', ['jest', 'test/unit/cron-state-redis.test.ts'],
    parseJestSummary,
  );

  console.log('\n[4a] Privy — B2B admin allowlist + quorum');
  await run(
    'privy-admin-auth (fail-closed allowlist + quorum accounting)',
    'bun', ['jest', 'test/unit/privy-admin-auth.test.ts'],
    parseJestSummary,
  );

  console.log('\n[4] Cross-chain isolation guardrails');
  await run(
    'alert-response-loop (SUI-scoped Rule 1)',
    'bun', ['jest', 'test/unit/alert-response-loop.test.ts'],
    parseJestSummary,
  );
  await run(
    'safe-execution-guard-per-chain (per-chain volume buckets)',
    'bun', ['jest', 'test/unit/safe-execution-guard-per-chain.test.ts'],
    parseJestSummary,
  );

  console.log('\n[5] SUI safety gate (must stay green — mainnet product)');
  await run(
    'pool-drawdown-defense (bulletproof, 10 defense gates)',
    'bun', ['jest', 'test/integration/pool-drawdown-defense.test.ts'],
    parseJestSummary,
  );

  if (offline) {
    console.log('\n[6] Skipping live checks (SMOKE_OFFLINE=1)');
  } else {
    console.log('\n[6] Live network checks');
    await httpCheck(
      'Hedera testnet RPC reachable (chainId 296)',
      'https://testnet.hashio.io/api',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
      },
      (b) => b.includes('"result":"0x128"'),
    );
    await httpCheck(
      'Hedera testnet block number > 0',
      'https://testnet.hashio.io/api',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
      },
      (b) => /"result":"0x[0-9a-f]+"/.test(b),
    );

    // Dev-server check — non-blocking. If not running, we surface it as
    // a hint rather than a failure (the endpoints work; the server just
    // isn't up on this machine right now).
    const start = Date.now();
    try {
      const res = await fetch('http://localhost:3000/api/hedera/a2a/demo?asset=BTC&budget=500', {
        signal: AbortSignal.timeout(3_000),
      });
      const body = await res.json();
      const ok = res.ok && (body as { correlationId?: string }).correlationId != null;
      results.push({
        pillar: 'local dev server A2A demo endpoint',
        ok, detail: ok ? `HTTP 200 · trace ${(body as { trace?: { state: string } }).trace?.state}` : `HTTP ${res.status}`,
        ms: Date.now() - start,
      });
      console.log(`  ${ok ? '✓' : '✗'} local dev server A2A demo endpoint  ·  HTTP ${res.status}  ·  ${Date.now() - start}ms`);
    } catch {
      console.log(`  ⓘ local dev server not running — run 'bun run dev' to exercise the demo endpoint`);
    }
  }

  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = total - passed;
  const totalMs = results.reduce((s, r) => s + r.ms, 0);

  console.log('\n═══ Summary ═══');
  console.log(`  ${passed}/${total} pillars green  ·  ${failed} failed  ·  ${(totalMs / 1000).toFixed(1)}s\n`);

  if (failed > 0) {
    console.log('  Failed pillars:');
    results.filter((r) => !r.ok).forEach((r) => console.log(`    ✗ ${r.pillar}  ·  ${r.detail}`));
    console.log();
    process.exit(1);
  }

  console.log('  Every module we shipped this hackathon is green.');
  console.log('  Ready for demo + submissions.\n');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
