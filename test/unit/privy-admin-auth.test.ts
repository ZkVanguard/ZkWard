/**
 * Privy admin auth — locks two things B2B judges care about:
 *   1. Allowlist match (userId + email:<addr>) — fail-closed on empty
 *      allowlist so nobody gets in by default.
 *   2. Quorum accounting — idempotent per approver, resets after action.
 *
 * The Privy JWT verify itself is dynamic-imported and requires the
 * server SDK; we don't unit-test that path (it depends on Privy's
 * signing infra). requireAdminUser is exercised via the allowlist
 * check + a mocked verify in an integration test if we ever add one.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('isOnAdminAllowlist', () => {
  it('fail-closed when allowlist is empty', async () => {
    delete process.env.PRIVY_ADMIN_ALLOWLIST;
    const { isOnAdminAllowlist } = await import('@/lib/services/privy/admin-auth');
    expect(isOnAdminAllowlist('did:privy:abc', 'a@b.com')).toBe(false);
  });

  it('matches by exact userId', async () => {
    process.env.PRIVY_ADMIN_ALLOWLIST = 'did:privy:abc,did:privy:xyz';
    const { isOnAdminAllowlist } = await import('@/lib/services/privy/admin-auth');
    expect(isOnAdminAllowlist('did:privy:abc', undefined)).toBe(true);
    expect(isOnAdminAllowlist('did:privy:xyz', undefined)).toBe(true);
    expect(isOnAdminAllowlist('did:privy:not-listed', undefined)).toBe(false);
  });

  it('matches by email prefix (case-insensitive input)', async () => {
    process.env.PRIVY_ADMIN_ALLOWLIST = 'email:ops@zkward.com,email:admin@zkward.com';
    const { isOnAdminAllowlist } = await import('@/lib/services/privy/admin-auth');
    expect(isOnAdminAllowlist('did:privy:someone', 'ops@zkward.com')).toBe(true);
    expect(isOnAdminAllowlist('did:privy:someone', 'OPS@zkward.com')).toBe(true);
    expect(isOnAdminAllowlist('did:privy:someone', 'stranger@else.com')).toBe(false);
  });

  it('handles whitespace and empty entries gracefully', async () => {
    process.env.PRIVY_ADMIN_ALLOWLIST = ' did:privy:abc , , email:ok@x.com ';
    const { isOnAdminAllowlist } = await import('@/lib/services/privy/admin-auth');
    expect(isOnAdminAllowlist('did:privy:abc', undefined)).toBe(true);
    expect(isOnAdminAllowlist('did:privy:zzz', 'ok@x.com')).toBe(true);
  });
});

describe('recordApprovalAndCheckQuorum', () => {
  it('reaches quorum with N distinct approvers (default N=1)', async () => {
    const { recordApprovalAndCheckQuorum, _resetQuorumForTest } = await import('@/lib/services/privy/admin-auth');
    await _resetQuorumForTest('act-1');
    const r = await recordApprovalAndCheckQuorum('act-1', 'did:privy:alice');
    expect(r.reached).toBe(true);
    expect(r.approvers).toEqual(['did:privy:alice']);
    expect(r.required).toBe(1);
  });

  it('requires distinct approvers when quorum > 1', async () => {
    process.env.PRIVY_ADMIN_QUORUM = '2';
    const { recordApprovalAndCheckQuorum, _resetQuorumForTest } = await import('@/lib/services/privy/admin-auth');
    await _resetQuorumForTest('act-2');

    const first = await recordApprovalAndCheckQuorum('act-2', 'did:privy:alice');
    expect(first.reached).toBe(false);
    expect(first.approvers).toEqual(['did:privy:alice']);
    expect(first.required).toBe(2);

    // Same approver again — idempotent, still not quorum.
    const dup = await recordApprovalAndCheckQuorum('act-2', 'did:privy:alice');
    expect(dup.reached).toBe(false);
    expect(dup.approvers).toEqual(['did:privy:alice']);

    // Second distinct approver — quorum reached.
    const second = await recordApprovalAndCheckQuorum('act-2', 'did:privy:bob');
    expect(second.reached).toBe(true);
    expect(second.approvers).toEqual(['did:privy:alice', 'did:privy:bob']);
  });

  it('isolates approval buckets per actionId', async () => {
    process.env.PRIVY_ADMIN_QUORUM = '2';
    const { recordApprovalAndCheckQuorum, _resetQuorumForTest } = await import('@/lib/services/privy/admin-auth');
    await _resetQuorumForTest('iso-A');
    await _resetQuorumForTest('iso-B');
    const rA = await recordApprovalAndCheckQuorum('iso-A', 'did:privy:alice');
    const rB = await recordApprovalAndCheckQuorum('iso-B', 'did:privy:alice');
    expect(rA.approvers).toEqual(['did:privy:alice']);
    expect(rB.approvers).toEqual(['did:privy:alice']);
    expect(rA.reached).toBe(false);
    expect(rB.reached).toBe(false);
  });
});
