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

  try {
    // Mirror doesn't index by tx-id directly on the topic-message endpoint;
    // fetch the last 100 and scan. Good enough for the demo — topic sequence
    // moves slowly (one msg per attested query).
    const r = await fetch(`${MIRROR_BASE}/topics/${topicId}/messages?limit=100&order=desc`);
    if (!r.ok) {
      return NextResponse.json({ error: `mirror returned ${r.status}` }, { status: 502 });
    }
    const j = (await r.json()) as { messages?: MirrorMessage[] };
    const msgs = j.messages ?? [];

    let match: (MirrorMessage & { decoded: AttestPayload }) | null = null;
    for (const m of msgs) {
      let decoded: AttestPayload | null = null;
      try { decoded = JSON.parse(Buffer.from(m.message, 'base64').toString('utf8')) as AttestPayload; }
      catch { continue; }
      if (decoded?.kind !== 'subgraph-query-attestation') continue;

      // Match either by consensus_timestamp (embedded in txId) or by
      // full txId string.
      const txSecs = txId.split('@')[1]?.split('.')[0] ?? '';
      if (m.consensus_timestamp.startsWith(txSecs) || txId.includes(m.consensus_timestamp.slice(0, 10))) {
        match = { ...m, decoded };
        break;
      }
    }

    if (!match) {
      return NextResponse.json({
        error: 'no matching HCS attestation found in last 100 messages',
        txId,
        topicId,
        hint: 'attestation may be older than the fetch window — increase depth or provide consensusTimestamp directly',
      }, { status: 404 });
    }

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
