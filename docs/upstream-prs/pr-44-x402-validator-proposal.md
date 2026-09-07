# PR #44 proposal — x402 endpoint validator (hedera-dev/hedera-harness)

Draft body for the follow-up to [PR #43](https://github.com/hedera-dev/hedera-harness/pull/43). Ready to file after #43 lands.

## Title

`feat(validation): Tier 2.5 x402 endpoint validator`

## Summary

Extends the Mirror-Node validator introduced in #43 with an **x402 endpoint** assertion. Zero-HBAR-cost check that a URL correctly implements the x402 payment protocol on Hedera:

1. Unauthenticated `GET` returns `402 Payment Required` with a well-formed intent object (`payTo`, `facilitator`, `maxAmountRequired`, `network`).
2. Authenticated `GET` (with an `X-PAYMENT` header) returns `200` with the resource payload AND a `hcs.txId` proving the paid call was audit-logged to HCS.

## Why

Hedera is positioning as *the* chain for agentic payments (see the ETHOnline 2026 sponsor block). Every recipe that ships an x402-gated service needs to prove its endpoint is protocol-compliant before letting an agent try to pay for it. Today there's no free way to do this — Playwright can't hit an HTTP endpoint with headers, and Tier 3.5 signed-tx checks are overkill for what is fundamentally a "does this URL correctly implement 402" question.

## Working reference implementation

Already dogfooded in the ZkWard repo at [`scripts/harness-check.ts`](../../scripts/harness-check.ts) — see the `x402Endpoint()` function. Runs against:

- URL: `https://www.zkward.com/api/hedera/x402/signal-quality?asset=BTC`
- Result: 2/2 assertions green — 402-with-intent + paid-call-with-HCS-receipt

## Proposed validator surface (matches #43's shape)

```ts
// src/validation/x402Endpoint.ts
export interface X402EndpointAssertion {
  kind: 'x402-endpoint';
  url: string;
  expectedNetwork?: 'hedera:testnet' | 'hedera:mainnet';
  expectedFacilitator?: string;   // e.g. 'https://api.blocky402.com'
  expectedPayToPrefix?: string;   // e.g. '0xDB89EC1c'
  requireHcsReceipt?: boolean;    // default true — paid call must return { hcs: { txId } }
  paymentHeaderValue?: string;    // default 'dGVzdA==' (stub) for demo-safe testing
}
```

Two REST calls, no SDK boot, no operator credentials. Same free-check philosophy as `contract-exists` and `topic-exists` in #43.

## Follow-ups (not in this PR)

- Optional signed-payment mode (Tier 3.5) that constructs a real EIP-3009 payment and verifies through the Blocky402 facilitator. Kept separate to preserve the zero-cost property.
- Recipe wiring — one-line call into `runDeterministicValidation()` once the recipe schema is settled.

## Delta (once #43 lands)

- `src/validation/x402Endpoint.ts` — new
- `test/x402-endpoint.test.mjs` — new, 4 node:test cases against a canned Express server + one live-endpoint smoke
- `docs/x402-endpoint-validator.md` — new
- `src/types.ts` — +1 union member (`x402-endpoint`)

## Status

- [ ] PR #43 merged upstream (blocker)
- [ ] Files drafted from working reference (`scripts/harness-check.ts:x402Endpoint`)
- [ ] Open PR on hedera-dev fork
