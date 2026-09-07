'use client';

/**
 * Multi-chain AI Vaults panel — same GraphQL query fires against two
 * endpoints with different indexing backends:
 *   - The Graph Studio (Sepolia CommunityPool + any future SimpleUsdcVault)
 *   - Hedera Mirror Node adapter at /api/subgraph/hedera
 *
 * Both return the SAME shape ({ pools, transactions, members, _meta }).
 * Judges click "Copy query" and can paste into either endpoint's
 * playground — one query, two indexing backends, one schema.
 *
 * This is the composable/standards story: the AI-vault entity model
 * abstracts over indexing infrastructure, not just chains.
 */

import { useQuery } from '@tanstack/react-query';
import { Copy, Check, ExternalLink, Zap, Database, Activity } from 'lucide-react';
import { useState } from 'react';

const STUDIO_URL = 'https://api.studio.thegraph.com/query/1758819/zkward/v0.1.1';
const HEDERA_URL = '/api/subgraph/hedera';

const UNIFIED_QUERY = `{
  pools(first: 5) {
    id
    network
    totalShares
    totalNav
    sharePrice
    memberCount
  }
  transactions(first: 5) {
    type
    actor
    amount
    shares
    timestamp
  }
  _meta {
    block { number timestamp }
    deployment
    hasIndexingErrors
  }
}`;

interface PoolRow {
  id: string;
  network: string;
  totalShares: string;
  totalNav: string;
  sharePrice: string;
  memberCount: number;
}

interface TxRow {
  type: string;
  actor: string;
  amount: string;
  shares: string;
  timestamp: string;
}

interface GraphResponse {
  data?: {
    pools?: PoolRow[];
    transactions?: TxRow[];
    _meta?: {
      block: { number: number; timestamp: number };
      deployment: string;
      hasIndexingErrors: boolean;
    };
  };
  errors?: Array<{ message: string }>;
}

async function runQuery(endpoint: string): Promise<GraphResponse> {
  const isAbsolute = endpoint.startsWith('http');
  const url = isAbsolute ? endpoint : endpoint;
  const t0 = performance.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: UNIFIED_QUERY }),
  });
  const j = (await r.json()) as GraphResponse;
  const elapsed = Math.round(performance.now() - t0);
  return { ...j, _elapsed: elapsed } as GraphResponse & { _elapsed: number };
}

function fmtUsdc(microStr: string): string {
  const n = Number(microStr) / 1e6;
  if (n < 0.01) return n.toFixed(4);
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function truncAddr(a: string): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
}

