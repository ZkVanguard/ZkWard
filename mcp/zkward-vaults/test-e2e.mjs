/**
 * End-to-end test of the zkward-vaults MCP server.
 *
 * Spawns node index.js as a subprocess, speaks MCP JSON-RPC over stdio:
 * initialize → tools/list → tools/call vault_snapshot → tools/call
 * attested_vault_snapshot. Prints each response.
 *
 * Run: node test-e2e.mjs
 * Exit code 0 = all tools returned valid JSON, non-zero otherwise.
 */

import { spawn } from 'node:child_process';

const server = spawn('node', ['index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });

server.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));

let buf = '';
const inbox = [];
let waiter = null;

server.stdout.on('data', (b) => {
  buf += b.toString();
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (waiter) {
        const w = waiter; waiter = null; w(msg);
      } else {
        inbox.push(msg);
      }
    } catch {
      // ignore non-JSON
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  const req = { jsonrpc: '2.0', id, method, params };
  server.stdin.write(JSON.stringify(req) + '\n');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
    waiter = (msg) => { clearTimeout(t); resolve(msg); };
  });
}

async function main() {
  const passed = [];
  const failed = [];

  try {
    // Handshake
    await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '0.1' },
    });
    passed.push('initialize');

    // Notifications don't get responses; skip.
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    // List tools
    const list = await send('tools/list');
    const tools = list.result?.tools ?? [];
    console.log(`\ntools/list → ${tools.length} tools:`);
    for (const t of tools) console.log(`  - ${t.name.padEnd(28)} ${t.description.slice(0, 70)}…`);
    if (tools.length >= 4) passed.push('tools/list ≥4 tools');
    else failed.push(`tools/list only ${tools.length} tools`);

    // Call vault_snapshot
    const snap = await send('tools/call', { name: 'vault_snapshot', arguments: {} });
    const snapText = snap.result?.content?.[0]?.text;
    if (!snapText) {
      failed.push('vault_snapshot: no text content');
    } else {
      const parsed = JSON.parse(snapText);
      console.log(`\nvault_snapshot →`);
      console.log(`  pools:      ${parsed.pools?.length ?? 0}`);
      console.log(`  totalTvl:   $${parsed.totals?.totalTvlUsdc?.toFixed(2)}`);
      console.log(`  backends:`);
      for (const b of parsed.backends ?? []) {
        console.log(`    ${b.name.padEnd(38)} ${b.elapsedMs}ms  block ${b.meta?.block?.number}`);
      }
      passed.push(`vault_snapshot returned ${parsed.pools?.length} pools, $${parsed.totals?.totalTvlUsdc?.toFixed(2)} TVL`);
    }

    // Call attested_vault_snapshot
    const att = await send('tools/call', { name: 'attested_vault_snapshot', arguments: {} });
    const attText = att.result?.content?.[0]?.text;
    if (!attText) {
      failed.push('attested_vault_snapshot: no text content');
    } else {
      const parsed = JSON.parse(attText);
      console.log(`\nattested_vault_snapshot →`);
      console.log(`  elapsedMs:  ${parsed.elapsedMs}`);
      if (parsed.attestation?.txId) {
        console.log(`  attested:   ${parsed.attestation.attested}`);
        console.log(`  txId:       ${parsed.attestation.txId}`);
        console.log(`  seq:        ${parsed.attestation.consensusSeq}`);
        console.log(`  hashscan:   ${parsed.attestation.explorerUrl}`);
        passed.push(`attested_vault_snapshot HCS seq ${parsed.attestation.consensusSeq}`);
      } else {
        failed.push('attested_vault_snapshot: no attestation returned');
      }
    }

    // Call subgraph_query escape hatch
    const raw = await send('tools/call', {
      name: 'subgraph_query',
      arguments: {
        endpoint: 'hedera',
        query: '{ _meta { block { number } } pools { memberCount } }',
      },
    });
    const rawText = raw.result?.content?.[0]?.text;
    if (rawText && JSON.parse(rawText).data) {
      passed.push('subgraph_query returned data');
    } else {
      failed.push('subgraph_query failed');
    }
  } catch (e) {
    failed.push(`test error: ${e.message}`);
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${passed.length} passed, ${failed.length} failed`);
  console.log('═'.repeat(70));
  for (const p of passed) console.log(`  ✓ ${p}`);
  for (const f of failed) console.log(`  ✗ ${f}`);

  server.stdin.end();
  server.kill();
  process.exit(failed.length === 0 ? 0 : 1);
}

setTimeout(() => main().catch((e) => { console.error(e); process.exit(1); }), 500);
