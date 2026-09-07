/**
 * Optional HCS attestation of adapter responses.
 *
 * Off by default. When enabled AND the caller requests `attest: true` on
 * an individual query, the adapter hashes the response data (sha256 of a
 * stable-stringified JSON), submits the hash to a Hedera Consensus
 * Service topic, and returns the receipt in `extensions._attestation`.
 *
 * The `@hashgraph/sdk` dep is imported dynamically so packages that
 * don't need attestation can skip installing it.
 */

import { createHash } from 'node:crypto';
import type { AttestationConfig, AttestationResult, HederaNetwork } from './types.js';

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v as object).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') + '}';
}

export function canonicalHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

interface AttestParams {
  config: AttestationConfig;
  network: HederaNetwork;
  queryPreview: string;
  data: unknown;
  indexer: string;
}

export async function attestOnHcs(params: AttestParams): Promise<AttestationResult> {
  const { config, network, queryPreview, data, indexer } = params;
  const responseHash = canonicalHash(data);

  if (!config.enabled) {
    return { attested: false, reason: 'attestation disabled', responseHash, hashAlgo: 'sha256' };
  }
  if (!config.topicId || !config.operatorId || !config.operatorKey) {
    return { attested: false, reason: 'HCS config incomplete', responseHash, hashAlgo: 'sha256' };
  }

  try {
    const sdk = await import('@hashgraph/sdk').catch(() => null);
    if (!sdk) {
      return {
        attested: false,
        reason: '@hashgraph/sdk not installed — add it as a dep to enable attestation',
        responseHash,
        hashAlgo: 'sha256',
      };
    }
    const { Client, PrivateKey, TopicMessageSubmitTransaction, AccountId, TopicId } = sdk;
    const targetNet = config.network ?? network;
    const client = targetNet === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
    client.setOperator(
      AccountId.fromString(config.operatorId),
      config.operatorKey.startsWith('0x')
        ? PrivateKey.fromStringECDSA(config.operatorKey)
        : PrivateKey.fromString(config.operatorKey),
    );

    const message = JSON.stringify({
      v: 1,
      kind: 'subgraph-query-attestation',
      queryPreview: queryPreview.slice(0, 200),
      responseHash,
      hashAlgo: 'sha256',
      indexer,
      attestedAt: new Date().toISOString(),
    });

    const startedAt = Date.now();
    const submit = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(config.topicId))
      .setMessage(message)
      .execute(client);
    const receipt = await submit.getReceipt(client);
    const finalityMs = Date.now() - startedAt;
    try { client.close(); } catch { /* ignore */ }

    return {
      attested: true,
      responseHash,
      hashAlgo: 'sha256',
      txId: submit.transactionId?.toString(),
      topicId: config.topicId,
      consensusSeq: receipt.topicSequenceNumber?.toString(),
      finalityMs,
      explorerUrl: `https://hashscan.io/${targetNet}/topic/${config.topicId}`,
      network: targetNet,
      attestedAt: new Date(startedAt).toISOString(),
    };
  } catch (e) {
    return {
      attested: false,
      reason: e instanceof Error ? e.message : 'attest failed',
      responseHash,
      hashAlgo: 'sha256',
    };
  }
}
