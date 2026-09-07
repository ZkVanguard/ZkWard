/**
 * Runs the Tier 2.5 Mirror Node validator (as proposed in
 * https://github.com/hedera-dev/hedera-harness/pull/43) against
 * OUR OWN Hedera testnet deploy — dogfoods the tool we upstreamed.
 *
 * Also previews the "x402 endpoint validator" from the follow-up PR #44
 * draft (see docs/upstream-prs/pr-44-x402-validator/).
 *
 * Every assertion is a plain REST GET against the public Mirror Node —
 * no HBAR spent, no operator credentials needed, no SDK client boot.
 *
 * Run:
 *   bun run scripts/harness-check.ts
 * Set BASE_URL to point at a different deployment.
 */

const NETWORK = 'testnet';
const MIRROR = 'https://testnet.mirrornode.hedera.com/api/v1';
const BASE_URL = (process.env.BASE_URL || 'https://www.zkward.com').replace(/\/$/, '');

const VAULT = '0xe7E6fEDce9d72D112137B631E8D51831D30729A9';
const TEST_USDC = '0x704365B35AeF0b7F9fc17c18B5162D4A6d600ae1';
const OPERATOR_ID = '0.0.7132683';
const AUDIT_TOPIC = '0.0.10393879';
const REGISTRY_TOPIC = '0.0.10401316';
const X402_URL = `${BASE_URL}/api/hedera/x402/signal-quality?asset=BTC`;

interface Result { name: string; ok: boolean; detail: string; }

async function contractExists(evmAddress: string): Promise<Result> {
  try {
    const r = await fetch(`${MIRROR}/contracts/${evmAddress.toLowerCase()}`);
    if (!r.ok) return { name: `contract-exists(${evmAddress})`, ok: false, detail: `mirror ${r.status}` };
    const j = await r.json() as { contract_id?: string; runtime_bytecode?: string };
    if (!j.contract_id) return { name: `contract-exists(${evmAddress})`, ok: false, detail: 'no contract_id' };
    return { name: `contract-exists(${evmAddress})`, ok: true, detail: `${j.contract_id}, ${j.runtime_bytecode?.length ?? 0} bytecode chars` };
  } catch (e) {
    return { name: `contract-exists(${evmAddress})`, ok: false, detail: e instanceof Error ? e.message : 'error' };
  }
}

async function tokenExists(evmAddress: string): Promise<Result> {
  try {
    const r = await fetch(`${MIRROR}/tokens?limit=1&order=desc&account.id=${OPERATOR_ID}`);
    if (!r.ok) return { name: `token-exists(${evmAddress})`, ok: false, detail: `mirror ${r.status}` };
    // For ERC-20 style HTS tokens the /contracts/{addr} route also works
    const r2 = await fetch(`${MIRROR}/contracts/${evmAddress.toLowerCase()}`);
    if (!r2.ok) return { name: `token-exists(${evmAddress})`, ok: false, detail: `mirror ${r2.status}` };
    const j = await r2.json() as { contract_id?: string };
    return { name: `token-exists(${evmAddress})`, ok: !!j.contract_id, detail: `${j.contract_id} (ERC-20 test USDC)` };
  } catch (e) {
    return { name: `token-exists(${evmAddress})`, ok: false, detail: e instanceof Error ? e.message : 'error' };
  }
}

async function accountExists(accountId: string): Promise<Result> {
  try {
    const r = await fetch(`${MIRROR}/accounts/${accountId}`);
    if (!r.ok) return { name: `account-exists(${accountId})`, ok: false, detail: `mirror ${r.status}` };
    const j = await r.json() as { account?: string; balance?: { balance?: number } };
    if (!j.account) return { name: `account-exists(${accountId})`, ok: false, detail: 'no account' };
    const hbar = ((j.balance?.balance ?? 0) / 1e8).toFixed(4);
    return { name: `account-exists(${accountId})`, ok: true, detail: `${j.account}, ${hbar} HBAR` };
  } catch (e) {
    return { name: `account-exists(${accountId})`, ok: false, detail: e instanceof Error ? e.message : 'error' };
  }
}

async function topicExists(topicId: string, opts?: { minMessages?: number }): Promise<Result> {
  try {
    const r = await fetch(`${MIRROR}/topics/${topicId}/messages?limit=1&order=desc`);
    if (!r.ok) return { name: `topic-exists(${topicId})`, ok: false, detail: `mirror ${r.status}` };
    const j = await r.json() as { messages?: Array<{ sequence_number: number }> };
    const latest = j.messages?.[0]?.sequence_number ?? 0;
    const min = opts?.minMessages ?? 1;
    return {
      name: `topic-exists(${topicId})`,
      ok: latest >= min,
      detail: `latest seq ${latest} (min ${min})`,
    };
  } catch (e) {
    return { name: `topic-exists(${topicId})`, ok: false, detail: e instanceof Error ? e.message : 'error' };
  }
}

