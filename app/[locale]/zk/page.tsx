'use client';

import { useEffect, useState } from 'react';
import { Link } from '@/i18n/routing';
import { Shield, Cpu, Lock, CheckCircle2, ArrowRight, ExternalLink } from 'lucide-react';
import { Section, SectionHeader, StatusPill, TrustBadge, Reveal } from '@/components/ui/landing';

// Single focused ZK page. Replaces the three separate /zk-authenticity, /zk-proof,
// and /zk-verification pages that grew independently and drifted apart. Structure:
//   1. Hero — what STARK-attested vault means.
//   2. Live prover health — is the Python STARK backend up right now.
//   3. Explainer — how the STARK works.
//   4. Security parameters — honest about field choice and soundness.
//   5. Verify widget — paste a proof hash, we tell you if it's on-chain.
//   6. Deep-dive links — old pages moved to sub-routes.

interface ProverHealth {
  status: 'healthy' | 'unhealthy' | 'unavailable';
  cuda_available?: boolean;
  cuda_enabled?: boolean;
  backend?: string;
  error?: string;
}

const HOW_STEPS = [
  {
    icon: Lock,
    title: 'Trace the computation',
    body: 'Each agent decision (allocation percentages, hedge sizing, risk score) compiles into an execution trace: a matrix of intermediate states the prover walks through.',
  },
  {
    icon: Shield,
    title: 'Commit and prove',
    body: 'AIR constraints on the trace are extended and folded through FRI (Fast Reed-Solomon IOP). Merkle-committed with SHA-256. Fiat-Shamir non-interactivity.',
  },
  {
    icon: CheckCircle2,
    title: 'Verify anywhere',
    body: 'Proofs are 10 to 50 KB. Verification is 50 to 200 ms off-chain and constant-time. No interaction with the prover, no trust in the AI, no revealing the underlying data.',
  },
] as const;

