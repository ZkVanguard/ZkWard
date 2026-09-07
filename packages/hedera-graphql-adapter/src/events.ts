/**
 * Event decoding helpers.
 *
 * We only support the subset of ABI-decoding needed by our presets:
 *   - keccak of canonical signature → topic0
 *   - split log data into 32-byte words → BigInt / address / bool
 *
 * No ethers/viem dep — we use Node's built-in crypto for keccak256 via
 * the Web Crypto API where available; otherwise callers should install
 * `@noble/hashes`. To keep zero-dep, presets ship precomputed topic0
 * hashes for their events.
 */

import type { DecodedLog } from './types.js';
import type { MirrorLog } from './mirror.js';
import { mirrorTimestampToSec } from './mirror.js';

/** Left-pad a topic to an EVM address. */
export function topicToAddress(topic: string | undefined): string {
  if (!topic) return '0x' + '0'.repeat(40);
  return '0x' + topic.slice(-40).toLowerCase();
}

/** Decode one uint256 from log data at offset (in 32-byte words). */
export function decodeUint(data: string, wordOffset = 0): bigint {
  if (!data || data === '0x') return 0n;
  const chunk = data.slice(2 + wordOffset * 64, 2 + (wordOffset + 1) * 64);
  if (!chunk) return 0n;
  return BigInt('0x' + chunk);
}

/**
 * Turn a raw Mirror Node log into our normalized DecodedLog shape.
 * Preset code then does the type-specific interpretation.
 */
export function normalizeLog(log: MirrorLog): DecodedLog {
  const topic0 = log.topics[0]?.toLowerCase() ?? '';
  return {
    signature: topic0,
    topic0,
    indexedTopics: log.topics.slice(1),
    data: log.data,
    block: log.block_number,
    timestamp: log.timestamp,
    timestampSec: mirrorTimestampToSec(log.timestamp),
    transactionHash: log.transaction_hash,
    logIndex: log.index,
    actor: topicToAddress(log.topics[1]),
  };
}