async function recentContractCall(evmAddress: string, withinSec: number): Promise<Result> {
  try {
    const r = await fetch(`${MIRROR}/contracts/${evmAddress.toLowerCase()}/results?limit=1&order=desc`);
    if (!r.ok) return { name: `recent-contract-call(${evmAddress})`, ok: false, detail: `mirror ${r.status}` };
    const j = await r.json() as { results?: Array<{ timestamp: string; hash: string }> };
    const latest = j.results?.[0];
    if (!latest) return { name: `recent-contract-call(${evmAddress})`, ok: false, detail: 'no calls' };
    const ageSec = Date.now() / 1000 - Number(latest.timestamp.split('.')[0]);
    const ok = ageSec <= withinSec;
    return {
      name: `recent-contract-call(${evmAddress})`,
      ok,
      detail: `latest ${Math.round(ageSec / 60)}min ago, hash ${latest.hash.slice(0, 12)}…`,
    };
  } catch (e) {
    return { name: `recent-contract-call(${evmAddress})`, ok: false, detail: e instanceof Error ? e.message : 'error' };
  }
}

// PR #44 preview: x402-endpoint validator.
// Asserts the URL returns 402 with a spec-compliant intent, then that a
// paid call succeeds. Zero HBAR cost — same free-check philosophy as PR #43.
async function x402Endpoint(url: string): Promise<Result[]> {
  const results: Result[] = [];
  try {
    const r = await fetch(url);
    if (r.status !== 402) {
      results.push({ name: `x402-402(${url})`, ok: false, detail: `expected 402, got ${r.status}` });
    } else {
      const j = await r.json() as { intent?: { payTo?: string; facilitator?: string; maxAmountRequired?: string; network?: string } };
      const okShape = !!j.intent?.payTo && !!j.intent?.facilitator && !!j.intent?.maxAmountRequired;
      results.push({
        name: `x402-intent-shape`,
        ok: okShape,
        detail: okShape ? `pay ${j.intent!.maxAmountRequired} micros on ${j.intent!.network} to ${j.intent!.payTo!.slice(0, 10)}…` : 'intent shape invalid',
      });
    }
  } catch (e) {
    results.push({ name: `x402-402(${url})`, ok: false, detail: e instanceof Error ? e.message : 'error' });
  }

  try {
    const r = await fetch(url, { headers: { 'X-PAYMENT': 'dGVzdA==' } });
    if (!r.ok) {
      results.push({ name: `x402-paid-call`, ok: false, detail: `paid HTTP ${r.status}` });
    } else {
      const j = await r.json() as { signal?: string; hcs?: { txId?: string } };
      const ok = !!j.signal && !!j.hcs?.txId;
      results.push({ name: `x402-paid-call`, ok, detail: ok ? `signal ${j.signal}, hcs ${j.hcs!.txId}` : 'missing signal or hcs receipt' });
    }
  } catch (e) {
    results.push({ name: `x402-paid-call`, ok: false, detail: e instanceof Error ? e.message : 'error' });
  }
  return results;
}

function line(char = '─', len = 78): string { return char.repeat(len); }

function print(r: Result): void {
  const mark = r.ok ? '✓' : '✗';
  console.log(`  ${mark} ${r.name.padEnd(40)}  ${r.detail}`);
}

async function main() {
  console.log(line('═'));
  console.log('  hedera-harness Tier 2.5 (PR #43) — dogfooded on ZkWard testnet');
  console.log('  Upstream: https://github.com/hedera-dev/hedera-harness/pull/43');
  console.log(line('═'));
  console.log(`  Network:  ${NETWORK}`);
  console.log(`  Mirror:   ${MIRROR}`);
  console.log('');

  console.log('== Tier 2.5 Mirror Node validator assertions ==');
  const tier25 = await Promise.all([
    contractExists(VAULT),
    tokenExists(TEST_USDC),
    accountExists(OPERATOR_ID),
    topicExists(AUDIT_TOPIC, { minMessages: 10 }),
    topicExists(REGISTRY_TOPIC, { minMessages: 1 }),
    recentContractCall(VAULT, 60 * 60 * 24 * 30),
  ]);
  tier25.forEach(print);

  console.log('');
  console.log('== PR #44 preview — x402 endpoint validator ==');
  console.log('   (draft in docs/upstream-prs/pr-44-x402-validator/)');
  const x402 = await x402Endpoint(X402_URL);
  x402.forEach(print);

  const all = [...tier25, ...x402];
  const passed = all.filter((r) => r.ok).length;
  console.log('');
  console.log(line('═'));
  console.log(`  ${passed}/${all.length} assertions green`);
  console.log(line('═'));

  process.exit(passed === all.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
