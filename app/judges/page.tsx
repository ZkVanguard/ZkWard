'use client';

import { useEffect, useState } from 'react';

interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  evidence?: string;
  link?: string;
  latencyMs: number;
}

interface Status {
  ok: boolean;
  passed: number;
  total: number;
  failed: string[];
  timestamp: string;
  checks: Check[];
  references: {
    readme: string;
    vault: string;
    auditTopic: string;
    registryTopic: string;
    studioSubgraph: string;
    adapterPackage: string;
    pullRequests: Record<string, string>;
  };
}

export default function JudgesPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string>('');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/judges/status', { cache: 'no-store' });
      const j = (await r.json()) as Status;
      setStatus(j);
      setRefreshedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <main className="min-h-screen bg-system-bg-primary text-label-primary px-6 py-10">
      <div className="max-w-4xl mx-auto">
        <header className="mb-8">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <h1 className="text-3xl font-semibold tracking-tight">Judges — live status</h1>
            <button
              onClick={load}
              disabled={loading}
              className="text-sm text-ios-blue hover:underline disabled:opacity-50"
            >
              {loading ? 'refreshing…' : 'refresh'}
            </button>
          </div>
          <p className="mt-2 text-sm text-label-secondary max-w-2xl">
            Every claim in the README's <a href="https://github.com/ZkVanguard/zkward-ethglobal#-judges--start-here" className="text-ios-blue hover:underline">Judges block</a> checked live against Mirror Node, HCS, our routes, the Studio subgraph, and the npm registry. No stubs. Refreshed {refreshedAt || 'now'}.
          </p>
        </header>

        {error && (
          <div className="mb-6 rounded-lg border border-red-700/40 bg-red-700/10 text-red-700 p-4 text-sm">
            Failed to load status: {error}
          </div>
        )}

        {status && (
          <>
            <div
              className={`mb-6 rounded-xl border p-5 ${
                status.ok
                  ? 'border-green-700/40 bg-green-700/10'
                  : 'border-orange-700/40 bg-orange-700/10'
              }`}
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className={`text-2xl font-semibold ${status.ok ? 'text-green-700' : 'text-orange-700'}`}>
                    {status.passed} / {status.total} green
                  </div>
                  <div className="text-sm text-label-secondary mt-1">
                    {status.ok
                      ? 'All checks passed. Every artifact below is live.'
                      : `${status.failed.length} check(s) not green: ${status.failed.join(', ')}`}
                  </div>
                </div>
                <div className="text-xs text-label-tertiary text-right">
                  as of<br />
                  {new Date(status.timestamp).toISOString()}
                </div>
              </div>
            </div>

            <ol className="space-y-3">
              {status.checks.map((c, i) => (
                <li
                  key={c.id}
                  className="rounded-lg border border-label-tertiary/20 bg-system-bg-secondary p-4"
                >
                  <div className="flex items-start gap-3">
                    <span
                      aria-label={c.ok ? 'pass' : 'fail'}
                      className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                        c.ok ? 'bg-green-700/15 text-green-700' : 'bg-red-700/15 text-red-700'
                      }`}
                    >
                      {c.ok ? '✓' : '✗'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-3 flex-wrap">
                        <div className="font-medium">
                          {i + 1}. {c.label}
                        </div>
                        <div className="text-xs text-label-tertiary">{c.latencyMs}ms</div>
                      </div>
                      <div className="mt-1 text-sm text-label-secondary break-words">{c.detail}</div>
                      {c.link && (
                        <a
                          href={c.link}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 inline-block text-xs text-ios-blue hover:underline break-all"
                        >
                          evidence → {c.link}
                        </a>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>

            <section className="mt-10">
              <h2 className="text-lg font-semibold mb-3">Upstream PRs (open-source contributions)</h2>
              <ul className="space-y-2 text-sm">
                {Object.entries(status.references.pullRequests).map(([k, url]) => (
                  <li key={k}>
                    <span className="text-label-secondary mr-2">{k}:</span>
                    <a href={url} target="_blank" rel="noreferrer" className="text-ios-blue hover:underline break-all">
                      {url}
                    </a>
                  </li>
                ))}
              </ul>
            </section>

            <footer className="mt-10 text-xs text-label-tertiary">
              Machine-readable JSON at{' '}
              <a href="/api/judges/status" className="text-ios-blue hover:underline">
                /api/judges/status
              </a>
              . Every row runs a real HTTP or Mirror Node request server-side; nothing is cached.
            </footer>
          </>
        )}

        {loading && !status && (
          <div className="text-label-secondary text-sm">Running 10 live checks…</div>
        )}
      </div>
    </main>
  );
}
