/**
 * Contract lock for findIntegrityViolations.
 *
 * The state-integrity cron alerts on 4 concrete classes of drift. These
 * cases anchor each class using shapes we actually observed in prod:
 *   - halt untilMs = past (the autohedge halt we manually cleared 2026-07-20)
 *   - alert-response override with expired expiresAtMs (the UNWIND directive
 *     that persisted while profit-lock was already cleared)
 *   - peak with obviously corrupt value
 *   - dust flag whose hedge id is no longer in active DB rows
 */
import { describe, it, expect } from '@jest/globals';
import { findIntegrityViolations } from '@/lib/services/state-integrity/checks';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

describe('findIntegrityViolations', () => {
  it('flags cron:haltUntil:* with untilMs in the past (beyond grace)', () => {
    const v = findIntegrityViolations(
      [{ key: 'cron:haltUntil:sui-community-pool:autohedge', value: NOW - 2 * HOUR }],
      new Set(),
      NOW,
    );
    expect(v).toHaveLength(1);
    expect(v[0].category).toBe('expired-halt');
  });

  it('does NOT flag a halt that expired 1 second ago (within grace window)', () => {
    const v = findIntegrityViolations(
      [{ key: 'cron:haltUntil:polymarket-edge-trader', value: NOW - 1000 }],
      new Set(),
      NOW,
    );
    expect(v).toHaveLength(0);
  });

  it('does NOT flag a halt still in the future', () => {
    const v = findIntegrityViolations(
      [{ key: 'cron:haltUntil:sui-community-pool:autohedge', value: NOW + HOUR }],
      new Set(),
      NOW,
    );
    expect(v).toHaveLength(0);
  });

  it('flags alert-response:* whose expiresAtMs is in the past', () => {
    const v = findIntegrityViolations(
      [{ key: 'alert-response:spot-target-risk-cap', value: { capPct: 0, expiresAtMs: NOW - 2 * HOUR } }],
      new Set(),
      NOW,
    );
    expect(v).toHaveLength(1);
    expect(v[0].category).toBe('expired-directive');
  });

  it('does NOT flag active directives with future expiresAtMs', () => {
    const v = findIntegrityViolations(
      [{ key: 'alert-response:spot-target-risk-cap', value: { capPct: 0, expiresAtMs: NOW + HOUR } }],
      new Set(),
      NOW,
    );
    expect(v).toHaveLength(0);
  });

  it('flags corrupt peaks (negative, absurd magnitude, non-numeric)', () => {
    const v = findIntegrityViolations(
      [
        { key: 'poolNav:peak:community-pool', value: -1 },
        { key: 'poolNav:peak:foo', value: 1e15 },
        { key: 'poolNav:peak:bar', value: 'not-a-number' },
        { key: 'poolNav:peak:good', value: 38.94 }, // known-good
      ],
      new Set(),
      NOW,
    );
    expect(v).toHaveLength(3);
    expect(v.every((x) => x.category === 'corrupt-peak')).toBe(true);
  });

  it('flags stale-dust-flag:* whose hedge id is not in active hedges', () => {
    const v = findIntegrityViolations(
      [{ key: 'stale-dust-flag:999', value: NOW - HOUR }], // orphan (hedge no longer active)
      new Set([190]), // only 190 is active
      NOW,
    );
    expect(v).toHaveLength(1);
    expect(v[0].category).toBe('orphan-dust-flag');
    expect(v[0].key).toBe('stale-dust-flag:999');
  });

  // ── Class-level defense against the permanent-suppression bug ──
  // See sui-hedge-reconcile stale-close block + PR #77 diagnosis. If
  // this class returns (e.g. someone refactors the retry loop and drops
  // the setCronState(key, Date.now()) call), state-integrity fires.

  it('flags stale-dust-flag-ttl-exceeded when active hedge flag > 48h old (2× TTL)', () => {
    const v = findIntegrityViolations(
      [{ key: 'stale-dust-flag:190', value: NOW - 50 * HOUR }],
      new Set([190]), // active
      NOW,
    );
    expect(v).toHaveLength(1);
    expect(v[0].category).toBe('stale-dust-flag-ttl-exceeded');
    expect(v[0].detail).toMatch(/#190/);
  });

  it('does NOT flag a fresh dust flag on an active hedge (within 48h)', () => {
    const v = findIntegrityViolations(
      [{ key: 'stale-dust-flag:190', value: NOW - 6 * HOUR }],
      new Set([190]),
      NOW,
    );
    expect(v).toHaveLength(0);
  });

  it('flags the legacy boolean-true value (the exact permanent-suppression shape)', () => {
    // The prod bug: pre-fix code did setCronState(key, true). Under the
    // fixed integrity check, a legacy boolean on an active hedge means
    // either code regressed or the flag was never touched — flag it.
    const v = findIntegrityViolations(
      [{ key: 'stale-dust-flag:190', value: true }],
      new Set([190]),
      NOW,
    );
    expect(v).toHaveLength(1);
    expect(v[0].category).toBe('stale-dust-flag-ttl-exceeded');
    expect(v[0].detail).toMatch(/legacy boolean/);
  });

  it('returns empty when no drift found', () => {
    const v = findIntegrityViolations(
      [
        { key: 'cron:haltUntil:x', value: NOW + HOUR },
        { key: 'alert-response:y', value: { expiresAtMs: NOW + HOUR } },
        { key: 'poolNav:peak:z', value: 100 },
        { key: 'stale-dust-flag:5', value: NOW - HOUR }, // active + fresh
      ],
      new Set([5]),
      NOW,
    );
    expect(v).toHaveLength(0);
  });
});
