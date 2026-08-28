/**
 * Pure state-integrity checks.
 *
 * Detects the classes of drift where cron_state is out of sync with
 * itself — halt keys that expired but weren't cleared, directive
 * overrides past their TTL, dust flags pointing to hedges that no
 * longer exist. Same idea as fsck: nothing broke, but state is
 * inconsistent, and left alone it eventually causes wrong behavior.
 *
 * Route-free so tests can drive the branches without mocking DB.
 */

export interface CronStateEntry {
  key: string;
  value: unknown;
}

export interface IntegrityViolation {
  category:
    | 'expired-halt'
    | 'expired-directive'
    | 'corrupt-peak'
    | 'orphan-dust-flag'
    | 'stale-dust-flag-ttl-exceeded';
  key: string;
  detail: string;
}

const HALT_KEY_PREFIX = 'cron:haltUntil:';
const DIRECTIVE_KEY_PREFIX = 'alert-response:';
const PEAK_KEY_PREFIX = 'poolNav:peak:';
const DUST_FLAG_PREFIX = 'stale-dust-flag:';

// Grace window — a halt that expired 30 sec ago is fine; we're looking
// for state that has been dirty across at least one full cron cycle.
const EXPIRY_GRACE_MS = 10 * 60 * 1000;

// Dust-flag suppression is time-bound at 24h TTL (see
// sui-hedge-reconcile stale-close block). If a flag on an ACTIVE hedge
// is older than 2× TTL, autonomy has had two retry cycles to touch it
// and hasn't — the permanent-suppression bug is back. This class was
// silently in prod 2026-07-22 to 2026-08-28 and let hedge #190 sit
// open for 37d after auto-close was ostensibly enabled.
const DUST_FLAG_TTL_MS = 24 * 60 * 60 * 1000;
const DUST_FLAG_MAX_AGE_MS = 2 * DUST_FLAG_TTL_MS;

export function findIntegrityViolations(
  entries: CronStateEntry[],
  activeHedgeIds: Set<number | string>,
  now: number,
): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  for (const { key, value } of entries) {
    if (key.startsWith(HALT_KEY_PREFIX)) {
      const untilMs = Number(value);
      if (Number.isFinite(untilMs) && untilMs > 0 && untilMs + EXPIRY_GRACE_MS < now) {
        violations.push({
          category: 'expired-halt',
          key,
          detail: `halt until ${new Date(untilMs).toISOString()} — expired ${Math.round((now - untilMs) / 60_000)}min ago, still present`,
        });
      }
    } else if (key.startsWith(DIRECTIVE_KEY_PREFIX)) {
      if (value && typeof value === 'object' && 'expiresAtMs' in (value as Record<string, unknown>)) {
        const expiresAtMs = Number((value as Record<string, unknown>).expiresAtMs);
        if (Number.isFinite(expiresAtMs) && expiresAtMs > 0 && expiresAtMs + EXPIRY_GRACE_MS < now) {
          violations.push({
            category: 'expired-directive',
            key,
            detail: `directive expiresAt ${new Date(expiresAtMs).toISOString()} — expired ${Math.round((now - expiresAtMs) / 60_000)}min ago, still present`,
          });
        }
      }
    } else if (key.startsWith(PEAK_KEY_PREFIX)) {
      const peak = Number(value);
      if (!Number.isFinite(peak) || peak < 0 || peak > 1e12) {
        violations.push({
          category: 'corrupt-peak',
          key,
          detail: `peak = ${JSON.stringify(value)} — outside plausible range [0, 1e12]`,
        });
      }
    } else if (key.startsWith(DUST_FLAG_PREFIX)) {
      const idPart = key.slice(DUST_FLAG_PREFIX.length);
      const asNum = Number(idPart);
      const idInSet = Number.isFinite(asNum) ? activeHedgeIds.has(asNum) : activeHedgeIds.has(idPart);
      if (!idInSet) {
        violations.push({
          category: 'orphan-dust-flag',
          key,
          detail: `dust flag references hedge #${idPart}, but that hedge is not in active DB rows — clean up`,
        });
      } else {
        // Active hedge — check flag age. Fixed code stores Date.now()
        // and auto-retries after 24h. Legacy `true` booleans coerce to
        // Number(true) = 1 (epoch 1ms) → huge age → correctly flagged
        // as broken suppression that let the pre-fix bug hide.
        const flaggedAt = Number(value);
        const flagAgeMs =
          Number.isFinite(flaggedAt) && flaggedAt > 0 ? now - flaggedAt : Infinity;
        if (flagAgeMs > DUST_FLAG_MAX_AGE_MS) {
          violations.push({
            category: 'stale-dust-flag-ttl-exceeded',
            key,
            detail:
              value === true || value === 'true'
                ? `dust flag on active hedge #${idPart} is legacy boolean — should be reset by fixed suppression code within the first retry cycle`
                : `dust flag on active hedge #${idPart} unchanged for ${Math.round(flagAgeMs / 3600_000)}h (max ${DUST_FLAG_MAX_AGE_MS / 3600_000}h) — autonomy retry loop stalled`,
          });
        }
      }
    }
  }
  return violations;
}
