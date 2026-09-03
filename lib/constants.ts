/**
 * Reserved portfolio IDs for community pools.
 *
 * RWAManager.sol assigns user portfolios starting at 0 (uint256), so any
 * negative sentinel is guaranteed not to collide. One reservation per chain
 * so multi-chain pools can coexist in the same DB.
 *
 *   -1  EVM community pool (Cronos, legacy)
 *   -2  SUI USDC community pool
 *   -3  Hedera community pool
 *   -4  Sepolia community pool
 *   -5  Reserved for the next EVM chain (Arbitrum / Base / Plasma / Stable)
 */
export const COMMUNITY_POOL_PORTFOLIO_ID = -1;
export const SUI_COMMUNITY_POOL_PORTFOLIO_ID = -2;
export const HEDERA_COMMUNITY_POOL_PORTFOLIO_ID = -3;
export const SEPOLIA_COMMUNITY_POOL_PORTFOLIO_ID = -4;
export const RESERVED_POOL_PORTFOLIO_ID_5 = -5;

const RESERVED_POOL_IDS: ReadonlySet<number> = new Set([
  COMMUNITY_POOL_PORTFOLIO_ID,
  SUI_COMMUNITY_POOL_PORTFOLIO_ID,
  HEDERA_COMMUNITY_POOL_PORTFOLIO_ID,
  SEPOLIA_COMMUNITY_POOL_PORTFOLIO_ID,
  RESERVED_POOL_PORTFOLIO_ID_5,
]);

/**
 * Check if a portfolio ID represents any community pool.
 * Widened for multi-chain: matches every reserved sentinel.
 */
export function isCommunityPoolPortfolio(portfolioId: number | null | undefined): boolean {
  return typeof portfolioId === 'number' && RESERVED_POOL_IDS.has(portfolioId);
}

/**
 * Community Pool contract address on Cronos Testnet (legacy/deprecated).
 * For chain-specific addresses, use getCommunityPoolAddress(chain, network)
 * from lib/contracts/community-pool-config.ts instead.
 */
export const COMMUNITY_POOL_ADDRESS = '0xC25A8D76DDf946C376c9004F5192C7b2c27D5d30';

export const SUI_COMMUNITY_POOL_STATE = '0xb9b9c58c8c023723f631455c95c21ad3d3b00ba0fef91e42a90c9f648fa68f56';

export function isSuiCommunityPool(poolId: string | number | null | undefined): boolean {
  return poolId === SUI_COMMUNITY_POOL_PORTFOLIO_ID || poolId === 'sui-usdc-pool';
}

/**
 * Map a chain identifier to its reserved community-pool portfolio ID.
 * Single source of truth for chain → sentinel routing so a future
 * per-chain cron never accidentally writes with the wrong pool ID.
 *
 * Unknown chains fall back to the legacy EVM pool (-1) so callers that
 * predate a chain launch don't crash. Add the mapping here before
 * enabling a new chain's cron.
 */
export function chainToPortfolioId(chain: string | null | undefined): number {
  switch ((chain ?? '').toLowerCase()) {
    case 'sui':
      return SUI_COMMUNITY_POOL_PORTFOLIO_ID;
    case 'hedera':
      return HEDERA_COMMUNITY_POOL_PORTFOLIO_ID;
    case 'sepolia':
      return SEPOLIA_COMMUNITY_POOL_PORTFOLIO_ID;
    case 'cronos':
    case 'cronos-testnet':
    case 'cronos-mainnet':
    default:
      return COMMUNITY_POOL_PORTFOLIO_ID;
  }
}
