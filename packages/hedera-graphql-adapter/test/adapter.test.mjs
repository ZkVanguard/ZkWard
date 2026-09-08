/**
 * Adapter unit tests. Runs against an in-process mock Mirror Node, so:
 *   - No network, no flakes.
 *   - Deterministic behaviour under failure (timeout, 5xx, invalid JSON).
 *   - Runs on `npm test` in <2 seconds.
 *
 * Uses node:test — zero framework, ships with Node 18+.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHederaGraphQLAdapter } from '../dist/index.js';

const VAULT = '0xe7e6fedce9d72d112137b631e8d51831d30729a9';

// Precomputed 32-byte hex for uint256(987363187) — matches TVL in the
// reference deployment used for the fixtures.
function u256(value) {
  return '0x' + BigInt(value).toString(16).padStart(64, '0');
}

// Selectors from src/schema/erc4626.ts.
const SEL = {
  totalShares: '0x3a98ef39',
  totalSupply: '0x18160ddd',
  totalAssets: '0x01e1d114',
  memberCount: '0x11aee380',
};

const DEPOSITED_TOPIC = '0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca';

/**
 * Start a mock Mirror server. Handlers is a { [path-substring]: handler(req) => { status, body } }.
 * Returns the base URL and a stop() function.
 */
function mockMirror(routes) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const key = Object.keys(routes).find((k) => req.url.includes(k)) ?? '__default__';
      const handler = routes[key];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `no route for ${req.url}` }));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const out = await handler({ url: req.url, method: req.method, body });
          const { status = 200, body: payload = {}, headers = {} } = out;
          res.writeHead(status, { 'content-type': 'application/json', ...headers });
          res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/api/v1`,
        stop: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ── Standard fixture: a healthy Mirror with one pool + one deposit ─────────
// Order matters — most-specific routes first, since the mock matches on
// URL-includes and takes the first hit.
const HAPPY_ROUTES = {
  '/contracts/call': ({ body }) => {
    const { data } = JSON.parse(body);
    if (data === SEL.totalShares) return { body: { result: u256(940212154) } };
    if (data === SEL.totalSupply) return { body: { result: u256(940212154) } };
    if (data === SEL.totalAssets) return { body: { result: u256(987363187) } };
    if (data === SEL.memberCount) return { body: { result: u256(3) } };
    return { body: { result: '0x' } };
  },
  [`/contracts/${VAULT}/results/logs`]: () => ({
    body: {
      logs: [
        {
          address: VAULT,
          topics: [DEPOSITED_TOPIC, '0x000000000000000000000000db89ec1c81dcd362fb0f9ca3da232697b583bc8a'],
          data: '0x' + u256(70_000_000).slice(2) + u256(70_000_000).slice(2), // amount + shares, 0x + 2 × uint256
          block_number: 12345,
          timestamp: '1788757632.252720104',
          transaction_hash: '0xdeadbeef',
          block_hash: '0xbeef',
          index: 0,
        },
      ],
    },
  }),
  '/blocks?limit=1': () => ({
    body: { blocks: [{ number: 40229981, timestamp: { from: '1788804081.0' } }] },
  }),
  [`/contracts/${VAULT}`]: () => ({
    body: {
      contract_id: '0.0.10394497',
      evm_address: VAULT,
      created_timestamp: '1788711483.275952438',
    },
  }),
};

async function withAdapter(routes, opts, fn) {
  const server = await mockMirror(routes);
  const adapter = createHederaGraphQLAdapter({
    network: 'testnet',
    contract: VAULT,
    preset: 'erc4626',
    mirrorNodeBase: server.base,
    ...opts,
  });
  try {
    return await fn(adapter);
  } finally {
    await server.stop();
  }
}

// ── Constructor validation ─────────────────────────────────────────────────

test('rejects missing contract', () => {
  assert.throws(() => createHederaGraphQLAdapter({ network: 'testnet' }), /config\.contract is required/);
});

test('rejects malformed contract address', () => {
  assert.throws(
    () => createHederaGraphQLAdapter({ network: 'testnet', contract: 'not-an-address' }),
    /must be a 0x-prefixed 20-byte EVM address/,
  );
});

test('rejects invalid network', () => {
  assert.throws(
    () => createHederaGraphQLAdapter({ network: 'devnet', contract: VAULT }),
    /must be 'testnet' or 'mainnet'/,
  );
});

test('rejects custom preset until v0.2', async () => {
  await assert.rejects(
    async () => createHederaGraphQLAdapter({ network: 'testnet', contract: VAULT, preset: 'custom' }),
    /planned for v0.2/,
  );
});

// ── Happy path ─────────────────────────────────────────────────────────────

test('pools query returns real pool data', async () => {
  await withAdapter(HAPPY_ROUTES, { cacheTtlMs: 0 }, async (adapter) => {
    const result = await adapter.execute({
      query: '{ pools { id network totalNav totalShares memberCount sharePrice } }',
    });
    assert.equal(result.errors, undefined);
    const pool = result.data?.pools?.[0];
    assert.ok(pool, 'expected one pool');
    assert.equal(pool.id, VAULT);
    assert.equal(pool.network, 'hedera-testnet');
    assert.equal(pool.totalNav, '987363187');
    assert.equal(pool.totalShares, '940212154');
    assert.equal(pool.memberCount, 3);
    // sharePrice = totalAssets * 1e6 / totalShares
    const expectedSharePrice = ((987363187n * 1_000_000n) / 940212154n).toString();
    assert.equal(pool.sharePrice, expectedSharePrice);
  });
});

test('transactions query decodes Deposited event', async () => {
  await withAdapter(HAPPY_ROUTES, { cacheTtlMs: 0 }, async (adapter) => {
    const result = await adapter.execute({
      query: '{ transactions(first: 5) { type actor amount shares timestamp } }',
    });
    assert.equal(result.errors, undefined);
    const tx = result.data?.transactions?.[0];
    assert.ok(tx);
    assert.equal(tx.type, 'DEPOSIT');
    assert.equal(tx.actor, '0xdb89ec1c81dcd362fb0f9ca3da232697b583bc8a');
    assert.equal(tx.amount, '70000000');
    assert.equal(tx.shares, '70000000');
  });
});

test('_meta reports Mirror block + zero errors on happy path', async () => {
  await withAdapter(HAPPY_ROUTES, { cacheTtlMs: 0 }, async (adapter) => {
    const result = await adapter.execute({
      query: '{ _meta { block { number timestamp } deployment hasIndexingErrors } }',
    });
    const meta = result.data?._meta;
    assert.ok(meta);
    assert.equal(meta.block.number, 40229981);
    assert.equal(meta.block.timestamp, 1788804081);
    assert.equal(meta.deployment, `hedera-mirror-adapter:${VAULT}`);
    assert.equal(meta.hasIndexingErrors, false);
  });
});

// ── Failure surfacing ──────────────────────────────────────────────────────

test('_meta.hasIndexingErrors flips to true when Mirror 500s', async () => {
  const brokenRoutes = { [`/contracts/${VAULT}`]: () => ({ status: 500, body: { error: 'kaboom' } }) };
  await withAdapter(brokenRoutes, { cacheTtlMs: 0 }, async (adapter) => {
    await adapter.execute({ query: '{ pools { id } }' });
    const result = await adapter.execute({ query: '{ _meta { hasIndexingErrors } }' });
    assert.equal(result.data?._meta?.hasIndexingErrors, true);
  });
});

test('malformed GraphQL query returns validation error, not throw', async () => {
  await withAdapter(HAPPY_ROUTES, { cacheTtlMs: 0 }, async (adapter) => {
    const result = await adapter.execute({ query: '{ nonExistentField }' });
    assert.ok(result.errors && result.errors.length > 0);
    assert.equal(result.errors[0].extensions?.code, 'VALIDATION_ERROR');
    assert.equal(result.errors[0].extensions?.retryable, false);
  });
});

test('unparseable query returns PARSE_ERROR', async () => {
  await withAdapter(HAPPY_ROUTES, { cacheTtlMs: 0 }, async (adapter) => {
    const result = await adapter.execute({ query: '{ this is not valid' });
    assert.ok(result.errors && result.errors.length > 0);
    assert.equal(result.errors[0].extensions?.code, 'PARSE_ERROR');
  });
});

// ── Injection points ───────────────────────────────────────────────────────

test('custom mirrorFetch is used for all requests', async () => {
  await withAdapter(HAPPY_ROUTES, { cacheTtlMs: 0 }, async () => {}); // just to boot server
  const server = await mockMirror(HAPPY_ROUTES);
  const seenUrls = [];
  const customFetch = async (url, init) => {
    seenUrls.push(typeof url === 'string' ? url : url.toString());
    return globalThis.fetch(url, init);
  };
  const adapter = createHederaGraphQLAdapter({
    network: 'testnet',
    contract: VAULT,
    preset: 'erc4626',
    mirrorNodeBase: server.base,
    mirrorFetch: customFetch,
    cacheTtlMs: 0,
  });
  await adapter.execute({ query: '{ pools { id } }' });
  await server.stop();
  assert.ok(seenUrls.length > 0, 'expected the custom fetch to have been called');
  assert.ok(seenUrls.some((u) => u.includes(VAULT)), 'expected the vault address in a request URL');
});

test('cache dedupes within TTL window', async () => {
  let contractHits = 0;
  const routes = {
    ...HAPPY_ROUTES,
    [`/contracts/${VAULT}`]: () => {
      contractHits++;
      return HAPPY_ROUTES[`/contracts/${VAULT}`]();
    },
  };
  await withAdapter(routes, { cacheTtlMs: 60_000 }, async (adapter) => {
    await adapter.execute({ query: '{ pools { id } }' });
    await adapter.execute({ query: '{ pools { totalNav } }' });
    await adapter.execute({ query: '{ pools { memberCount } }' });
  });
  assert.equal(contractHits, 1, `expected 1 contract hit due to caching, got ${contractHits}`);
});

// ── Timeout behaviour ──────────────────────────────────────────────────────

test('hung Mirror is aborted by mirrorTimeoutMs', async () => {
  const hangingRoutes = {
    [`/contracts/${VAULT}`]: () => new Promise(() => { /* never resolves */ }),
  };
  const t0 = Date.now();
  await withAdapter(hangingRoutes, { cacheTtlMs: 0, mirrorTimeoutMs: 200 }, async (adapter) => {
    const result = await adapter.execute({ query: '{ pools { id } _meta { hasIndexingErrors } }' });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `expected < 2s abort, took ${elapsed}ms`);
    assert.equal(result.data?._meta?.hasIndexingErrors, true);
  });
});

// ── Singular resolvers (regression: SDL declared them without impl) ────────

test('transaction(id) singular resolver returns the row by exact id match', async () => {
  await withAdapter(HAPPY_ROUTES, { cacheTtlMs: 0 }, async (adapter) => {
    // First get the id from a list query, then look it up singularly.
    const list = await adapter.execute({ query: '{ transactions(first: 1) { id } }' });
    const id = list.data?.transactions?.[0]?.id;
    assert.ok(id, 'expected at least one transaction in fixture');

    const single = await adapter.execute({
      query: `query($id: Bytes!) { transaction(id: $id) { id type actor amount } }`,
      variables: { id },
    });
    assert.equal(single.errors, undefined);
    assert.ok(single.data?.transaction, 'transaction(id) returned null for a real id');
    assert.equal(single.data.transaction.id, id);
    assert.equal(single.data.transaction.type, 'DEPOSIT');
  });
});

test('transaction(id) returns null for unknown id', async () => {
  await withAdapter(HAPPY_ROUTES, { cacheTtlMs: 0 }, async (adapter) => {
    const r = await adapter.execute({ query: '{ transaction(id: "no-such-tx") { id } }' });
    assert.equal(r.errors, undefined);
    assert.equal(r.data?.transaction, null);
  });
});

test('member(id) singular resolver returns the row', async () => {
  await withAdapter(HAPPY_ROUTES, { cacheTtlMs: 0 }, async (adapter) => {
    const list = await adapter.execute({ query: '{ members(first: 1) { id address } }' });
    const id = list.data?.members?.[0]?.id;
    assert.ok(id);
    const single = await adapter.execute({
      query: `query($id: Bytes!) { member(id: $id) { id address currentShares } }`,
      variables: { id },
    });
    assert.equal(single.errors, undefined);
    assert.ok(single.data?.member);
    assert.equal(single.data.member.id, id);
  });
});

// ── orderBy / orderDirection (regression: SDL declared, silently ignored) ──

test('transactions orderBy=amount desc sorts by BigInt amount', async () => {
  // Multiple deposits with different amounts.
  const routes = {
    ...HAPPY_ROUTES,
    [`/contracts/${VAULT}/results/logs`]: () => ({
      body: {
        logs: [
          {
            address: VAULT,
            topics: [DEPOSITED_TOPIC, '0x000000000000000000000000db89ec1c81dcd362fb0f9ca3da232697b583bc8a'],
            data: '0x' + u256(50_000_000).slice(2) + u256(50_000_000).slice(2),
            block_number: 100, timestamp: '1000.0', transaction_hash: '0xa', block_hash: '0x', index: 0,
          },
          {
            address: VAULT,
            topics: [DEPOSITED_TOPIC, '0x000000000000000000000000db89ec1c81dcd362fb0f9ca3da232697b583bc8a'],
            data: '0x' + u256(90_000_000).slice(2) + u256(90_000_000).slice(2),
            block_number: 200, timestamp: '2000.0', transaction_hash: '0xb', block_hash: '0x', index: 0,
          },
          {
            address: VAULT,
            topics: [DEPOSITED_TOPIC, '0x000000000000000000000000db89ec1c81dcd362fb0f9ca3da232697b583bc8a'],
            data: '0x' + u256(70_000_000).slice(2) + u256(70_000_000).slice(2),
            block_number: 150, timestamp: '1500.0', transaction_hash: '0xc', block_hash: '0x', index: 0,
          },
        ],
      },
    }),
  };
  await withAdapter(routes, { cacheTtlMs: 0 }, async (adapter) => {
    const r = await adapter.execute({
      query: '{ transactions(first: 5, orderBy: "amount", orderDirection: desc) { amount } }',
    });
    const amounts = (r.data?.transactions ?? []).map((t) => t.amount);
    assert.deepEqual(amounts, ['90000000', '70000000', '50000000'], `expected desc sort, got ${JSON.stringify(amounts)}`);
  });
});

test('transactions orderBy=timestamp asc reverses default order', async () => {
  await withAdapter(HAPPY_ROUTES, { cacheTtlMs: 0 }, async (adapter) => {
    const r = await adapter.execute({
      query: '{ transactions(first: 5, orderBy: "timestamp", orderDirection: asc) { timestamp } }',
    });
    const ts = (r.data?.transactions ?? []).map((t) => Number(t.timestamp));
    for (let i = 1; i < ts.length; i++) {
      assert.ok(ts[i] >= ts[i - 1], `expected asc order, got ${JSON.stringify(ts)}`);
    }
  });
});

// ── Signals from HCS audit topic ───────────────────────────────────────────

test('signals resolver decodes x402-payment-receipt + hedge-projection', async () => {
  const AUDIT_TOPIC = '0.0.10393879';
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
  const routes = {
    ...HAPPY_ROUTES,
    [`/topics/${AUDIT_TOPIC}/messages`]: () => ({
      body: {
        messages: [
          {
            sequence_number: 55,
            consensus_timestamp: '1788804617.225947156',
            message: b64({ v: 1, asset: 'BTC', signal: 'BEARISH', confidence: 63, paid: true, ts: '2026-09-07T18:10:16.733Z' }),
          },
          {
            sequence_number: 52,
            consensus_timestamp: '1788800426.566787104',
            message: b64({
              v: 1,
              kind: 'hedge-projection',
              poolNavUsd: 987.36,
              positions: [
                { symbol: 'BTC', side: 'SHORT', signalConfidence: 62 },
                { symbol: 'ETH', side: 'SHORT', signalConfidence: 56 },
                { symbol: 'SUI', side: 'LONG',  signalConfidence: 0 },
              ],
              submittedAt: '2026-09-07T17:00:25.690Z',
            }),
          },
        ],
      },
    }),
  };
  await withAdapter(routes, { cacheTtlMs: 0, auditTopicId: AUDIT_TOPIC }, async (adapter) => {
    const result = await adapter.execute({
      query: '{ signals(first: 10) { id asset direction confidence source hcsSeq timestamp } }',
    });
    assert.equal(result.errors, undefined);
    const sigs = result.data?.signals ?? [];
    // 1 x402 receipt + 3 hedge legs = 4 rows
    assert.equal(sigs.length, 4, `expected 4 signals, got ${sigs.length}`);

    const receipt = sigs.find((s) => s.source === 'x402-payment-receipt');
    assert.ok(receipt);
    assert.equal(receipt.asset, 'BTC');
    assert.equal(receipt.direction, 'BEARISH');
    assert.equal(receipt.confidence, 63);
    assert.equal(receipt.hcsSeq, 55);

    const btcHedge = sigs.find((s) => s.source === 'hedge-projection' && s.asset === 'BTC');
    assert.ok(btcHedge);
    assert.equal(btcHedge.direction, 'BEARISH'); // SHORT → BEARISH
    assert.equal(btcHedge.confidence, 62);

    const suiHedge = sigs.find((s) => s.source === 'hedge-projection' && s.asset === 'SUI');
    assert.equal(suiHedge.direction, 'BULLISH'); // LONG → BULLISH
  });
});

test('signals filter by asset', async () => {
  const AUDIT_TOPIC = '0.0.10393879';
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
  const routes = {
    ...HAPPY_ROUTES,
    [`/topics/${AUDIT_TOPIC}/messages`]: () => ({
      body: {
        messages: [
          { sequence_number: 1, consensus_timestamp: '1000.0', message: b64({ v: 1, asset: 'BTC', signal: 'BEARISH', confidence: 60, paid: true }) },
          { sequence_number: 2, consensus_timestamp: '2000.0', message: b64({ v: 1, asset: 'ETH', signal: 'BULLISH', confidence: 70, paid: true }) },
        ],
      },
    }),
  };
  await withAdapter(routes, { cacheTtlMs: 0, auditTopicId: AUDIT_TOPIC }, async (adapter) => {
    const result = await adapter.execute({
      query: '{ signals(where: { asset: "BTC" }) { asset direction } }',
    });
    const sigs = result.data?.signals ?? [];
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].asset, 'BTC');
  });
});

test('signals returns empty when auditTopicId not configured', async () => {
  await withAdapter(HAPPY_ROUTES, { cacheTtlMs: 0 }, async (adapter) => {
    const result = await adapter.execute({ query: '{ signals(first: 5) { asset } }' });
    assert.equal(result.errors, undefined);
    assert.deepEqual(result.data?.signals, []);
  });
});

// ── SDL / config plumbing ──────────────────────────────────────────────────

test('getSchemaSDL returns the standardized vault SDL', async () => {
  await withAdapter(HAPPY_ROUTES, {}, async (adapter) => {
    const sdl = adapter.getSchemaSDL();
    assert.ok(sdl.includes('type Pool'));
    assert.ok(sdl.includes('type Transaction'));
    assert.ok(sdl.includes('type _Meta_'));
  });
});

test('getConfig returns a frozen copy of the config', async () => {
  await withAdapter(HAPPY_ROUTES, {}, async (adapter) => {
    const cfg = adapter.getConfig();
    assert.equal(cfg.contract, VAULT);
    assert.equal(cfg.network, 'testnet');
    assert.throws(() => { cfg.contract = 'mutated'; });
  });
});