function timeAgo(sec: string): string {
  const s = Math.floor(Date.now() / 1000) - Number(sec);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function MultiChainVaultsPanel() {
  const [copied, setCopied] = useState(false);

  const studioQ = useQuery({
    queryKey: ['subgraph', 'studio'],
    queryFn: () => runQuery(STUDIO_URL),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const hederaQ = useQuery({
    queryKey: ['subgraph', 'hedera-adapter'],
    queryFn: () => runQuery(HEDERA_URL),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const onCopyQuery = async () => {
    try {
      await navigator.clipboard.writeText(UNIFIED_QUERY);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard denied */ }
  };

  return (
    <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-system-bg-primary overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2 flex-wrap">
        <Database className="w-4 h-4 text-[#6F4CFF]" />
        <h3 className="text-sm font-semibold text-label-primary">Multi-chain AI Vaults</h3>
        <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide bg-[#6F4CFF15] text-[#6F4CFF]">
          One schema · two backends
        </span>
        <button
          onClick={onCopyQuery}
          className="ml-auto inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md border border-gray-200 dark:border-gray-700 hover:bg-fill-quaternary transition"
          title="Copy the GraphQL query — paste into either playground"
        >
          {copied ? <Check className="w-3 h-3 text-[#34C759]" /> : <Copy className="w-3 h-3" />}
          <span>{copied ? 'Copied' : 'Copy query'}</span>
        </button>
      </div>

      <div className="px-4 py-2.5 text-[11px] text-label-tertiary leading-relaxed border-b border-gray-100 dark:border-gray-700">
        Identical GraphQL query fires against both endpoints. Same
        <span className="font-semibold text-label-secondary"> pools / transactions / _meta </span>
        shape. Different indexing backends: The Graph Studio (Sepolia) + our
        Mirror Node adapter (Hedera).
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 divide-x divide-gray-100 dark:divide-gray-700">
        <BackendCard
          label="The Graph Studio"
          endpoint={STUDIO_URL}
          badge="Sepolia · The Graph"
          badgeColor="#00A79F"
          data={studioQ.data}
          isLoading={studioQ.isLoading}
          isError={studioQ.isError}
        />
        <BackendCard
          label="Hedera Mirror Node adapter"
          endpoint={HEDERA_URL}
          badge="Hedera · Mirror Node"
          badgeColor="#6F4CFF"
          data={hederaQ.data}
          isLoading={hederaQ.isLoading}
          isError={hederaQ.isError}
          endpointHref="/api/subgraph/hedera"
        />
      </div>
    </div>
  );
}

interface BackendCardProps {
  label: string;
  endpoint: string;
  endpointHref?: string;
  badge: string;
  badgeColor: string;
  data?: GraphResponse & { _elapsed?: number };
  isLoading: boolean;
  isError: boolean;
}

function BackendCard({ label, endpoint, endpointHref, badge, badgeColor, data, isLoading, isError }: BackendCardProps) {
  const pools = data?.data?.pools ?? [];
  const txs = data?.data?.transactions ?? [];
  const meta = data?.data?._meta;
  const hasErrors = isError || (data?.errors && data.errors.length > 0);
  const errorMsg = data?.errors?.[0]?.message;

  return (
    <div className="p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span
          className="text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide"
          style={{ background: `${badgeColor}15`, color: badgeColor }}
        >
          {badge}
        </span>
        <span className="text-[11px] text-label-secondary font-semibold">{label}</span>
        {data?._elapsed && (
          <span className="text-[10px] text-label-tertiary tabular-nums">{data._elapsed}ms</span>
        )}
        <a
          href={endpointHref ?? endpoint}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-label-tertiary hover:text-label-primary transition"
          title={endpoint}
        >
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      {isLoading && (
        <div className="text-[11px] text-label-tertiary py-4 text-center">Loading…</div>
      )}

      {hasErrors && (
        <div className="text-[11px] text-red-700 bg-red-50 dark:bg-red-950/30 rounded-md p-2 mb-2">
          {errorMsg ?? 'query failed'}
        </div>
      )}

      {!isLoading && !hasErrors && (
        <>
          {/* Pool row */}
          {pools.length === 0 ? (
            <div className="text-[11px] text-label-tertiary py-2">No pools indexed yet.</div>
          ) : (
            pools.map((p) => (
              <div
                key={p.id}
                className="rounded-lg bg-system-bg-secondary p-2.5 mb-2 space-y-1"
              >
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-mono text-label-secondary">{truncAddr(p.id)}</span>
                  <span className="text-label-tertiary">{p.network}</span>
                </div>
                <div className="grid grid-cols-3 gap-1 text-[11px]">
                  <Stat label="TVL" value={`$${fmtUsdc(p.totalNav)}`} />
                  <Stat label="Shares" value={fmtUsdc(p.totalShares)} />
                  <Stat label="Members" value={String(p.memberCount)} />
                </div>
              </div>
            ))
          )}

          {/* Recent txs */}
          {txs.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] uppercase tracking-wide text-label-tertiary mb-1 flex items-center gap-1">
                <Activity className="w-2.5 h-2.5" /> Recent
              </div>
              <div className="space-y-1">
                {txs.slice(0, 3).map((t, i) => (
                  <div key={i} className="flex items-center justify-between text-[10.5px] bg-system-bg-secondary rounded px-2 py-1">
                    <span className={t.type === 'DEPOSIT' ? 'text-[#34C759] font-semibold' : 'text-[#FF9500] font-semibold'}>
                      {t.type}
                    </span>
                    <span className="font-mono text-label-tertiary">{truncAddr(t.actor)}</span>
                    <span className="tabular-nums">${fmtUsdc(t.amount)}</span>
                    <span className="text-label-tertiary">{timeAgo(t.timestamp)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {meta && (
            <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700 flex items-center gap-2 text-[10px] text-label-tertiary">
              <Zap className="w-2.5 h-2.5" />
              <span>Block {meta.block.number.toLocaleString()}</span>
              <span>·</span>
              <span className={meta.hasIndexingErrors ? 'text-red-700' : 'text-[#34C759]'}>
                {meta.hasIndexingErrors ? 'errors' : 'ok'}
              </span>
              <span className="ml-auto font-mono truncate max-w-[45%]" title={meta.deployment}>
                {meta.deployment.slice(0, 20)}…
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase text-label-tertiary">{label}</div>
      <div className="text-[12px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}
