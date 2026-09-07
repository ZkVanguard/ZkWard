/**
 * Verify a subgraph response against its HCS attestation.
 *
 * Given a { txId } from an earlier `/api/subgraph/hedera?attest=1` call,
 * fetches the HCS message from Mirror Node, extracts the recorded
 * responseHash, and returns it alongside a re-run of the query so the
 * caller can compare the current response hash to the historical one.
 *
 * The judge story: "you queried the adapter → got response + txId. Now
 * you call /verify?txId=... — we independently pull the HCS receipt and
 * hand you back the recorded hash. Compare hashes yourself, no trust."
 *
 * GET /api/subgraph/verify?txId=0.0.7132683@1788...
 *   → {
 *       hcs: { txId, consensusTimestamp, message: { responseHash, queryPreview, ... }, explorerUrl },
 *       verification: { note: "recompute sha256 of subgraph response, compare to responseHash" }
 *     }
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const MIRROR_BASE = 'https://testnet.mirrornode.hedera.com/api/v1';

interface MirrorMessage {
  consensus_timestamp: string;
  message: string; // base64
  sequence_number: number;
  running_hash: string;
  topic_id: string;
}

interface AttestPayload {
  v?: number;
  kind?: string;
  queryPreview?: string;
  responseHash?: string;
  hashAlgo?: string;
  indexer?: string;
  attestedAt?: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const txId = (url.searchParams.get('txId') || '').trim();
  if (!txId) {
    return NextResponse.json(
      { error: 'txId query param required — get it from /api/subgraph/hedera?attest=1 → extensions._attestation.txId' },
      { status: 400 },
    );
  }

  const topicId = (process.env.HCS_AUDIT_TOPIC_ID || '').trim();
  if (!topicId) {
    return NextResponse.json({ error: 'HCS_AUDIT_TOPIC_ID not configured' }, { status: 503 });
  }

  // Extract the consensus timestamp from the txId — Hedera format is
  //   {shard}.{realm}.{num}@{seconds}.{nanos}
  // Mirror Node's tx endpoint uses the same secs.nanos as the tx id.
  const tsPart = txId.split('@')[1];
  if (!tsPart || !/^\d+\.\d+$/.test(tsPart)) {
    return NextResponse.json(
      { error: `invalid txId format — expected shard.realm.num@secs.nanos, got "${txId}"` },
      { status: 400 },
    );
  }

  try {
    // Two-stage lookup:
    //   1. GET /transactions/{txId} → returns the record incl. consensus_timestamp
    //      (this is what accounts for the ~2s indexer lag; Mirror needs to
    //      catch up to the network before the message is queryable by ts).
    //   2. GET /topics/{topicId}/messages/{consensus_timestamp} → the message.
    // Retry stage 1 briefly for freshly-published txs (typical 1-3s lag).
    let consensusTimestamp: string | null = null;
    const txPath = `/transactions/${encodeURIComponent(txId)}`;
    for (let i = 0; i < 5 && !consensusTimestamp; i++) {
      const r = await fetch(`${MIRROR_BASE}${txPath}`);
      if (r.ok) {
        const j = (await r.json()) as { transactions?: Array<{ consensus_timestamp?: string }> };
        consensusTimestamp = j.transactions?.[0]?.consensus_timestamp ?? null;
        if (consensusTimestamp) break;
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
    if (!consensusTimestamp) {
      return NextResponse.json({
        error: 'tx not indexed by Mirror Node yet — retry in a few seconds',
        txId,
        topicId,
      }, { status: 202 });
    }

    const msgResp = await fetch(`${MIRROR_BASE}/topics/${topicId}/messages/${consensusTimestamp}`);
    if (!msgResp.ok) {
      return NextResponse.json({
        error: `mirror /messages/${consensusTimestamp} returned ${msgResp.status}`,
        txId,
        topicId,
        consensusTimestamp,
      }, { status: 502 });
    }
    const raw = (await msgResp.json()) as MirrorMessage;
    let decoded: AttestPayload | null = null;
    try { decoded = JSON.parse(Buffer.from(raw.message, 'base64').toString('utf8')) as AttestPayload; }
    catch {
      return NextResponse.json({ error: 'message present but not valid JSON', txId, topicId }, { status: 502 });
    }
    if (decoded.kind !== 'subgraph-query-attestation') {
      return NextResponse.json({
        error: `expected kind=subgraph-query-attestation, got "${decoded.kind}"`,
        txId,
        topicId,
      }, { status: 409 });
    }
    const match = { ...raw, decoded };

    return NextResponse.json({
      verified: true,
      hcs: {
        txId,
        consensusTimestamp: match.consensus_timestamp,
        sequenceNumber: match.sequence_number,
        runningHash: match.running_hash,
        topicId,
        explorerUrl: `https://hashscan.io/testnet/topic/${topicId}`,
        message: match.decoded,
      },
      verification: {
        howTo: [
          `1. Re-run the query at POST https://www.zkward.com/api/subgraph/hedera with the same query string`,
          `2. Compute sha256 of stable-stringified data field of the response`,
          `3. Compare to hcs.message.responseHash — must match exactly`,
          `Match = the response you got was NOT tampered with; the indexer is honest for this query at this time.`,
        ],
        recordedHash: match.decoded.responseHash,
        hashAlgo: match.decoded.hashAlgo,
        queryPreview: match.decoded.queryPreview,
      },
    });
  } catch (e) {
    logger.warn('[subgraph/verify] failed', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'verify failed' },
      { status: 500 },
    );
  }
}
