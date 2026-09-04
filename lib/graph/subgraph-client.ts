/**
 * Subgraph client — thin GraphQL POST wrapper.
 *
 * Why: dashboard reads (nav-history, hedges, allocations) are migrating
 * off Aiven Postgres onto our Standardized Vault subgraph (see
 * subgraph/ + HACKATHON_TODO.md Priority 1). This is the read-side
 * client used by every migrated endpoint.
 *
 * Env:
 *   SUBGRAPH_URL              GraphQL endpoint from Subgraph Studio
 *   SUBGRAPH_READS_ENABLED    Feature flag consumed by callers, not here
 *
 * Design: no third-party GraphQL client (no @urql / @apollo). Just fetch
 * + a small typed helper. Every migrated endpoint imports the same
 * `subgraphQuery<T>()` and passes a query string. Keeps bundle small
 * and removes a runtime dep from the hot path.
 */

import { logger } from '@/lib/utils/logger';

export interface SubgraphError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
}

export interface SubgraphResponse<T> {
  data?: T;
  errors?: SubgraphError[];
}

const DEFAULT_TIMEOUT_MS = 8000;

export function getSubgraphUrl(): string | null {
  const raw = process.env.SUBGRAPH_URL?.trim();
  if (!raw || !raw.startsWith('https://')) return null;
  return raw;
}

/**
 * POST a GraphQL query to the subgraph. Returns typed data on success,
 * null on any failure (unreachable, GraphQL errors, timeout, invalid
 * shape). Callers handle null by falling back to Postgres.
 */
export async function subgraphQuery<T>(
  query: string,
  variables?: Record<string, unknown>,
  opts?: { timeoutMs?: number; url?: string },
): Promise<T | null> {
  const url = opts?.url ?? getSubgraphUrl();
  if (!url) return null;

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn('[subgraph] non-2xx', { status: res.status });
      return null;
    }
    const body = (await res.json()) as SubgraphResponse<T>;
    if (body.errors && body.errors.length > 0) {
      logger.warn('[subgraph] GraphQL errors', {
        errors: body.errors.map((e) => e.message).slice(0, 3),
      });
      return null;
    }
    if (!body.data) return null;
    return body.data;
  } catch (e) {
    logger.warn('[subgraph] fetch failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
