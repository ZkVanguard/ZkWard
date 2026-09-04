/**
 * HCS-14 DID builder — lock the doc shape so a future refactor can't
 * silently break the on-chain identity contract that A2A negotiation
 * would depend on.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  buildDidDocument,
  DEFAULT_AGENT_ROSTER,
  type AgentIdentity,
} from '@/lib/services/hedera/agent-identity';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
  process.env.HCS_AGENT_IDENTITY_TOPIC_ID = '0.0.1234567';
  process.env.HEDERA_NETWORK = 'testnet';
});

const sample: AgentIdentity = {
  agentId: 'risk-analyst',
  name: 'Risk Analyst',
  version: 'v0.4.0',
  capabilities: ['risk-analysis'],
  publicKeyHex: '0x' + 'a'.repeat(64),
  budget: { perCallMicros: '250', dailyCapMicros: '2000000' },
  metadata: { endpoint: 'https://zkward.com/api/agents/risk-analyst' },
};

describe('buildDidDocument', () => {
  it('produces a W3C-shaped DID document', () => {
    const doc = buildDidDocument(sample);
    expect(doc['@context']).toEqual(['https://www.w3.org/ns/did/v1']);
    expect(doc.id).toBe('did:hedera:testnet:0.0.1234567#risk-analyst');
    expect(doc.verificationMethod).toHaveLength(1);
    expect(doc.verificationMethod[0].type).toBe('Ed25519VerificationKey2020');
    expect(doc.verificationMethod[0].publicKeyHex).toBe(sample.publicKeyHex);
  });

  it('includes AgentEndpoint service when metadata.endpoint set', () => {
    const doc = buildDidDocument(sample);
    const endpoint = doc.service.find((s) => s.type === 'AgentEndpoint');
    expect(endpoint).toBeDefined();
    expect(endpoint!.serviceEndpoint).toBe(sample.metadata!.endpoint);
  });

  it('includes BudgetHints service with USDC + network context', () => {
    const doc = buildDidDocument(sample);
    const budget = doc.service.find((s) => s.type === 'BudgetHints');
    expect(budget).toBeDefined();
    const bhints = budget!.serviceEndpoint as Record<string, string>;
    expect(bhints.perCallMicros).toBe('250');
    expect(bhints.dailyCapMicros).toBe('2000000');
    expect(bhints.currency).toBe('USDC');
    expect(bhints.network).toBe('hedera-testnet');
  });

  it('respects mainnet vs testnet in DID + network fields', () => {
    process.env.HEDERA_NETWORK = 'mainnet';
    const doc = buildDidDocument(sample);
    expect(doc.id).toContain(':mainnet:');
    const budget = doc.service.find((s) => s.type === 'BudgetHints');
    const bhints = budget!.serviceEndpoint as Record<string, string>;
    expect(bhints.network).toBe('hedera-mainnet');
  });

  it('emits agent name + version + capabilities in the doc for discovery', () => {
    const doc = buildDidDocument(sample);
    expect(doc.agent.name).toBe(sample.name);
    expect(doc.agent.version).toBe(sample.version);
    expect(doc.agent.capabilities).toContain('risk-analysis');
  });

  it('omits BudgetHints when budget is not supplied', () => {
    const noBudget: AgentIdentity = { ...sample, budget: undefined };
    const doc = buildDidDocument(noBudget);
    const budget = doc.service.find((s) => s.type === 'BudgetHints');
    expect(budget).toBeUndefined();
  });
});

describe('DEFAULT_AGENT_ROSTER', () => {
  it('covers the full 7-agent orchestrator', () => {
    expect(DEFAULT_AGENT_ROSTER).toHaveLength(7);
    const ids = DEFAULT_AGENT_ROSTER.map((a) => a.agentId).sort();
    expect(ids).toEqual([
      'allocation-strategist',
      'audit-reviewer',
      'fee-collector',
      'hedge-manager',
      'risk-analyst',
      'signal-fusion',
      'trade-executor',
    ]);
  });

  it('every agent has a distinct id + publicKeyHex', () => {
    const ids = new Set(DEFAULT_AGENT_ROSTER.map((a) => a.agentId));
    const keys = new Set(DEFAULT_AGENT_ROSTER.map((a) => a.publicKeyHex));
    expect(ids.size).toBe(DEFAULT_AGENT_ROSTER.length);
    expect(keys.size).toBe(DEFAULT_AGENT_ROSTER.length);
  });
});