export default function ZkPage() {
  const [health, setHealth] = useState<ProverHealth | null>(null);
  const [verifyInput, setVerifyInput] = useState('');
  const [verifyResult, setVerifyResult] = useState<null | { found: boolean; detail?: string }>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);

  useEffect(() => {
    fetch('/api/zk-proof/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ status: 'unavailable' }));
  }, []);

  const verify = async () => {
    const q = verifyInput.trim();
    if (!q) return;
    setVerifyLoading(true);
    setVerifyResult(null);
    try {
      const r = await fetch(`/api/zk-proof/lookup?hash=${encodeURIComponent(q)}`, { cache: 'no-store' });
      const data = await r.json();
      if (r.ok && data?.found) {
        setVerifyResult({ found: true, detail: data.detail || `Verified on-chain at ${data.timestamp ?? 'unknown time'}` });
      } else {
        setVerifyResult({ found: false, detail: data?.error || 'Proof not found on-chain. Check the hash and try again.' });
      }
    } catch (e) {
      setVerifyResult({ found: false, detail: e instanceof Error ? e.message : 'Verification failed' });
    } finally {
      setVerifyLoading(false);
    }
  };

  const proverStatusDot =
    health?.status === 'healthy' ? 'bg-ios-green' :
    health?.status === 'unhealthy' ? 'bg-ios-orange' :
    health?.status === 'unavailable' ? 'bg-ios-red' : 'bg-separator-opaque';

  const proverStatusLabel = health ? (
    health.status === 'healthy' ? 'Online' :
    health.status === 'unhealthy' ? 'Degraded' : 'Offline'
  ) : 'Checking…';

  return (
    <div className="bg-system-bg-primary text-label-primary min-h-screen">
      {/* HERO */}
      <section className="pt-20 pb-8 sm:pt-32 sm:pb-16 px-4 sm:px-5 lg:px-8 min-w-0">
        <div className="max-w-[900px] mx-auto text-center">
          <div className="flex justify-center mb-8">
            <StatusPill
              left={
                <>
                  <Shield className="w-3.5 h-3.5 text-ios-blue" />
                  <span className="text-footnote font-medium text-label-secondary">
                    ZK-STARK · Post-Quantum · No Trusted Setup
                  </span>
                </>
              }
            />
          </div>
          <h1 className="font-display font-semibold text-[36px] sm:text-[56px] md:text-[68px] lg:text-[80px] tracking-[-0.04em] leading-[0.96] text-label-primary mb-5 sm:mb-6 break-words">
            Every vault decision,
            <br />
            cryptographically attested.
          </h1>
          <p className="text-base sm:text-[19px] text-label-secondary max-w-[620px] mx-auto leading-relaxed">
            When our AI agents commit to a hedge, allocation, or rebalance, the decision is proven correct with a
            zero-knowledge STARK. No trusted setup. Post-quantum secure by construction. Verifiable by anyone.
          </p>
        </div>
      </section>

      {/* LIVE PROVER STATUS */}
      <Section size="sm">
        <div className="max-w-[720px] mx-auto">
          <div className="bg-system-bg-primary rounded-[24px] border border-separator-opaque/40 shadow-ios-2 p-5 sm:p-7 overflow-hidden">
            <div className="flex items-center justify-between mb-5">
              <div className="min-w-0 flex-1">
                <div className="text-[10px] sm:text-caption-1 uppercase tracking-wide font-semibold text-label-tertiary mb-1.5">
                  Prover backend
                </div>
                <div className="text-title-2 font-semibold text-label-primary">
                  {proverStatusLabel}
                </div>
              </div>
              <div className={`w-3 h-3 rounded-full flex-shrink-0 ml-3 ${proverStatusDot}`} />
            </div>
            {health && (
              <div className="grid grid-cols-2 gap-4 pt-5 border-t border-separator-opaque/30">
                <div className="min-w-0">
                  <div className="text-caption-1 uppercase tracking-wide font-semibold text-label-tertiary mb-1">CUDA</div>
                  <div className="text-label-primary font-medium flex items-center gap-2 text-callout">
                    {health.cuda_enabled ? (
                      <>
                        <Cpu className="w-4 h-4 text-ios-green flex-shrink-0" /> Accelerated
                      </>
                    ) : health.cuda_available ? (
                      'Available'
                    ) : (
                      'CPU only'
                    )}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="text-caption-1 uppercase tracking-wide font-semibold text-label-tertiary mb-1">Endpoint</div>
                  <div className="text-label-primary font-medium truncate text-callout">{health.backend || '…'}</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </Section>

      {/* HOW IT WORKS */}
      <Section tone="secondary" size="md">
        <Reveal>
          <SectionHeader
            eyebrow="How it works"
            title="Trace. Commit. Verify."
            lede="Three moves. The prover produces the artifact. The verifier reads it in milliseconds. Nothing about your position leaks either way."
          />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
            {HOW_STEPS.map(({ icon: Icon, title, body }) => (
              <div key={title} className="bg-system-bg-primary rounded-ios-xl border border-separator-opaque/30 p-5 sm:p-6 shadow-ios-1">
                <div className="w-10 h-10 rounded-ios bg-ios-blue/10 flex items-center justify-center mb-3">
                  <Icon className="w-5 h-5 text-ios-blue" />
                </div>
                <h3 className="font-semibold text-label-primary mb-2 text-headline">{title}</h3>
                <p className="text-label-secondary text-callout leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </Section>

      {/* SECURITY PARAMETERS */}
      <Section size="md">
        <Reveal>
          <SectionHeader
            eyebrow="Security"
            title="Parameters, no marketing."
            align="left"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            <TrustBadge
              icon={<Lock className="w-5 h-5" />}
              title="Field"
              value="Goldilocks-64"
              hint="NIST P-521 prime available as fallback"
            />
            <TrustBadge
              icon={<Shield className="w-5 h-5" />}
              title="Commitments"
              value="SHA-256"
              hint="Merkle trees · Fiat-Shamir non-interactive"
            />
            <TrustBadge
              icon={<CheckCircle2 className="w-5 h-5" />}
              title="Soundness"
              value="~180 bits"
              hint="FRI queries plus grinding, above PQ requirements"
            />
            <TrustBadge
              icon={<Shield className="w-5 h-5" />}
              title="Trusted setup"
              value="None"
              hint="Hash-based commitments only"
            />
            <TrustBadge
              icon={<CheckCircle2 className="w-5 h-5" />}
              title="Post-quantum"
              value="Yes"
              hint="No discrete-log or factoring assumption"
            />
            <TrustBadge
              icon={<Cpu className="w-5 h-5" />}
              title="Acceleration"
              value="CUDA"
              hint="CuPy / Numba with CPU fallback"
            />
          </div>
        </Reveal>
      </Section>

      {/* VERIFY WIDGET */}
      <Section tone="secondary" size="md">
        <Reveal>
          <div className="max-w-[720px] mx-auto">
            <SectionHeader
              title="Verify a proof."
              lede="Paste a proof hash (0x…) or transaction digest from the vault's activity log. We'll check whether it's recorded on-chain and return its details."
              align="left"
            />
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                inputMode="text"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={verifyInput}
                onChange={(e) => setVerifyInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && verify()}
                placeholder="0x…"
                className="flex-1 h-12 px-4 rounded-xl border border-separator-opaque bg-system-bg-primary focus:border-ios-blue focus:outline-none text-label-primary font-mono text-sm w-full min-w-0"
              />
              <button
                onClick={verify}
                disabled={verifyLoading || !verifyInput.trim()}
                className="h-12 px-6 rounded-xl bg-ios-blue text-white font-semibold hover:bg-[#0062CC] transition-colors disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto flex-shrink-0 active:scale-[0.97]"
              >
                {verifyLoading ? 'Checking…' : 'Verify'}
              </button>
            </div>
            {verifyResult && (
              <div className={`mt-4 p-4 rounded-xl border ${
                verifyResult.found
                  ? 'bg-ios-green/10 border-ios-green/30 text-[#0F5132]'
                  : 'bg-ios-red/10 border-ios-red/30 text-[#842029]'
              }`}>
                <div className="flex items-start gap-3">
                  {verifyResult.found ? (
                    <CheckCircle2 className="w-5 h-5 mt-0.5 flex-shrink-0" />
                  ) : (
                    <ExternalLink className="w-5 h-5 mt-0.5 flex-shrink-0 opacity-70" />
                  )}
                  <div className="text-sm leading-relaxed break-words min-w-0">{verifyResult.detail}</div>
                </div>
              </div>
            )}
          </div>
        </Reveal>
      </Section>

      {/* VERIFY YOURSELF — real code, real API. Open source is the moat. */}
      <Section size="md">
        <Reveal>
          <SectionHeader
            eyebrow="Open source"
            title="Verify it yourself."
            lede="One HTTP call. No SDK. Every attestation the vault posts is publicly checkable."
            align="left"
          />
          <div className="bg-label-primary rounded-[20px] overflow-hidden shadow-ios-2">
            <div className="flex items-center justify-between px-5 sm:px-6 py-3 border-b border-white/10">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-ios-red/70" />
                <span className="w-2.5 h-2.5 rounded-full bg-ios-orange/70" />
                <span className="w-2.5 h-2.5 rounded-full bg-ios-green/70" />
              </div>
              <span className="text-caption-1 text-white/60 font-mono">verify.sh</span>
            </div>
            <pre className="p-5 sm:p-6 overflow-x-auto text-subheadline text-white font-mono leading-relaxed">
{`# Look up any proof hash the vault has posted
curl "https://www.zkward.com/api/zk-proof/lookup?hash=0xa3..2f"

# Response:
# {
#   "found": true,
#   "backend": "CUDATrueSTARK",
#   "field": "Goldilocks-64",
#   "soundness_bits": 180,
#   "timestamp": "2026-08-26T14:07:12Z",
#   "on_chain_tx": "0x..."
# }`}
            </pre>
          </div>
          <div className="mt-4 flex flex-wrap gap-3 items-center text-caption-1 text-label-tertiary">
            <span>Source:</span>
            <a
              href="https://github.com/ZkVanguard/ZkVanguard/tree/main/zkp"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-ios-blue hover:underline font-mono"
            >
              zkp/ <ExternalLink className="w-3 h-3" />
            </a>
            <span>·</span>
            <a
              href="https://github.com/ZkVanguard/ZkVanguard/blob/main/zkp/api/server.py"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-ios-blue hover:underline font-mono"
            >
              api/server.py <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </Reveal>
      </Section>

      {/* DEEP DIVE */}
      <Section tone="secondary" size="md">
        <Reveal>
          <SectionHeader
            title="Go deeper."
            align="left"
          />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
            {[
              { href: '/zk-authenticity', title: 'Implementation authenticity', body: "Prove the STARK isn't simulated. CUDA specs, field parameters, source-verifiable." },
              { href: '/zk-proof', title: 'Generate your own', body: 'Interactive prover UI: trace, commit, prove, verify. Wallet-signed statements.' },
              { href: '/zk-verification', title: 'Hedge attestations', body: 'Look up ZK-attested hedges by hedge ID or wallet address.' },
            ].map(({ href, title, body }) => (
              <Link
                key={href}
                href={href}
                className="group block p-5 sm:p-6 rounded-ios-xl border border-separator-opaque/30 bg-system-bg-primary hover:border-ios-blue/50 hover:shadow-ios-2 active:scale-[0.99] transition-all"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-label-primary text-headline">{title}</span>
                  <ArrowRight className="w-4 h-4 text-label-tertiary group-hover:text-ios-blue group-hover:translate-x-1 transition-all flex-shrink-0 ml-2" />
                </div>
                <p className="text-sm text-label-secondary leading-relaxed">{body}</p>
              </Link>
            ))}
          </div>
        </Reveal>
      </Section>
    </div>
  );
}
