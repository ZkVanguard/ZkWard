/**
 * Privy config — server-safe surface.
 *
 * Split from privy-client-config.ts so server routes (e.g. Privy JWT
 * verification in lib/services/privy/admin-auth.ts) can import env
 * helpers without pulling in wagmi ESM through the chain-list. Jest's
 * transformer chokes on wagmi's `export ... from` syntax in a Node
 * test environment, so keeping the two surfaces separate lets unit
 * tests exercise this file in isolation.
 */

/** True when Privy env is configured — gates every code path. */
export function isPrivyEnabled(): boolean {
  return Boolean((process.env.NEXT_PUBLIC_PRIVY_APP_ID || '').trim());
}

export function getPrivyAppId(): string {
  return (process.env.NEXT_PUBLIC_PRIVY_APP_ID || '').trim();
}

/** Server-side operator secret. NEVER expose. */
export function getPrivyAppSecret(): string {
  return (process.env.PRIVY_APP_SECRET || '').trim();
}

/**
 * Admin allowlist — DIDs / email addresses / Privy user IDs allowed to
 * execute B2B admin actions. Read from env so operators can rotate
 * without a redeploy.
 *
 * Format: comma-separated list of Privy `userId` values (did:privy:...)
 * or the literal `email:<addr>` for an email match.
 *
 * Example: PRIVY_ADMIN_ALLOWLIST="did:privy:abc,email:ops@zkward.com"
 */
export function getPrivyAdminAllowlist(): string[] {
  const raw = (process.env.PRIVY_ADMIN_ALLOWLIST || '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Minimum quorum for admin actions (default 1 for hackathon; ≥2 in prod). */
export function getPrivyAdminQuorum(): number {
  const raw = (process.env.PRIVY_ADMIN_QUORUM || '1').trim();
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
