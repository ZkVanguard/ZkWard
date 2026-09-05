/**
 * x402 client + budget — locks the two things this pair guarantees:
 *   (1) the paid retry only fires on 402 with an intent, never on happy
 *       200 or on a garbled body — otherwise the trader could spend
 *       when it shouldn't.
 *   (2) the per-agent daily budget cap prevents runaway spend even
 *       when the endpoint returns 402 on every call.
 *
 * Fetch is mocked in-process so we can exercise the 402 → sign → retry
 * flow without touching a real facilitator.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const originalFetch = global.fetch;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.resetAllMocks?.();
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
  global.fetch = originalFetch;
});

function mockOneShot(response: {
  status: number;
  body: unknown;
}): jest.Mock {
  const m = jest.fn(async () => ({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => response.body,
  }));
  global.fetch = m as unknown as typeof fetch;
  return m as unknown as jest.Mock;
}

function mockSequence(responses: Array<{ status: number; body: unknown }>): jest.Mock {
  let i = 0;
  const m = jest.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  });
  global.fetch = m as unknown as typeof fetch;
  return m as unknown as jest.Mock;
}

describe('callX402 — happy path (free tier)', () => {
  it('returns data without paid=true when the endpoint serves 200 directly', async () => {
    mockOneShot({ status: 200, body: { hello: 'world' } });
    const { callX402 } = await import('@/lib/services/x402/client');
    const r = await callX402<{ hello: string }>('https://api.test/x', {
      agentId: 'test-agent',
    });
    expect(r.ok).toBe(true);
    expect(r.paid).toBe(false);
    expect(r.data).toEqual({ hello: 'world' });
  });
});

describe('callX402 — 402 → sign → retry', () => {
  it('parses intent, signs stub, retries with X-PAYMENT, records spend', async () => {
    const { _resetBudgetForTest, getRemainingBudget } = await import('@/lib/services/x402/budget');
    await _resetBudgetForTest('test-agent');

    const intent = {
      scheme: 'exact',
      network: 'hedera-testnet',
      maxAmountRequired: '250',
      currency: 'USDC',
      payTo: '0xabc',
      facilitator: 'https://fac.test',
      resource: 'https://api.test/x',
    };
    const fetchMock = mockSequence([
      { status: 402, body: { intent } },
      { status: 200, body: { signal: 'BULLISH', confidence: 78 } },
    ]);
    const { callX402 } = await import('@/lib/services/x402/client');
    const r = await callX402<{ signal: string; confidence: number }>('https://api.test/x', {
      agentId: 'test-agent',
    });
    expect(r.ok).toBe(true);
    expect(r.paid).toBe(true);
    expect(r.data?.signal).toBe('BULLISH');
    expect(r.amountMicrosCharged).toBe('250');

    // Second call carried the X-PAYMENT header.
    const secondCallInit = fetchMock.mock.calls[1][1] as { headers?: Record<string, string> };
    expect(secondCallInit.headers?.['X-PAYMENT']).toBeTruthy();

    // Spend accounted.
    const budget = await getRemainingBudget('test-agent');
    expect(budget.spentMicros).toBe('250');
  });

  it('rejects intent that exceeds caller cap without paying', async () => {
    const { _resetBudgetForTest } = await import('@/lib/services/x402/budget');
    await _resetBudgetForTest('over-cap-agent');

    mockSequence([{
      status: 402,
      body: {
        intent: {
          scheme: 'exact', network: 'hedera-testnet',
          maxAmountRequired: '5000', currency: 'USDC',
          payTo: '0xabc', facilitator: 'https://fac.test',
          resource: 'https://api.test/x',
        },
      },
    }]);
    const { callX402 } = await import('@/lib/services/x402/client');
    const r = await callX402('https://api.test/x', {
      agentId: 'over-cap-agent',
      maxAmountMicros: '1000',
    });
    expect(r.ok).toBe(false);
    expect(r.paid).toBe(false);
    expect(r.reason).toContain('exceeds caller cap');
  });

  it('surfaces unexpected non-402 status without payment attempt', async () => {
    mockOneShot({ status: 503, body: { error: 'down' } });
    const { callX402 } = await import('@/lib/services/x402/client');
    const r = await callX402('https://api.test/x', { agentId: 'x' });
    expect(r.ok).toBe(false);
    expect(r.paid).toBe(false);
    expect(r.reason).toContain('503');
  });

  it('handles 402 with no intent as an error', async () => {
    mockOneShot({ status: 402, body: { error: 'malformed' } });
    const { callX402 } = await import('@/lib/services/x402/client');
    const r = await callX402('https://api.test/x', { agentId: 'x' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no payment intent');
  });
});

describe('budget cap — daily ceiling stops paid calls', () => {
  it('checkBudget returns true under cap, false at cap', async () => {
    const { _resetBudgetForTest, checkBudget, chargeSpendForTest, getRemainingBudget } =
      await import('@/lib/services/x402/budget');
    await _resetBudgetForTest('cap-test');

    process.env.X402_DAILY_BUDGET_MICROS = '1000';
    // Fresh — 500 requested, within 1000 cap
    expect(await checkBudget('cap-test', '500')).toBe(true);

    // Charge 900 → 1000 - 900 = 100 remaining, so 500 more should fail.
    await chargeSpendForTest('cap-test', '900');
    expect(await checkBudget('cap-test', '500')).toBe(false);
    // But 100 exactly should still fit.
    expect(await checkBudget('cap-test', '100')).toBe(true);

    const b = await getRemainingBudget('cap-test');
    expect(b.remainingMicros).toBe('100');
  });

  it('exhausted budget prevents paid retry inside callX402', async () => {
    const { _resetBudgetForTest, chargeSpendForTest } =
      await import('@/lib/services/x402/budget');
    await _resetBudgetForTest('poor-agent');
    process.env.X402_DAILY_BUDGET_MICROS = '1000';
    await chargeSpendForTest('poor-agent', '1000');

    mockSequence([{
      status: 402,
      body: {
        intent: {
          scheme: 'exact', network: 'hedera-testnet',
          maxAmountRequired: '250', currency: 'USDC',
          payTo: '0xabc', facilitator: 'https://fac.test',
          resource: 'https://api.test/x',
        },
      },
    }]);
    const { callX402 } = await import('@/lib/services/x402/client');
    const r = await callX402('https://api.test/x', { agentId: 'poor-agent' });
    expect(r.ok).toBe(false);
    expect(r.paid).toBe(false);
    expect(r.reason).toContain('daily budget exhausted');
  });
});
